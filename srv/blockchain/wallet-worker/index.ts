import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { CardanoWalletWorker, type WalletWorkerConfig, type WalletWorkerDeps } from './wallet-worker';

const logger = cds.log('CardanoWalletWorker');

/**
 * Module-level singleton lifecycle for the wallet worker. Mirrors the crawler's
 * srv/blockchain/crawler/index.ts: one active worker per process, started
 * fire-and-forget from the server's `served` hook and controlled (pause/resume/
 * status) via the worker control service.
 *
 * Unlike the crawler there is no standby machinery: every instance may run a
 * dispatch loop — the per-WALLET DB leases decide which instance executes a
 * given wallet's jobs, so failover is inherent.
 */

let active: CardanoWalletWorker | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();

export type StartWalletWorkerDeps = Omit<WalletWorkerDeps, 'instanceId'> & { instanceId?: string };
export type { WalletWorkerConfig };

/** Start the worker (idempotent — a no-op when one is already running). */
export async function startWalletWorker(deps: StartWalletWorkerDeps): Promise<void> {
  return serializeLifecycle(async () => {
    if (active?.isRunning()) {
      logger.debug('startWalletWorker: already running');
      return;
    }
    if (active) {
      const previous = active;
      await previous.stop();
      if (active === previous) active = null;
    }
    const candidate = new CardanoWalletWorker({
      ...deps,
      instanceId: deps.instanceId ?? `${process.pid}:${randomUUID()}`,
    });
    active = candidate;
    try {
      await candidate.start();
    } catch (err) {
      if (active === candidate) active = null;
      throw err;
    }
    if (!candidate.isRunning() && active === candidate) active = null;
  });
}

/** Stop the local worker (in-flight execution steps are awaited). */
export async function stopWalletWorker(): Promise<void> {
  return serializeLifecycle(async () => {
    const worker = active;
    if (!worker) return;
    await worker.stop();
    if (active === worker) active = null;
  });
}

/** Whether a worker is currently running in this process. */
export function isWalletWorkerRunning(): boolean {
  return active?.isRunning() ?? false;
}

/** The active worker instance, or null. */
export function getWalletWorker(): CardanoWalletWorker | null {
  return active;
}

function serializeLifecycle(operation: () => Promise<void>): Promise<void> {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.catch(() => undefined);
  return result;
}
