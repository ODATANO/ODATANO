import cds from '@sap/cds';
import { TransactionSubmissions } from '#cds-models/odatano/cardano';
import type { CardanoClient } from '../cardano-client';
import { isNotFoundOnAllBackends, TransactionAlreadySubmittedError } from '../../utils/errors';
import { runWithoutAmbientTx } from '../../utils/tx-utils';
import { hasUnspentOutput, isExpired, judgeLanding, landingFacts, type LandingIndexer } from '../signing/landing-proof';
import { findOnChain } from '../transaction-presence';
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
  markFailedAfterSend,
  markUnresolved,
  recordConfirmationPoint,
} from './job-store';

const { UPDATE } = cds.ql;
const logger = cds.log('CardanoWalletWorker');

/** A job overdue for confirmation has the chain read for it at most this often. */
const LANDING_CHECK_INTERVAL_MS = 60_000;
/** First and longest wait before the stored bytes of an overdue job are sent again. */
const RESEND_BACKOFF_MIN_MS = 60_000;
const RESEND_BACKOFF_MAX_MS = 30 * 60_000;

// Watches submitted jobs until their tx reaches confirmationDepth, via crawler hooks and polling.
// A reorg re-submits the same signed CBOR, never a rebuild. Depth 1 means included in a block.
// A job fails only on proof; past the last moment it could land without proof it is unresolved.

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
  /** Polling round that last saw the tx. Older inclusions are re-checked to catch unreported rollbacks. */
  seenRound?: number;
  /** Epoch ms before which an overdue job has no chain read. */
  nextLandingCheckAt?: number;
  /** Epoch ms before which an overdue job is not sent again, and how often it was. */
  nextResendAt?: number;
  resends?: number;
}

/** Where a polling lookup found the transaction. */
type Located = { slot: number | null; height: number | null; scriptFailed: boolean };

export interface ConfirmationTrackerOptions {
  confirmationDepth: number;
  confirmationTimeoutMs: number;
  pollIntervalMs: number;
  resubmitOnRollback: boolean;
}

export interface ConfirmationTrackerDeps {
  client: CardanoClient;
  /** The local index, read before any backend. */
  indexer: LandingIndexer;
  options: ConfirmationTrackerOptions;
  /** Called exactly once per job when it reaches a terminal state. */
  onFinal?: (job: {
    jobId: string;
    walletId: string;
    outcome: 'confirmed' | 'failed' | 'unresolved';
    kind: string | null;
    /** Set even on failure, since the tx was submitted. */
    txHash: string;
    errorCode?: string;
    errorMessage?: string;
  }) => void;
  /** Called when a job's transaction has no expiry, has not landed and still can through these inputs. */
  onStale?: (job: { jobId: string; walletId: string }, unspentInputs: Array<{ txHash: string; outputIndex: number }>) => void;
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

  /** Stops watching a job another path finalized. */
  untrack(jobId: string): void {
    this.pending.delete(jobId);
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
    // Detached: hook callers (the crawler) must not await us.
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
    // Clamp (or drop) the stale pre-fork tip, otherwise a tx re-included on the new
    // chain would reach depth instantly against it.
    if (event.forkHeight != null) {
      if (this.lastKnownTipHeight != null && this.lastKnownTipHeight > event.forkHeight) {
        this.lastKnownTipHeight = event.forkHeight;
      }
    } else {
      this.lastKnownTipHeight = null; // re-learn from the next block/poll
    }
    for (const job of this.pending.values()) {
      if (job.foundSlot != null && job.foundSlot > event.forkSlot) {
        logger.warn(`Job ${job.jobId}: confirmation point (slot ${job.foundSlot}) rolled back past fork ${event.forkSlot}, re-watching`);
        await this.forgetInclusion(job);
      }
    }
  }

