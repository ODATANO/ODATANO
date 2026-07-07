import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import { CardanoCrawler, type CrawlerConfig } from './crawler';

const logger = cds.log('CardanoCrawler');

/**
 * Module-level singleton lifecycle for the chain crawler. Mirrors NIGHTGATE's
 * srv/crawler/index.ts: one active crawler per process, started fire-and-forget from
 * the server's `served` hook and controlled (pause/resume/status) via the indexer service.
 */

let active: CardanoCrawler | null = null;

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
export async function startCrawler(deps: StartCrawlerDeps): Promise<void> {
  if (active?.isRunning()) {
    logger.debug('startCrawler: already running');
    return;
  }
  active = new CardanoCrawler(deps.client, deps.indexer, deps.network, deps.config);
  await active.start();
}

/** Stop the active crawler (if any) and clear the singleton. */
export async function stopCrawler(): Promise<void> {
  if (active) {
    await active.stop();
    active = null;
  }
}

/** Whether a crawler is currently running. */
export function isCrawlerRunning(): boolean {
  return active?.isRunning() ?? false;
}

/** The active crawler instance, or null. */
export function getCrawler(): CardanoCrawler | null {
  return active;
}
