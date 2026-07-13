import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import { CardanoCrawler, type CrawlerConfig } from './crawler';
import { isCrawlerLeaseActive, readCursor, setCrawlerDesiredRunning } from './sync-state';

const logger = cds.log('CardanoCrawler');

/**
 * Module-level singleton lifecycle for the chain crawler. Mirrors NIGHTGATE's
 * srv/crawler/index.ts: one active crawler per process, started fire-and-forget from
 * the server's `served` hook and controlled (pause/resume/status) via the indexer service.
 */

let active: CardanoCrawler | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();
let standbyDeps: StartCrawlerDeps | null = null;
let standbyTimer: ReturnType<typeof setTimeout> | null = null;
let standbyGeneration = 0;

const STANDBY_RETRY_MS = 5_000;

export interface StartCrawlerDeps {
  client: CardanoClient;
  indexer: CardanoIndexer;
  network: string;
  config: CrawlerConfig;
}

/**
 * Start the crawler (idempotent — a no-op if one is already running). Fire-and-forget:
 * returns once the ingest pipeline is launched, not when catch-up completes.
 */
export async function startCrawler(deps: StartCrawlerDeps, resumeCluster = false): Promise<void> {
  const generation = ++standbyGeneration;
  standbyDeps = deps;
  if (standbyTimer) { clearTimeout(standbyTimer); standbyTimer = null; }
  scheduleStandby(generation);
  return startCrawlerAttempt(deps, resumeCluster, generation);
}

async function startCrawlerAttempt(deps: StartCrawlerDeps, resumeCluster: boolean, generation: number): Promise<void> {
  return serializeLifecycle(async () => {
    if (generation !== standbyGeneration) return;
    if (resumeCluster) {
      await cds.tx((tx) => setCrawlerDesiredRunning(tx, true));
    }
    if (active?.isRunning()) {
      logger.debug('startCrawler: already running');
      return;
    }
    if (active) {
      const previous = active;
      await previous.stop();
      if (active === previous) active = null;
    }

    const candidate = new CardanoCrawler(
      deps.client,
      deps.indexer,
      deps.network,
      deps.config,
      `${process.pid}:${randomUUID()}`,
    );
    active = candidate;
    try {
      await candidate.start();
    } catch (err) {
      if (active === candidate) active = null;
      throw err;
    }
    // A lease loser stays in standby, not as a misleading process-local singleton.
    if (!candidate.isRunning() && active === candidate) active = null;
  });
}

/**
 * Stop the local crawler. `pauseCluster=true` additionally fences every instance via
 * shared DB intent; ordinary app shutdown leaves the desired state intact for failover.
 */
export async function stopCrawler(pauseCluster = false): Promise<void> {
  ++standbyGeneration; // invalidate callbacks that already left the timer queue
  standbyDeps = null;
  if (standbyTimer) { clearTimeout(standbyTimer); standbyTimer = null; }
  return serializeLifecycle(async () => {
    if (pauseCluster) {
      await cds.tx((tx) => setCrawlerDesiredRunning(tx, false));
    }
    const crawler = active;
    if (!crawler) return;
    await crawler.stop();
    // A queued/re-entrant start can never be erased by an older stop continuation.
    if (active === crawler) active = null;
  });
}

/** Whether a crawler is currently running. */
export function isCrawlerRunning(): boolean {
  return active?.isRunning() ?? false;
}

/** The active crawler instance, or null. */
export function getCrawler(): CardanoCrawler | null {
  return active;
}

/** Read the lease in a fresh transaction (control actions must not use a stale request snapshot). */
export async function isCrawlerRunningInCluster(): Promise<boolean> {
  const cursor = await cds.tx((tx) => readCursor(tx));
  return isCrawlerLeaseActive(cursor);
}

function serializeLifecycle(operation: () => Promise<void>): Promise<void> {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.catch(() => undefined);
  return result;
}

/** Keep non-leader instances warm so an expired/released lease fails over automatically. */
function scheduleStandby(generation: number): void {
  if (standbyTimer || !standbyDeps) return;
  standbyTimer = setTimeout(() => {
    standbyTimer = null;
    if (generation !== standbyGeneration) return;
    const deps = standbyDeps;
    if (!deps) return;
    void startCrawlerAttempt(deps, false, generation)
      .catch((err) => logger.error('standby lease attempt failed:', err))
      .finally(() => {
        if (generation === standbyGeneration) scheduleStandby(generation);
      });
  }, STANDBY_RETRY_MS);
  standbyTimer.unref?.();
}