  /** Back to watching. After a rollback it re-submits the same signed CBOR, never a rebuild, to avoid a double spend. */
  private async forgetInclusion(job: TrackedJob, resubmit = true): Promise<void> {
    job.foundSlot = null;
    job.foundHeight = null;
    job.seenRound = undefined;
    try {
      await cds.tx((tx) => clearConfirmationPoint(tx, job.jobId));
    } catch (err) {
      logger.warn(`Job ${job.jobId}: failed to clear confirmation point:`, err);
    }
    if (resubmit && this.deps.options.resubmitOnRollback && job.signedTxCbor && !isExpired(job.signedTxCbor, this.deps.client.network)) {
      try {
        await this.deps.client.submitTransaction(job.signedTxCbor);
        logger.info(`Job ${job.jobId}: re-submitted original signed tx after rollback`);
      } catch (err) {
        if (err instanceof TransactionAlreadySubmittedError) {
          logger.debug(`Job ${job.jobId}: tx already known after rollback, nothing to do`);
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
      // Tip first. It is also the depth check for hook-found entries when the crawler is off.
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
        let found: Located | null;
        try {
          found = await this.locate(job);
        } catch (err) {
          logger.debug(`Job ${job.jobId}: confirmation lookup failed (transient, next round retries):`, err);
          continue;
        }
        if (found?.scriptFailed) {
          await this.finalize(job, 'failed', JOB_ERROR_CODES.SCRIPT_FAILED,
            new Error(`Transaction ${job.txHash} is on chain with failing scripts: only its collateral was spent`));
          continue;
        }
        if (found && found.height != null) {
          job.foundSlot = found.slot;
          job.foundHeight = found.height;
          job.seenRound = this.round;
          await cds.tx((t) => recordConfirmationPoint(t, job.jobId, { slot: job.foundSlot, height: job.foundHeight }));
          logger.info(`Job ${job.jobId}: tx ${job.txHash} found on-chain at height ${job.foundHeight} (polling)`);
          continue;
        }
        if (Date.now() - Date.parse(job.submittedAt) > this.deps.options.confirmationTimeoutMs && job.signedTxCbor) {
          await this.settleOverdue(job, job.signedTxCbor);
        }
      }

      // Polling has no reorg signal: inclusions from an earlier round are re-checked first.
      await this.confirmMature(true);
    } finally {
      this.polling = false;
    }
  }

  // Unseen past the timeout: proof that it can never land fails the job, time alone proves nothing.
  // While it stays open the same bytes go out again: a node may have dropped them from its mempool.
  private async settleOverdue(job: TrackedJob, signedTxCbor: string): Promise<void> {
    const now = Date.now();
    if (now < (job.nextLandingCheckAt ?? 0)) return;
    job.nextLandingCheckAt = now + LANDING_CHECK_INTERVAL_MS;
    const sentAtMs = Date.parse(job.submittedAt);
    const landing = await runWithoutAmbientTx(() => judgeLanding(signedTxCbor, job.txHash, this.deps, Number.isFinite(sentAtMs) ? sentAtMs : null));
    if (landing.verdict === 'neverLands') {
      await this.finalize(job, 'failed', JOB_ERROR_CODES.TX_DROPPED, new Error(landing.reason));
      return;
    }
    if (landing.verdict === 'scriptFailed') {
      await this.finalize(job, 'failed', JOB_ERROR_CODES.SCRIPT_FAILED, new Error(landing.reason));
      return;
    }
    if (landing.verdict === 'unresolved') {
      await this.finalize(job, 'unresolved', JOB_ERROR_CODES.OUTCOME_UNRESOLVED, new Error(landing.reason));
      return;
    }
    // no expiry and still able to land: the worker spends one of its inputs, no resend
    if (landing.verdict === 'stale') {
      this.deps.onStale?.({ jobId: job.jobId, walletId: job.walletId }, landing.unspentInputs);
      return;
    }
    // expired bytes are refused by every node, sending them again only costs requests
    if (landing.verdict !== 'open' || now < (job.nextResendAt ?? 0) || isExpired(signedTxCbor, this.deps.client.network)) return;
    job.resends = (job.resends ?? 0) + 1;
    job.nextResendAt = now + Math.min(RESEND_BACKOFF_MIN_MS * 2 ** (job.resends - 1), RESEND_BACKOFF_MAX_MS);
    try {
      await this.deps.client.submitTransaction(signedTxCbor);
      logger.info(`Job ${job.jobId}: tx ${job.txHash} still unseen, sent its signed bytes again`);
    } catch (err) {
      if (!(err instanceof TransactionAlreadySubmittedError)) {
        logger.debug(`Job ${job.jobId}: resend of tx ${job.txHash} was refused (the chain still decides):`, err);
      }
    }
  }

  // ---- Shared -----------------------------------------------------------------

  // Where the transaction is: the crawled chain first, then a backend lookup. Without a transaction
  // lookup an unspent output shows it on chain; its height is then taken as the tip, never deeper.
  // Null when it is not on chain. Throws when a lookup gives no answer.
  private async locate(job: TrackedJob): Promise<Located | null> {
    const presence = await findOnChain(this.deps.indexer, this.deps.client, job.txHash);
    if (presence) return presence;
    if (presence === null) return null;
    // only an own output seen unspent shows it on chain; spent inputs prove nothing about who spent them
    if (job.signedTxCbor && this.lastKnownTipHeight != null && await hasUnspentOutput(job.signedTxCbor, job.txHash, this.deps.client)) {
      return { slot: null, height: this.lastKnownTipHeight, scriptFailed: false };
    }
    return null;
  }

  // Without a transaction lookup, after an own output was seen. included: an own output is unspent.
  // rolledBack: an input is unspent again. unknown: everything is spent, by whom shows nowhere.
  private async stillOnLedger(signedTxCbor: string, txHash: string): Promise<'included' | 'rolledBack' | 'unknown'> {
    if (await hasUnspentOutput(signedTxCbor, txHash, this.deps.client)) return 'included';
    for (const input of landingFacts(signedTxCbor).inputs) {
      if (await this.deps.client.isUtxoUnspent(input.txHash, input.outputIndex)) return 'rolledBack';
    }
    return 'unknown';
  }

  /** Confirms found jobs deep enough. With revalidate, an inclusion not seen this round is looked up again. */
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

  /** True if the tx is still on-chain and deep enough. A moved tx takes its new height, a vanished one is watched again. */
  private async stillIncluded(job: TrackedJob, tip: number): Promise<boolean> {
    if (!this.deps.client.supports('getTransaction')) {
      if (!job.signedTxCbor) return true;
      let state: 'included' | 'rolledBack' | 'unknown';
      try {
        state = await this.stillOnLedger(job.signedTxCbor, job.txHash);
      } catch (err) {
        logger.debug(`Job ${job.jobId}: inclusion re-check failed (transient, next round retries):`, err);
        return false;
      }
      job.seenRound = this.round;
      if (state === 'included') return true;
      if (state === 'rolledBack') {
        logger.warn(`Job ${job.jobId}: an input of tx ${job.txHash} is unspent again (was at height ${job.foundHeight}). Rollback without a crawler signal, re-watching`);
        this.lastKnownTipHeight = null;
        await this.forgetInclusion(job);
        return false;
      }
      // its outputs and inputs are all spent: no evidence left that this transaction spent them
      logger.warn(`Job ${job.jobId}: every output and input of tx ${job.txHash} is spent before the confirmation depth; nothing shows it is still included, waiting for the chain to decide`);
      await this.forgetInclusion(job, false);
      return false;
    }
    try {
      const tx = await this.deps.client.getTransaction(job.txHash);
      const height = tx.blockHeight ?? null;
      job.seenRound = this.round;
      if (tx.spendsCollaterals === true) {
        await this.finalize(job, 'failed', JOB_ERROR_CODES.SCRIPT_FAILED,
          new Error(`Transaction ${job.txHash} is on chain with failing scripts: only its collateral was spent`));
        return false;
      }
      if (height != null && height !== job.foundHeight) {
        logger.warn(`Job ${job.jobId}: tx ${job.txHash} moved from height ${job.foundHeight} to ${height}, re-anchoring`);
        job.foundHeight = height;
        job.foundSlot = tx.slot ?? null;
        await cds.tx((t) => recordConfirmationPoint(t, job.jobId, { slot: job.foundSlot, height: job.foundHeight }));
        return tip - height + 1 >= this.deps.options.confirmationDepth;
      }
      return true;
    } catch (err) {
      if (isNotFoundOnAllBackends(err)) {
        logger.warn(`Job ${job.jobId}: tx ${job.txHash} no longer on-chain (was at height ${job.foundHeight}). Rollback without a crawler signal, re-watching`);
        this.lastKnownTipHeight = null;
        await this.forgetInclusion(job);
        return false;
      }
      logger.debug(`Job ${job.jobId}: inclusion re-check failed (transient, next round retries):`, err);
      return false;
    }
  }

  private async finalize(job: TrackedJob, outcome: 'confirmed' | 'failed' | 'unresolved', errorCode?: string, err?: unknown): Promise<void> {
    let transitioned = false;
    try {
      await cds.tx(async (tx) => {
        if (outcome === 'unresolved') {
          transitioned = await markUnresolved(tx, job.jobId, err ?? new Error('unresolved'));
          if (transitioned) await tx.run(UPDATE.entity(TransactionSubmissions).set({ status: 'unresolved' }).where({ txHash: job.txHash, status: 'submitted' }));
          return;
        }
        transitioned = outcome === 'confirmed'
          ? await markConfirmed(tx, job.jobId)
          : await markFailedAfterSend(tx, job.jobId, errorCode ?? 'FAILED', err ?? new Error('unknown'));
        if (transitioned) {
          await bumpWalletStats(tx, job.walletId, outcome);
          // the job's submission record follows its outcome
          await tx.run(UPDATE.entity(TransactionSubmissions).set({ status: outcome }).where({ txHash: job.txHash, status: 'submitted' }));
        }
      });
    } catch (persistErr) {
      logger.error(`Job ${job.jobId}: failed to persist terminal state ${outcome} (next round retries):`, persistErr);
      return; // keep tracking, the next round retries
    }
    this.pending.delete(job.jobId);
    if (!transitioned) {
      // Another actor reached the terminal state first; stats bump and event belong to it.
      logger.debug(`Job ${job.jobId}: ${outcome} transition already applied elsewhere, no event from this tracker`);
      return;
    }
    if (outcome === 'unresolved') logger.error(`Job ${job.jobId}: unresolved, an operator resolves it (${err instanceof Error ? err.message : String(err)})`);
    else logger.info(`Job ${job.jobId}: ${outcome}${outcome === 'failed' ? ` (${errorCode})` : ''}`);
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
