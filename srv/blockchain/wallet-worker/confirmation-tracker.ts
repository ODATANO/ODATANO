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
  /** Job kind, carried so terminal events can name it without a DB read. */
  kind: string | null;
  txHash: string;
  signedTxCbor: string | null;
  /** ISO timestamp of mempool acceptance (timeout base). */
  submittedAt: string;
  foundSlot: number | null;
  foundHeight: number | null;
  /**
   * Polling round in which the tx was last SEEN on-chain (found or
   * re-validated). A job found in the current round needs no second lookup
   * before it is confirmed; one found in an earlier round is re-checked, so a
   * rollback the crawler did not report (crawler off) cannot slip through.
   */
  seenRound?: number;
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
  onFinal?: (job: {
    jobId: string;
    walletId: string;
    outcome: 'confirmed' | 'failed';
    kind: string | null;
    /** The tracked transaction — present even on failure (it was submitted). */
    txHash: string;
    errorCode?: string;
    errorMessage?: string;
  }) => void;
}

export class ConfirmationTracker {
  private readonly pending = new Map<string, TrackedJob>();
  private readonly blockListener = (event: BlockIndexedEvent) => this.onBlockIndexed(event);
  private readonly reorgListener = (event: ReorgEvent) => { void this.onReorg(event); };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private lastKnownTipHeight: number | null = null;
  /** Polling round counter; see TrackedJob.seenRound. */
  private round = 0;

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
  track(job: { jobId: string; walletId: string; kind?: string | null; txHash: string; signedTxCbor: string | null; submittedAt?: string | null; confirmedSlot?: number | null; confirmedHeight?: number | null }): void {
    if (this.pending.has(job.jobId)) return;
    this.pending.set(job.jobId, {
      jobId: job.jobId,
      walletId: job.walletId,
      kind: job.kind ?? null,
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
        await this.forgetInclusion(job);
      }
    }
  }

  /**
   * The recorded inclusion is gone (a reorg the crawler reported, or a polling
   * re-check that no longer finds the tx): back to watching, and optionally
   * re-submit the SAME signed CBOR — never a rebuild, that is the double-spend
   * guard. "Already known" means the tx survived into the new chain's mempool;
   * that is success, not an error.
   */
  private async forgetInclusion(job: TrackedJob): Promise<void> {
    job.foundSlot = null;
    job.foundHeight = null;
    job.seenRound = undefined;
    try {
      await cds.tx((tx) => clearConfirmationPoint(tx, job.jobId));
    } catch (err) {
      logger.warn(`Job ${job.jobId}: failed to clear confirmation point:`, err);
    }
    if (this.deps.options.resubmitOnRollback && job.signedTxCbor) {
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

  // ---- Polling path ------------------------------------------------------------

  /** One polling round. Public for tests; guarded against overlapping rounds. */
  async pollOnce(): Promise<void> {
    if (!this.running || this.polling || this.pending.size === 0) return;
    this.polling = true;
    this.round++;
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
          job.seenRound = this.round;
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

      // Polling has no reorg signal, so an inclusion recorded in an EARLIER
      // round is re-checked before it counts (see stillIncluded).
      await this.confirmMature(true);
    } finally {
      this.polling = false;
    }
  }

  // ---- Shared -----------------------------------------------------------------

  /**
   * Confirm every found job whose depth requirement is met by the known tip.
   * `revalidate` (polling path): an inclusion not seen in THIS round is looked
   * up again first — the crawler's reorg events are the only rollback signal,
   * and with the crawler off there is none, so a tx that was found at height N
   * and then rolled back would otherwise be confirmed on the tip alone.
   */
  private async confirmMature(revalidate = false): Promise<void> {
    const tip = this.lastKnownTipHeight;
    if (tip == null) return;
    for (const job of [...this.pending.values()]) {
      if (job.foundHeight == null) continue;
      if (tip - job.foundHeight + 1 < this.deps.options.confirmationDepth) continue;
      if (revalidate && job.seenRound !== this.round && !(await this.stillIncluded(job, tip))) continue;
      await this.finalize(job, 'confirmed');
    }
  }

  /**
   * Is the tx still on-chain, and still deep enough? Re-reads it; a tx that
   * moved to another block (re-included after a rollback) gets its new point
   * and is judged at the new height; one that is gone is forgotten (back to
   * watching, optional same-CBOR re-submit) and the tip is re-learned next
   * round, because the pre-rollback tip may overstate the depth.
   */
  private async stillIncluded(job: TrackedJob, tip: number): Promise<boolean> {
    try {
      const tx = await this.deps.client.getTransaction(job.txHash);
      const height = tx.blockHeight ?? null;
      job.seenRound = this.round;
      if (height != null && height !== job.foundHeight) {
        logger.warn(`Job ${job.jobId}: tx ${job.txHash} moved from height ${job.foundHeight} to ${height} — re-anchoring`);
        job.foundHeight = height;
        job.foundSlot = tx.slot ?? null;
        await cds.tx((t) => recordConfirmationPoint(t, job.jobId, { slot: job.foundSlot, height: job.foundHeight }));
        return tip - height + 1 >= this.deps.options.confirmationDepth;
      }
      return true;
    } catch (err) {
      if (isNotFoundOnAllBackends(err)) {
        logger.warn(`Job ${job.jobId}: tx ${job.txHash} no longer on-chain (was at height ${job.foundHeight}) — rollback without a crawler signal, re-watching`);
        this.lastKnownTipHeight = null;
        await this.forgetInclusion(job);
        return false;
      }
      logger.debug(`Job ${job.jobId}: inclusion re-check failed (transient, next round retries):`, err);
      return false;
    }
  }

  private async finalize(job: TrackedJob, outcome: 'confirmed' | 'failed', errorCode?: string, err?: unknown): Promise<void> {
    let transitioned = false;
    try {
      await cds.tx(async (tx) => {
        transitioned = outcome === 'confirmed'
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
    if (!transitioned) {
      // Somebody else (another tracker instance, a reconciliation pass, a
      // cancel) reached the terminal state first. The job is done either way,
      // but the stats bump and the terminal event belong to the winner only.
      logger.debug(`Job ${job.jobId}: ${outcome} transition already applied elsewhere — no event from this tracker`);
      return;
    }
    logger.info(`Job ${job.jobId}: ${outcome}${outcome === 'failed' ? ` (${errorCode})` : ''}`);
    this.deps.onFinal?.({
      jobId: job.jobId,
      walletId: job.walletId,
      outcome,
      kind: job.kind,
      txHash: job.txHash,
      errorCode,
      errorMessage: err instanceof Error ? err.message : err != null ? String(err) : undefined,
    });
  }
}
