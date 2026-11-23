import cds from '@sap/cds';
import type { CardanoClient, Network } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { TxBuildRequest } from '../../utils/types';
import {
  BackendError,
  ProviderUnavailableError,
  RateLimitError,
  AllBackendsFailedError,
  HsmError,
  TransactionAlreadySubmittedError,
} from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { getTxHashFromCbor } from '../../utils/tx-build-helper';
import { attemptSubmit, RESUBMIT_WINDOW_MS } from '../signing/submission-finalizer';
import { getExternalSignerModule } from '../signing/external-signer';
import { parseTransaction } from '../../cbor';
import { TransactionSubmissions } from '#cds-models/odatano/cardano';
import { ConfirmationTracker } from './confirmation-tracker';
import { LeaseHeartbeat } from './lease-heartbeat';
import { parseJobRequest, preparePayoutRequest, prepareWorkerBuildRequest, submitSignedProblem } from './build-request';
import { emitServiceEvent } from '../../utils/service-events';
import { createWorkerSigner, type WorkerSigner, type WorkerWalletConfig } from './signers';
import { isExpired, judgeLanding } from '../signing/landing-proof';
import { InvalidationUnfundedError, checkInvalidation, pickInvalidationInput, resendInvalidation, sendInvalidation, type OutputRef } from './invalidation';
import {
  JOB_ERROR_CODES,
  bumpWalletStats,
  failOrphanedBuildingJobs,
  findInvalidatingJobs,
  findNextDueJob,
  findOrphanedSubmittingJob,
  findSubmittedJobs,
  getJobById,
  markBuilding,
  markFailed,
  markFailedAfterSend,
  markSpendsNoWalletUtxo,
  markUnresolved,
  markSubmitted,
  markSubmitting,
  recoverInterruptedJobs,
  releaseWalletLease,
  renewWalletLease,
  requeueForRetry,
  runWithoutAmbientTx,
  tryAcquireWalletLease,
  upsertWalletRegistration,
  walletHasActiveJob,
  type DueJobRef,
  type WalletJobKindValue,
  type WalletJobRow,
} from './job-store';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('CardanoWalletWorker');

// Each tick leases every wallet with pending work and runs its next job up to the confirmation tracker.
// Once the signed tx is stored, failures are checked against the chain and never rebuilt.

export interface WalletWorkerConfig {
  enabled: boolean;
  wallets: WorkerWalletConfig[];
  maxConcurrentWallets: number;
  confirmationDepth: number;
  confirmationTimeoutMs: number;
  pollIntervalMs: number;
  defaultMaxAttempts: number;
  resubmitOnRollback: boolean;
}

export interface WalletWorkerDeps {
  client: CardanoClient;
  indexer: CardanoIndexer;
  network: Network;
  config: WalletWorkerConfig;
  instanceId: string;
}

/** Retry backoff: 5s · 2^(attempt-1), capped at 60s. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

/** Transient errors get a bounded retry; everything else fails the job immediately. */
export function isTransientJobError(err: unknown): boolean {
  if (err instanceof ProviderUnavailableError) return true;
  if (err instanceof RateLimitError) return true;
  if (err instanceof AllBackendsFailedError) return true;
  if (err instanceof HsmError) return true;
  if (err instanceof BackendError) return err.statusCode >= 500 || err.statusCode === 429;
  return false;
}

function terminalErrorCode(err: unknown): string {
  if (err instanceof BackendError && err.code) return String(err.code);
  return 'EXECUTION_FAILED';
}

