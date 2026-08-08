import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import { isNotFoundOnAllBackends, TransactionAlreadySubmittedError } from '../../utils/errors';
import {
  registerBlockIndexedListener,
  unregisterBlockIndexedListener,
  registerReorgListener,
  unregisterReorgListener,
  type BlockIndexedEvent,
  type ReorgEvent,
} from '../crawler/hooks';
import {
  JOB_ERROR_CODES,
  bumpWalletStats,
  clearConfirmationPoint,
  markConfirmed,
  markFailed,
  recordConfirmationPoint,
} from './job-store';

const logger = cds.log('CardanoWalletWorker');

/**
 * Confirmation tracker (v2.0, design §7).
 *
 * Watches `submitted` jobs until their tx sits at depth ≥ `confirmationDepth`:
 *  - Crawler hook (preferred, zero extra load): `blockIndexed` events match
 *    submitted tx hashes and carry the advancing tip; `reorg` events invalidate
 *    confirmation points behind the fork and optionally re-submit the SAME
 *    signed CBOR (never a rebuild — the double-spend guard).
 *  - Polling fallback (always on, hook path just accelerates): every
 *    `pollIntervalMs` unfound txs are looked up via `client.getTransaction`
 *    and the tip via `client.getLatestBlock`.
 *
 * A tx that stays unseen past `confirmationTimeoutMs` fails as TX_DROPPED —
 * safe to retry from the caller, because the guard is the on-chain lookup itself.
 *
 * Confirmations are counted as `tipHeight - foundHeight + 1`, so depth 1 means
 * "confirmed as soon as included in a block".
 */

export interface TrackedJob {
  jobId: string;
  walletId: string;
  txHash: string;
  signedTxCbor: string | null;
  /** ISO timestamp of mempool acceptance (timeout base). */
  submittedAt: string;
  foundSlot: number | null;
  foundHeight: number | null;
}

export interface ConfirmationTrackerOptions {
  confirmationDepth: number;
  confirmationTimeoutMs: number;
  pollIntervalMs: number;
  resubmitOnRollback: boolean;
}

export interface ConfirmationTrackerDeps {
  client: CardanoClient;
  options: ConfirmationTrackerOptions;
  /** Called exactly once per job when it reaches a terminal state. */
  onFinal?: (job: { jobId: string; walletId: string; outcome: 'confirmed' | 'failed' }) => void;
}

export class ConfirmationTracker {
  private readonly pending = new Map<string, TrackedJob>();
  private readonly blockListener = (event: BlockIndexedEvent) => this.onBlockIndexed(event);
  private readonly reorgListener = (event: ReorgEvent) => { void this.onReorg(event); };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private lastKnownTipHeight: number | null = null;

  constructor(private readonly deps: ConfirmationTrackerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    registerBlockIndexedListener(this.blockListener);
    registerReorgListener(this.reorgListener);
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, this.deps.options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    unregisterBlockIndexedListener(this.blockListener);
    unregisterReorgListener(this.reorgListener);
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.pending.clear();
  }

  /** Number of jobs currently awaiting confirmation. */
  size(): number {
    return this.pending.size;
  }

  /** Register a submitted job for confirmation watching. Idempotent per jobId. */
  track(job: { jobId: string; walletId: string; txHash: string; signedTxCbor: string | null; submittedAt?: string | null; confirmedSlot?: number | null; confirmedHeight?: number | null }): void {
    if (this.pending.has(job.jobId)) return;
    this.pending.set(job.jobId, {
      jobId: job.jobId,
      walletId: job.walletId,
      txHash: job.txHash,
      signedTxCbor: job.signedTxCbor,
      submittedAt: job.submittedAt ?? new Date().toISOString(),
      foundSlot: job.confirmedSlot ?? null,
      foundHeight: job.confirmedHeight ?? null,
    });
  }

  // ---- Crawler hook path -----------------------------------------------------

  private onBlockIndexed(event: BlockIndexedEvent): void {
    if (!this.running || this.pending.size === 0) return;
    const tipHeight = event.tipHeight ?? event.height;
    if (tipHeight != null) {
      this.lastKnownTipHeight = Math.max(this.lastKnownTipHeight ?? 0, tipHeight);
    }
    const txHashes = new Set(event.txHashes);
    const found = [...this.pending.values()].filter(j => j.foundHeight == null && txHashes.has(j.txHash));
    // Persist + depth-check detached: hook callers (the crawler) must not await us.
    void (async () => {
      for (const job of found) {
        job.foundSlot = event.slot;
        job.foundHeight = event.height;
        try {
          await cds.tx((tx) => recordConfirmationPoint(tx, job.jobId, { slot: event.slot, height: event.height }));
          logger.info(`Job ${job.jobId}: tx ${job.txHash} included in block ${event.hash} (height ${event.height})`);
        } catch (err) {
          logger.warn(`Job ${job.jobId}: failed to persist confirmation point (will retry via polling):`, err);
        }
      }
      await this.confirmMature();
    })();
  }