export class CardanoWalletWorker {
  private readonly signers = new Map<string, WorkerSigner>();
  private readonly executing = new Set<string>(); // walletIds executing in THIS process
  private readonly executionPromises = new Set<Promise<void>>();
  private readonly tracker: ConfirmationTracker;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  /** Earliest next reconcile per job with an open submit, and how often it was tried. */
  private readonly reconcileBackoff = new Map<string, { attempts: number; notBefore: number }>();
  /** Jobs whose transaction has no expiry, has not landed and still can: the unspent inputs, by job. */
  private readonly staleJobs = new Map<string, { walletId: string; unspentInputs: OutputRef[] }>();
  /** Earliest next look at a job's invalidation, and the tip height an own output was first seen at. */
  private readonly invalidationNotBefore = new Map<string, number>();
  private readonly invalidationSeen = new Map<string, number>();
  /** Sends of a stored self-transfer not seen on chain yet, and the earliest next one. */
  private readonly invalidationResend = new Map<string, { attempts: number; notBefore: number }>();
  private running = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly deps: WalletWorkerDeps) {
    this.tracker = new ConfirmationTracker({
      client: deps.client,
      indexer: deps.indexer,
      options: {
        confirmationDepth: deps.config.confirmationDepth,
        confirmationTimeoutMs: deps.config.confirmationTimeoutMs,
        pollIntervalMs: Math.max(deps.config.pollIntervalMs, 5_000),
        resubmitOnRollback: deps.config.resubmitOnRollback,
      },
      onFinal: ({ jobId, walletId, outcome, kind, txHash, errorCode, errorMessage }) => {
        logger.debug(`Wallet ${walletId} unblocked (job ${outcome}), next tick dispatches`);
        // Terminal outcomes only, after the commit, so subscribers reading the row see the announced state.
        const event = outcome === 'confirmed' ? 'jobConfirmed' : outcome === 'failed' ? 'jobFailed' : 'jobUnresolved';
        emitServiceEvent('CardanoWorkerService', event, {
          jobId,
          walletId,
          kind,
          txHash,
          ...(outcome === 'failed' ? { errorCode: errorCode ?? null } : {}),
          ...(outcome !== 'confirmed' ? { errorMessage: errorMessage ?? null } : {}),
        });
        void this.tickSafe();
      },
      onStale: ({ jobId, walletId }, unspentInputs) => {
        this.staleJobs.set(jobId, { walletId, unspentInputs });
      },
    });
  }

  /** A terminal outcome after its commit, so subscribers reading the row see the announced state. */
  private announce(job: WalletJobRow, outcome: 'failed' | 'unresolved', errorCode: string, err: unknown): void {
    emitServiceEvent('CardanoWorkerService', outcome === 'failed' ? 'jobFailed' : 'jobUnresolved', {
      jobId: job.ID,
      walletId: job.walletId,
      kind: job.kind,
      txHash: job.txHash,
      ...(outcome === 'failed' ? { errorCode } : {}),
      errorMessage: err instanceof Error ? err.message : err != null ? String(err) : null,
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Wallets this instance can sign for (signer init succeeded). */
  getWalletIds(): string[] {
    return [...this.signers.keys()];
  }

  getSigner(walletId: string): WorkerSigner | undefined {
    return this.signers.get(walletId);
  }

  /** Live status summary for the control service. */
  getStatusSummary(): { running: boolean; wallets: string[]; executing: string[]; awaitingConfirmation: number } {
    return {
      running: this.running,
      wallets: this.getWalletIds(),
      executing: [...this.executing],
      awaitingConfirmation: this.tracker.size(),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.deps.config.wallets.length) {
      logger.warn('Wallet worker refused to start: no wallets configured');
      return;
    }

    // 1. Initialize signers. A broken wallet config skips that wallet, not the worker.
    for (const walletCfg of this.deps.config.wallets) {
      try {
        const signer = createWorkerSigner(walletCfg, this.deps.network);
        this.signers.set(walletCfg.walletId, signer);
        await cds.tx((tx) => upsertWalletRegistration(tx, {
          walletId: walletCfg.walletId,
          signerType: walletCfg.signerType,
          address: signer.getAddress(),
          publicKeyHash: signer.getPublicKeyHash(),
          requiresRole: walletCfg.requiresRole ?? null,
        }));
      } catch (err) {
        logger.error(`Wallet "${walletCfg.walletId}" skipped, signer initialization failed:`, err);
      }
    }
    if (this.signers.size === 0) {
      logger.error('Wallet worker not started: no wallet signer could be initialized');
      return;
    }
    // a confirmation needs a transaction lookup or a ledger read of the transaction's outputs
    if (!this.deps.client.supports('getTransaction') && !this.deps.client.supports('isUtxoUnspent')) {
      logger.error('Wallet worker not started: no backend can confirm a transaction (getTransaction or isUtxoUnspent)');
      return;
    }

    // 2. Crash recovery: fail interrupted builds, re-watch submitted jobs; `submitting`
    //    rows are reconciled by the first tick.
    const recovery = await cds.tx((tx) => recoverInterruptedJobs(tx));
    if (recovery.submittingToReconcile.length) {
      logger.warn(`${recovery.submittingToReconcile.length} job(s) with an unresolved submit will be reconciled on the next dispatch tick`);
    }
    this.trackSubmitted(recovery.submittedToReconcile);

    // 3. Go.
    this.running = true;
    this.tracker.start();
    this.dispatchTimer = setInterval(() => { void this.tickSafe(); }, this.deps.config.pollIntervalMs);
    this.dispatchTimer.unref?.();
    void this.tickSafe();
    logger.info(`Wallet worker started (wallets=[${this.getWalletIds().join(', ')}], instance=${this.deps.instanceId})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.dispatchTimer) { clearInterval(this.dispatchTimer); this.dispatchTimer = null; }
    this.tracker.stop();
    // A running tick may still spawn work; let it finish, then await every execution.
    await this.tickInFlight;
    await Promise.allSettled([...this.executionPromises]);
    for (const walletId of this.getWalletIds()) {
      try {
        await cds.tx((tx) => releaseWalletLease(tx, walletId, this.deps.instanceId));
      } catch (err) {
        logger.debug(`Lease release for ${walletId} failed (TTL expires it anyway):`, err);
      }
    }
    logger.info('Wallet worker stopped');
  }

  /** One dispatch round; serialized (overlapping timers collapse into one run). */
  private async tickSafe(): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = this.tick()
      .catch((err) => logger.error('Wallet worker dispatch tick failed:', err))
      .finally(() => { this.tickInFlight = null; });
    await this.tickInFlight;
  }

  private async tick(): Promise<void> {
    // Interrupted submits first: a stuck `submitting` row blocks its wallet queue.
    await this.reconcileOrphanedSubmissions();
    // Submitted jobs of a stopped or crashed instance are watched here too. track() is idempotent.
    await this.adoptSubmittedJobs();
    // Transactions without an expiry that can still land get an input spent by a self-transfer.
    await this.invalidateStaleJobs();

    // The next due job of every idle wallet this instance signs for: one row per wallet.
    const idle = this.getWalletIds().filter(walletId => !this.executing.has(walletId));
    if (!idle.length) return;
    const due = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
      const next: DueJobRef[] = [];
      for (const walletId of idle) {
        const ref = await findNextDueJob(tx, walletId);
        if (ref) next.push(ref);
      }
      return next;
    }));
    // dispatch order across wallets: priority, then age
    due.sort((a, b) => a.priority - b.priority || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

    for (const { ID, walletId } of due) {
      if (!this.running) return;
      if (this.executing.size >= this.deps.config.maxConcurrentWallets) return;
      const signer = this.signers.get(walletId);
      if (!signer) continue;

      const job = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
        // A building row with an expired lease belongs to a dead executor.
        // Failing it unblocks the wallet without a reboot.
        await failOrphanedBuildingJobs(tx, walletId);
        // An active job blocks the wallet queue until the tracker finalizes it.
        if (await walletHasActiveJob(tx, walletId)) return null;
        const next = await getJobById(tx, ID);
        if (next?.status !== 'pending') return null;
        return (await tryAcquireWalletLease(tx, walletId, this.deps.instanceId)) ? next : null;
      }));
      if (!job) continue;

      this.spawn(walletId, () => this.executeJob(job, signer));
    }
  }

  /** Watch every submitted job of the wallets this instance signs for until it confirms or fails. */
  private async adoptSubmittedJobs(): Promise<void> {
    const rows = await runWithoutAmbientTx(() => cds.tx((tx) => findSubmittedJobs(tx)));
    this.trackSubmitted(rows.filter((row) => this.signers.has(row.walletId)));
  }

  private trackSubmitted(rows: WalletJobRow[]): void {
    for (const job of rows) {
      if (!job.txHash) continue; // submitted implies txHash
      this.tracker.track({
        jobId: job.ID,
        walletId: job.walletId,
        kind: job.kind,
        txHash: job.txHash,
        signedTxCbor: job.signedTxCbor,
        submittedAt: job.submittedAt,
        confirmedSlot: job.confirmedSlot,
        confirmedHeight: job.confirmedHeight,
      });
    }
  }

  /** Adopt `submitting` rows left by a dead executor and resolve them against the chain, under the wallet lease. */
  private async reconcileOrphanedSubmissions(): Promise<void> {
    const { instanceId } = this.deps;
    for (const walletId of this.getWalletIds()) {
      if (!this.running) return;
      if (this.executing.size >= this.deps.config.maxConcurrentWallets) return;
      if (this.executing.has(walletId)) continue;

      const orphan = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
        const stuck = await findOrphanedSubmittingJob(tx, walletId);
        if (!stuck || (this.reconcileBackoff.get(stuck.ID)?.notBefore ?? 0) > Date.now()) return null;
        return (await tryAcquireWalletLease(tx, walletId, instanceId)) ? stuck : null;
      }));
      if (!orphan) continue;

      this.spawn(walletId, () => this.reconcileSubmitting(orphan));
    }
  }

  /** Run one wallet's work in the background, tracked for concurrency + shutdown. */
  private spawn(walletId: string, work: () => Promise<void>): void {
    // stop() began after the lease was taken; stop() releases it
    if (!this.running) return;
    this.executing.add(walletId);
    const execution = work()
      .catch((err) => logger.error(`Wallet ${walletId}: unhandled execution error:`, err))
      .finally(() => {
        this.executing.delete(walletId);
        this.executionPromises.delete(execution);
      });
    this.executionPromises.add(execution);
  }

  /** A heartbeat that keeps this instance's lease on `walletId` alive while it works. */
  private leaseHeartbeat(walletId: string): LeaseHeartbeat {
    const { instanceId } = this.deps;
    const heartbeat = new LeaseHeartbeat(
      async () => await runWithoutAmbientTx(() => cds.tx((tx) => renewWalletLease(tx, walletId, instanceId))),
      `wallet ${walletId}`,
    );
    heartbeat.start();
    return heartbeat;
  }

  /** Builds, signs and submits one job under a renewed wallet lease. After the submitting commit, reconcileSubmitting owns it. */
  private async executeJob(job: WalletJobRow, signer: WorkerSigner): Promise<void> {
    const { instanceId } = this.deps;
    const attempt = job.attempt + 1;

    const claimed = await runWithoutAmbientTx(() => cds.tx((tx) => markBuilding(tx, job.ID, attempt)));
    if (!claimed) return; // cancelled or claimed elsewhere

    const heartbeat = this.leaseHeartbeat(job.walletId);
    try {
      let unsignedTxCbor: string | null = null;
      let signedTxCbor: string;
      let fee: string | number | null = null;
      let buildId: string | null = null;

      const request = parseJobRequest(job.request);
      if (!request) throw new BackendError('requestJson must be a JSON object', 400, ERROR_CODES.INVALID_INPUT, undefined, undefined, 'requestJson');
      if (job.kind === 'submitSigned') {
        // jobs queued before the expiry rule are refused here, before anything is sent
        const problem = submitSignedProblem(request, this.deps.network);
        if (problem) throw new BackendError(problem, 400, ERROR_CODES.INVALID_INPUT, undefined, undefined, 'requestJson');
        signedTxCbor = request.signedTxCbor as string;
      } else {
        const rawReq = request;
        // The worker wallet is always the sender and change target. It never spends from foreign addresses.
        rawReq.network = this.deps.network;
        rawReq.senderAddress = signer.getAddress();
        rawReq.changeAddress = signer.getAddress();
        const build = this.buildOf(job, rawReq);

        // Lease lost → abort BEFORE building; orphan cleanup fails the row once the lease is provably dead.
        if (!(await heartbeat.fence())) {
          logger.warn(`Job ${job.ID}: wallet lease for ${job.walletId} lost before build, aborting execution`);
          return;
        }
        const buildResult = await runWithoutAmbientTx(() => cds.tx(build));
        unsignedTxCbor = buildResult.unsignedTxCbor as string;
        fee = (buildResult.fee as string | number | null) ?? null;
        buildId = (buildResult.id as string) ?? null;

        signedTxCbor = signer.signTransaction(unsignedTxCbor, buildResult.txBodyHash as string);
        // a signature that misses a key the body requires is refused by the node: fail before sending
        const requiredSigners = new Set([signer.getPublicKeyHash(), ...(parseTransaction(unsignedTxCbor).requiredSigners ?? [])].map((k) => k.toLowerCase()));
        getExternalSignerModule().verifyOrThrow(signedTxCbor, buildResult.txBodyHash as string, { requiredSigners: [...requiredSigners] });
      }

      // Hash from the signed bytes, so the row can name the tx before anyone has seen it.
      const txHash = getTxHashFromCbor(signedTxCbor);

      // Last fence before the irreversible part: another instance owning the wallet now
      // may spend the same UTxOs. Nothing has been sent, so standing down costs only a rebuild.
      if (!(await heartbeat.fence())) {
        logger.warn(`Job ${job.ID}: wallet lease for ${job.walletId} lost after signing, NOT submitting tx ${txHash}`);
        return;
      }

      // Point of no return: commit the signed tx BEFORE it can reach a backend. The guard on
      // `building` is the second half of the fence: a row already failed by a takeover returns false.
      const stored = await runWithoutAmbientTx(() => cds.tx((tx) =>
        markSubmitting(tx, job.ID, { txHash, unsignedTxCbor, signedTxCbor, fee }),
      ));
      if (!stored) {
        logger.warn(`Job ${job.ID}: submitting transition was fenced, not submitting (another executor owns this job)`);
        return;
      }

      await this.submitStoredTransaction(job, { txHash, signedTxCbor, buildId, attempt });
    } catch (err) {
      await this.handleExecutionFailure(job, attempt, err);
    } finally {
      heartbeat.stop();
      await runWithoutAmbientTx(() => cds.tx((tx) => releaseWalletLease(tx, job.walletId, instanceId)))
        .catch(() => undefined);
    }
  }

  /** Sends the stored tx. A failed submit leaves the row submitting, since one rejection proves nothing. */
  private async submitStoredTransaction(
    job: WalletJobRow,
    tx: { txHash: string; signedTxCbor: string; buildId: string | null; attempt: number },
  ): Promise<void> {
    let submittedHash: string;
    try {
      submittedHash = await this.submitWithAlreadyKnownTolerance(tx.signedTxCbor);
    } catch (err) {
      logger.error(`Job ${job.ID}: submit failed for tx ${tx.txHash}, job stays submitting for chain reconciliation:`, err);
      return;
    }

    await this.adoptSubmitted(job, submittedHash, tx.signedTxCbor, tx.buildId);
    logger.info(`Job ${job.ID} (wallet ${job.walletId}, kind ${job.kind}): submitted as ${submittedHash} (attempt ${tx.attempt})`);
  }

  /** submitting → submitted + hand to the confirmation tracker. */
  private async adoptSubmitted(job: WalletJobRow, txHash: string, signedTxCbor: string, buildId: string | null = null): Promise<void> {
    if (job.kind !== 'submitSigned') {
      // Record the submission row as the synchronous flow does, once per tx.
      await runWithoutAmbientTx(() => cds.tx(async (t) => {
        const known = await t.run(SELECT.one.from(TransactionSubmissions).columns('id').where({ txHash }));
        if (!known) await this.deps.indexer.persistTransactionSubmission(t, { signedTxCbor, txHash, buildId, status: 'submitted' });
      })).catch((err) => logger.warn(`Job ${job.ID}: submission bookkeeping failed (job continues):`, err));
    }
    const submitted = await runWithoutAmbientTx(() => cds.tx((tx) => markSubmitted(tx, job.ID, txHash)));
    if (!submitted) {
      logger.error(`Job ${job.ID}: tx ${txHash} is out there but the submitted transition was fenced, tracker adopts the tx anyway`);
    }
    this.tracker.track({
      jobId: job.ID,
      walletId: job.walletId,
      kind: job.kind,
      txHash,
      signedTxCbor,
      submittedAt: job.submittedAt ?? new Date().toISOString(),
    });
  }

  // Resolves a submitting job by re-submitting the stored tx, then looking it up on chain.
  // Fails only when the tx is absent and rejected for good or timed out. Otherwise retries next tick.
  private async reconcileSubmitting(job: WalletJobRow): Promise<void> {
    const { instanceId } = this.deps;
    const heartbeat = this.leaseHeartbeat(job.walletId);
    try {
      if (!job.signedTxCbor || !job.txHash) {
        // Cannot happen via markSubmitting; treat as never sent rather than blocking the wallet queue forever.
        logger.error(`Job ${job.ID}: submitting row without signed transaction, failing as PROCESS_RESTART`);
        await this.failReconciled(job, JOB_ERROR_CODES.PROCESS_RESTART,
          new Error('Job was interrupted before its signed transaction was stored.'));
        return;
      }

      logger.warn(`Job ${job.ID}: reconciling interrupted submit of tx ${job.txHash}`);
      // The same bytes again while young, later the chain alone. 'failed' only with proof that it cannot land.
      const sentAtMs = job.submittedAt ? Date.parse(job.submittedAt) : NaN;
      const ageMs = Number.isFinite(sentAtMs) ? Date.now() - sentAtMs : 0;
      const { outcome, error, finalRefusal, unspentInputs } = await attemptSubmit(
        job.signedTxCbor, job.txHash, !(ageMs > RESUBMIT_WINDOW_MS), this.deps.indexer, this.deps.client,
        Number.isFinite(sentAtMs) ? sentAtMs : null);

      if (outcome === 'accepted') {
        this.reconcileBackoff.delete(job.ID);
        await this.adoptSubmitted(job, job.txHash, job.signedTxCbor);
        logger.info(`Job ${job.ID}: tx ${job.txHash} is with the node or on chain, now awaiting confirmation`);
        return;
      }
      if (outcome === 'unknown') {
        if (unspentInputs) this.staleJobs.set(job.ID, { walletId: job.walletId, unspentInputs });
        const attempts = (this.reconcileBackoff.get(job.ID)?.attempts ?? 0) + 1;
        this.reconcileBackoff.set(job.ID, { attempts, notBefore: Date.now() + retryBackoffMs(attempts) });
        logger.warn(`Job ${job.ID}: tx ${job.txHash} may still land, next check in ${retryBackoffMs(attempts) / 1000}s:`, error);
        return;
      }

      this.reconcileBackoff.delete(job.ID);
      if (outcome === 'unresolved') {
        logger.error(`Job ${job.ID}: tx ${job.txHash} can no longer land and nothing shows whether it did; unresolved, an operator resolves it:`, error);
        const marked = await runWithoutAmbientTx(() => cds.tx((tx) => markUnresolved(tx, job.ID, error ?? new Error('unresolved'))))
          .catch((persistErr) => { logger.error(`Job ${job.ID}: unresolved persist failed:`, persistErr); return false; });
        if (marked) this.announce(job, 'unresolved', JOB_ERROR_CODES.OUTCOME_UNRESOLVED, error);
        return;
      }
      // It landed with failing scripts, or it can never land. The job fails and keeps its idempotency key.
      const code = outcome === 'scriptFailed' ? JOB_ERROR_CODES.SCRIPT_FAILED
        : finalRefusal ? JOB_ERROR_CODES.SUBMIT_REJECTED : JOB_ERROR_CODES.TX_DROPPED;
      logger.error(`Job ${job.ID}: tx ${job.txHash} fails as ${code}:`, error);
      await this.failReconciled(job, code, error);
    } finally {
      heartbeat.stop();
      await runWithoutAmbientTx(() => cds.tx((tx) => releaseWalletLease(tx, job.walletId, instanceId)))
        .catch(() => undefined);
    }
  }

  private async failReconciled(job: WalletJobRow, code: string, err: unknown): Promise<void> {
    const transitioned = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
      const done = await markFailedAfterSend(tx, job.ID, code, err ?? new Error(code));
      if (done) {
        await bumpWalletStats(tx, job.walletId, 'failed');
        if (job.txHash) await tx.run(UPDATE.entity(TransactionSubmissions).set({ status: 'failed' }).where({ txHash: job.txHash, status: { in: ['submitted', 'pending'] } }));
      }
      return done;
    })).catch((persistErr) => { logger.error(`Job ${job.ID}: failure persist failed:`, persistErr); return false; });
    if (transitioned) this.announce(job, 'failed', code, err);
  }

  /** One invalidation per wallet at a time: the job already being invalidated first, else a stale one. */
  private async invalidateStaleJobs(): Promise<void> {
    const { instanceId } = this.deps;
    const now = Date.now();
    for (const walletId of this.getWalletIds()) {
      if (!this.running) return;
      if (this.executing.size >= this.deps.config.maxConcurrentWallets) return;
      if (this.executing.has(walletId)) continue;
      const signer = this.signers.get(walletId)!;
      const target = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
        const inProgress = (await findInvalidatingJobs(tx, walletId))[0];
        const staleId = [...this.staleJobs].find(([, s]) => s.walletId === walletId)?.[0];
        const id = inProgress?.ID ?? staleId;
        if (!id || (this.invalidationNotBefore.get(id) ?? 0) > now) return null;
        if (!(await tryAcquireWalletLease(tx, walletId, instanceId))) return null;
        // read under the lease: another instance may have stored a self-transfer meanwhile
        return getJobById(tx, id);
      }));
      if (!target) continue;
      this.invalidationNotBefore.set(target.ID, now + 60_000);
      this.spawn(walletId, () => this.handleInvalidation(target, signer));
    }
  }

  // The job's own transaction first: landed means the tracker takes it. Then its self-transfer:
  // deep enough fails the job as INVALIDATED, unable to land sends a new one.
  private async handleInvalidation(job: WalletJobRow, signer: WorkerSigner): Promise<void> {
    const heartbeat = this.leaseHeartbeat(job.walletId);
    try {
      if (!job.signedTxCbor || !job.txHash || (job.status !== 'submitted' && job.status !== 'submitting')) {
        this.staleJobs.delete(job.ID);
        return;
      }
      const sentAtMs = job.submittedAt ? Date.parse(job.submittedAt) : NaN;
      const own = await judgeLanding(job.signedTxCbor, job.txHash, this.deps, Number.isFinite(sentAtMs) ? sentAtMs : null);
      if (own.verdict === 'onChain' || own.verdict === 'scriptFailed') {
        this.staleJobs.delete(job.ID);
        if (job.status === 'submitting') await this.adoptSubmitted(job, job.txHash, job.signedTxCbor);
        return;
      }
      const unspentInputs = own.verdict === 'stale' ? own.unspentInputs : this.staleJobs.get(job.ID)?.unspentInputs ?? [];

      if (job.invalidationTxHash && job.invalidationTxCbor) {
        const state = await checkInvalidation(this.deps, job, this.invalidationSeen);
        if (state === 'confirmed') return await this.finishInvalidated(job);
        if (state === 'unknown') {
          const err = new Error(`Transaction ${job.txHash} has no expiry; the input its self-transfer ${job.invalidationTxHash} spends is spent and nothing shows by which transaction`);
          const marked = await runWithoutAmbientTx(() => cds.tx((tx) => markUnresolved(tx, job.ID, err)));
          if (marked) { this.tracker.untrack(job.ID); this.announce(job, 'unresolved', JOB_ERROR_CODES.OUTCOME_UNRESOLVED, err); }
          return;
        }
        if (state === 'included') return;
        if (state === 'waiting') return await this.resendWaitingInvalidation(job, heartbeat);
        this.invalidationResend.delete(job.ID);
      }
      if (own.verdict !== 'stale') return; // not stale (any more): nothing to spend
      const { input, held } = await pickInvalidationInput(this.deps, signer.getAddress(), unspentInputs);
      if (!input) {
        // every input is unspent and none is the wallet's: it cannot take the wallet funds
        this.staleJobs.delete(job.ID);
        this.invalidationNotBefore.set(job.ID, Date.now() + 60 * 60_000);
        const released = await runWithoutAmbientTx(() => cds.tx((tx) => markSpendsNoWalletUtxo(tx, job.ID)));
        if (released) logger.warn(`Job ${job.ID}: tx ${job.txHash} has no expiry and can still land, but spends no UTxO of the wallet; it stays open and no longer holds the wallet queue`);
        return;
      }
      if (!(await heartbeat.fence())) return;
      const keep = [...this.staleJobs].filter(([id, s]) => id !== job.ID && s.walletId === job.walletId).flatMap(([, s]) => s.unspentInputs);
      await sendInvalidation(this.deps, job, signer, input, { held, keep });
    } catch (err) {
      if (err instanceof InvalidationUnfundedError) {
        this.invalidationNotBefore.set(job.ID, Date.now() + 60 * 60_000);
        logger.warn(`Job ${job.ID}: tx ${job.txHash} has no expiry and can still land; the wallet cannot fund the self-transfer that would end it (${err.message}). Next try in an hour`);
        return;
      }
      logger.warn(`Job ${job.ID}: invalidation step failed (next tick retries):`, err);
    } finally {
      heartbeat.stop();
      await runWithoutAmbientTx(() => cds.tx((tx) => releaseWalletLease(tx, job.walletId, this.deps.instanceId)))
        .catch(() => undefined);
    }
  }

  // The stored self-transfer, not on chain yet and not expired: the same bytes again, waiting 1, 2, 4
  // and up to 30 minutes between sends.
  private async resendWaitingInvalidation(job: WalletJobRow, heartbeat: LeaseHeartbeat): Promise<void> {
    if (isExpired(job.invalidationTxCbor!, this.deps.network)) return;
    const state = this.invalidationResend.get(job.ID) ?? { attempts: 0, notBefore: 0 };
    if (state.notBefore > Date.now() || !(await heartbeat.fence())) return;
    await resendInvalidation(this.deps, job);
    const attempts = state.attempts + 1;
    this.invalidationResend.set(job.ID, { attempts, notBefore: Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 30 * 60_000) });
  }

  private async finishInvalidated(job: WalletJobRow): Promise<void> {
    const err = new Error(`Self-transfer ${job.invalidationTxHash} spent an input of transaction ${job.txHash} and is past rollback depth; ${job.txHash} can never land`);
    const transitioned = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
      const done = await markFailedAfterSend(tx, job.ID, JOB_ERROR_CODES.INVALIDATED, err);
      if (done) {
        await bumpWalletStats(tx, job.walletId, 'failed');
        await tx.run(UPDATE.entity(TransactionSubmissions).set({ status: 'failed' }).where({ txHash: job.txHash!, status: { in: ['submitted', 'pending'] } }));
      }
      return done;
    }));
    this.staleJobs.delete(job.ID);
    this.invalidationSeen.delete(job.ID);
    this.invalidationNotBefore.delete(job.ID);
    this.invalidationResend.delete(job.ID);
    this.tracker.untrack(job.ID);
    if (transitioned) {
      logger.warn(`Job ${job.ID}: failed as INVALIDATED`);
      this.announce(job, 'failed', JOB_ERROR_CODES.INVALIDATED, err);
    }
  }

  /** The job's build, ready to run in a transaction. A malformed request throws 400 INVALID_INPUT here. */
  private buildOf(job: WalletJobRow, raw: Record<string, unknown>): (tx: cds.Transaction) => Promise<Record<string, unknown>> {
    if (job.kind === 'payout') {
      const request = preparePayoutRequest(raw);
      return (tx) => this.deps.indexer.indexPlutusBuildResult(tx, request) as Promise<Record<string, unknown>>;
    }
    const request = prepareWorkerBuildRequest(job.kind as WalletJobKindValue, raw, this.deps.network);
    return (tx) => this.buildForKind(tx, job, request);
  }

  /** Dispatch the job kind to the matching indexer build method. */
  private buildForKind(tx: cds.Transaction, job: WalletJobRow, buildReq: TxBuildRequest): Promise<Record<string, unknown>> {
    const indexer = this.deps.indexer;
    switch (job.kind) {
      case 'simpleAda': return indexer.indexSimpleBuildResult(tx, buildReq) as Promise<Record<string, unknown>>;
      case 'metadata': return indexer.indexMetadataBuildResult(tx, buildReq) as Promise<Record<string, unknown>>;
      case 'multiAsset': return indexer.indexMultiAssetBuildResult(tx, buildReq) as Promise<Record<string, unknown>>;
      case 'mint': return indexer.indexMintBuildResult(tx, buildReq) as Promise<Record<string, unknown>>;
      case 'plutusSpend': return indexer.indexPlutusSpendBuildResult(tx, buildReq) as Promise<Record<string, unknown>>;
      default:
        throw new BackendError(`Unsupported job kind "${job.kind}"`, 400, ERROR_CODES.INVALID_INPUT);
    }
  }

  /** Submit treating "already known" as success: a re-submit of the same CBOR after a crash hits mempool dedup. */
  private async submitWithAlreadyKnownTolerance(signedTxCbor: string): Promise<string> {
    try {
      return await this.deps.client.submitTransaction(signedTxCbor);
    } catch (err) {
      if (err instanceof TransactionAlreadySubmittedError) {
        const txHash = getTxHashFromCbor(signedTxCbor);
        logger.info(`Submit reported tx already known, treating as success (${txHash})`);
        return txHash;
      }
      throw err;
    }
  }

  private async handleExecutionFailure(job: WalletJobRow, attempt: number, err: unknown): Promise<void> {
    // Only a pre-submit (`building`) job may be re-queued or failed here; a `submitting` row's
    // tx may be in a mempool, so it goes to reconciliation.
    const current = await runWithoutAmbientTx(() => cds.tx((tx) => getJobById(tx, job.ID)))
      .catch(() => null);
    if (current && current.status !== 'building') {
      logger.error(`Job ${job.ID}: execution error while ${current.status}, leaving the outcome to reconciliation:`, err);
      return;
    }

    if (isTransientJobError(err) && attempt < job.maxAttempts) {
      const backoff = retryBackoffMs(attempt);
      logger.warn(`Job ${job.ID}: transient failure on attempt ${attempt}/${job.maxAttempts}, retrying in ${backoff}ms:`, err);
      await runWithoutAmbientTx(() => cds.tx((tx) =>
        requeueForRetry(tx, job.ID, err, new Date(Date.now() + backoff).toISOString()),
      )).catch((persistErr) => logger.error(`Job ${job.ID}: retry re-queue failed:`, persistErr));
      return;
    }

    const code = isTransientJobError(err) ? JOB_ERROR_CODES.RETRIES_EXHAUSTED : terminalErrorCode(err);
    logger.error(`Job ${job.ID}: failed terminally (${code}) on attempt ${attempt}:`, err);
    await runWithoutAmbientTx(() => cds.tx(async (tx) => {
      const transitioned = await markFailed(tx, job.ID, code, err);
      if (transitioned) await bumpWalletStats(tx, job.walletId, 'failed');
    })).catch((persistErr) => logger.error(`Job ${job.ID}: failure persist failed:`, persistErr));
  }
}