  private async onReorg(event: ReorgEvent): Promise<void> {
    if (!this.running) return;
    // The pre-fork tip no longer exists — clamp (or drop) lastKnownTipHeight so
    // confirmations are never counted against it. Without this, a tx re-included
    // on the new chain would reach "depth" instantly via the stale tip height,
    // defeating the confirmation-depth guarantee exactly in the rollback case.
    if (event.forkHeight != null) {
      if (this.lastKnownTipHeight != null && this.lastKnownTipHeight > event.forkHeight) {
        this.lastKnownTipHeight = event.forkHeight;
      }
    } else {
      this.lastKnownTipHeight = null; // unknown fork height → re-learn from the next block/poll
    }
    for (const job of this.pending.values()) {
      if (job.foundSlot != null && job.foundSlot > event.forkSlot) {
        logger.warn(`Job ${job.jobId}: confirmation point (slot ${job.foundSlot}) rolled back past fork ${event.forkSlot} — re-watching`);
        job.foundSlot = null;
        job.foundHeight = null;
        try {
          await cds.tx((tx) => clearConfirmationPoint(tx, job.jobId));
        } catch (err) {
          logger.warn(`Job ${job.jobId}: failed to clear confirmation point:`, err);
        }
        if (this.deps.options.resubmitOnRollback && job.signedTxCbor) {
          // SAME signed CBOR only — never a rebuild. "Already known" means the tx
          // survived into the new chain's mempool; that is success, not an error.
          try {
            await this.deps.client.submitTransaction(job.signedTxCbor);
            logger.info(`Job ${job.jobId}: re-submitted original signed tx after rollback`);
          } catch (err) {
            if (err instanceof TransactionAlreadySubmittedError) {
              logger.debug(`Job ${job.jobId}: tx already known after rollback — nothing to do`);
            } else {
              logger.warn(`Job ${job.jobId}: rollback re-submit failed (polling continues to watch):`, err);
            }
          }
        }
      }
    }
  }

  // ---- Polling path ------------------------------------------------------------

  /** One polling round. Public for tests; guarded against overlapping rounds. */
  async pollOnce(): Promise<void> {
    if (!this.running || this.polling || this.pending.size === 0) return;
    this.polling = true;
    try {
      // Tip first — also serves the depth check for hook-found entries when the
      // crawler is off.
      try {
        const tip = await this.deps.client.getLatestBlock();
        if (tip.height != null) {
          this.lastKnownTipHeight = Math.max(this.lastKnownTipHeight ?? 0, tip.height);
        }
      } catch (err) {
        logger.debug('Confirmation polling: tip lookup failed (skipping round):', err);
        return;
      }

      for (const job of [...this.pending.values()]) {
        if (job.foundHeight != null) continue;
        try {
          const tx = await this.deps.client.getTransaction(job.txHash);
          job.foundSlot = tx.slot ?? null;
          job.foundHeight = tx.blockHeight ?? null;
          await cds.tx((t) => recordConfirmationPoint(t, job.jobId, { slot: job.foundSlot, height: job.foundHeight }));
          logger.info(`Job ${job.jobId}: tx ${job.txHash} found on-chain at height ${job.foundHeight} (polling)`);
        } catch (err) {
          // The client's failover wraps per-backend 404s into AllBackendsFailedError,
          // so a plain `instanceof NotFoundError` check never fires — the helper also
          // accepts "every consulted backend said 404" as proof of absence.
          if (isNotFoundOnAllBackends(err)) {
            // Not on-chain yet — check the mempool-TTL timeout.
            const age = Date.now() - Date.parse(job.submittedAt);
            if (age > this.deps.options.confirmationTimeoutMs) {
              await this.finalize(job, 'failed', JOB_ERROR_CODES.TX_DROPPED,
                new Error(`Transaction ${job.txHash} not seen on-chain within ${this.deps.options.confirmationTimeoutMs}ms of submission`));
            }
          } else {
            logger.debug(`Job ${job.jobId}: confirmation lookup failed (transient, next round retries):`, err);
          }
        }
      }

      await this.confirmMature();
    } finally {
      this.polling = false;
    }
  }

  // ---- Shared -----------------------------------------------------------------

  /** Confirm every found job whose depth requirement is met by the known tip. */
  private async confirmMature(): Promise<void> {
    const tip = this.lastKnownTipHeight;
    if (tip == null) return;
    for (const job of [...this.pending.values()]) {
      if (job.foundHeight == null) continue;
      const confirmations = tip - job.foundHeight + 1;
      if (confirmations >= this.deps.options.confirmationDepth) {
        await this.finalize(job, 'confirmed');
      }
    }
  }

  private async finalize(job: TrackedJob, outcome: 'confirmed' | 'failed', errorCode?: string, err?: unknown): Promise<void> {
    try {
      await cds.tx(async (tx) => {
        const transitioned = outcome === 'confirmed'
          ? await markConfirmed(tx, job.jobId)
          : await markFailed(tx, job.jobId, errorCode ?? 'FAILED', err ?? new Error('unknown'));
        if (transitioned) {
          await bumpWalletStats(tx, job.walletId, outcome);
        }
      });
    } catch (persistErr) {
      logger.error(`Job ${job.jobId}: failed to persist terminal state ${outcome} (next round retries):`, persistErr);
      return; // keep tracking — the next poll round retries the transition
    }
    this.pending.delete(job.jobId);
    logger.info(`Job ${job.jobId}: ${outcome}${outcome === 'failed' ? ` (${errorCode})` : ''}`);
    this.deps.onFinal?.({ jobId: job.jobId, walletId: job.walletId, outcome });
  }
}
