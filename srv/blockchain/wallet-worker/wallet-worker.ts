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
  isNotFoundOnAllBackends,
} from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { getTxHashFromCbor } from '../../utils/tx-build-helper';
import { ConfirmationTracker } from './confirmation-tracker';
import { LeaseHeartbeat } from './lease-heartbeat';
import { prepareWorkerBuildRequest } from './build-request';
import { emitServiceEvent } from '../../utils/service-events';
import { createWorkerSigner, type WorkerSigner, type WorkerWalletConfig } from './signers';
import {
  JOB_ERROR_CODES,
  bumpWalletStats,
  failOrphanedBuildingJobs,
  findDueJobs,
  findOrphanedSubmittingJob,
  getJobById,
  markBuilding,
  markFailed,
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
  type WalletJobKindValue,
  type WalletJobRow,
} from './job-store';

const logger = cds.log('CardanoWalletWorker');

/**
 * Wallet worker engine (v2.0, design §6).
 *
 * Dispatch loop over `CardanoWalletJobs`: per tick, for every configured wallet
 * with pending work and NO active job (building or submitted — the queue stays
 * blocked until the previous job CONFIRMS, which makes per-wallet UTxO contention
 * impossible by construction), acquire the per-wallet DB lease and execute:
 *
 *   building   → CardanoIndexer.index<Kind>BuildResult (build + TransactionBuilds row)
 *              → signer.signTransaction
 *   submitting → signed CBOR + hash committed, THEN client.submitTransaction
 *   submitted  → hand to the ConfirmationTracker (crawler hook or polling)
 *
 * The `submitting` commit is what makes the submit boundary crash-safe: the exact
 * bytes that may be on-chain are durable before the network call, and the row stays
 * non-terminal, so it keeps holding its idempotency key. Anything that goes wrong
 * from there on is reconciled against the chain (`reconcileSubmitting`) — the same
 * transaction is re-submitted, never a rebuild.
 *
 * Transient failures BEFORE the signed tx exists (provider outages, rate limits,
 * HSM hiccups during build/sign) re-queue the job with exponential backoff up to
 * `maxAttempts`; deterministic rejections (validation, insufficient funds) fail
 * immediately.
 *
 * All DB access runs in short fresh transactions (ambient context cleared —
 * NIGHTGATE lesson 2) so the single pooled SQLite connection is never held
 * across build/submit round-trips.
 */

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
  network: string;
  config: WalletWorkerConfig;
  instanceId: string;
}

/** Retry backoff: 5s · 2^(attempt-1), capped at 60s. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

/**
 * Transient errors are worth a bounded retry; everything else is deterministic
 * (a retry cannot change the outcome) and fails the job immediately.
 */
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
  private readonly executing = new Set<string>(); // walletIds with an execution in flight in THIS process
  private readonly executionPromises = new Set<Promise<void>>();
  private readonly tracker: ConfirmationTracker;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;

  constructor(private readonly deps: WalletWorkerDeps) {
    this.tracker = new ConfirmationTracker({
      client: deps.client,
      options: {
        confirmationDepth: deps.config.confirmationDepth,
        confirmationTimeoutMs: deps.config.confirmationTimeoutMs,
        pollIntervalMs: Math.max(deps.config.pollIntervalMs, 5_000),
        resubmitOnRollback: deps.config.resubmitOnRollback,
      },
      onFinal: ({ jobId, walletId, outcome, kind, txHash, errorCode, errorMessage }) => {
        logger.debug(`Wallet ${walletId} unblocked (job ${outcome}) — next tick dispatches`);
        // Fired only on a TERMINAL outcome, after the transition is committed, so a
        // subscriber that reads the job row sees the state the event announces.
        emitServiceEvent('CardanoWorkerService', outcome === 'confirmed' ? 'jobConfirmed' : 'jobFailed', {
          jobId,
          walletId,
          kind,
          txHash,
          ...(outcome === 'failed' ? { errorCode: errorCode ?? null, errorMessage: errorMessage ?? null } : {}),
        });
        void this.tickSafe();
      },
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

    // 1. Initialize signers — a broken wallet config skips that wallet, not the worker.
    for (const walletCfg of this.deps.config.wallets) {
      try {
        const signer = createWorkerSigner(walletCfg, this.deps.network);
        this.signers.set(walletCfg.walletId, signer);
        await cds.tx((tx) => upsertWalletRegistration(tx, {
          walletId: walletCfg.walletId,
          signerType: walletCfg.signerType,
          address: signer.getAddress(),
          publicKeyHash: signer.getPublicKeyHash(),
        }));
      } catch (err) {
        logger.error(`Wallet "${walletCfg.walletId}" skipped — signer initialization failed:`, err);
      }
    }
    if (this.signers.size === 0) {
      logger.error('Wallet worker not started: no wallet signer could be initialized');
      return;
    }

    // 2. Crash recovery: fail interrupted builds, re-watch submitted jobs. Rows
    //    interrupted around the submit call stay `submitting` — the first tick
    //    reconciles them against the chain (reconcileOrphanedSubmissions).
    const recovery = await cds.tx((tx) => recoverInterruptedJobs(tx));
    if (recovery.submittingToReconcile.length) {
      logger.warn(`${recovery.submittingToReconcile.length} job(s) with an unresolved submit will be reconciled on the next dispatch tick`);
    }
    for (const job of recovery.submittedToReconcile) {
      if (!job.txHash) continue; // defensive: submitted implies txHash
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
    // Executions are short (build+sign+submit) — await them so teardown never races a write.
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
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      logger.error('Wallet worker dispatch tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    // Interrupted submits first: a stuck `submitting` row blocks its wallet queue
    // and may be the only work there is (no pending job would ever surface it).
    await this.reconcileOrphanedSubmissions();

    const due = await runWithoutAmbientTx(() => cds.tx((tx) => findDueJobs(tx)));
    if (!due.length) return;

    // First runnable job per wallet, dispatch order (priority, createdAt) preserved.
    const nextPerWallet = new Map<string, WalletJobRow>();
    for (const job of due) {
      if (!nextPerWallet.has(job.walletId)) nextPerWallet.set(job.walletId, job);
    }

    for (const [walletId, job] of nextPerWallet) {
      if (!this.running) return;
      if (this.executing.size >= this.deps.config.maxConcurrentWallets) return;
      if (this.executing.has(walletId)) continue;
      const signer = this.signers.get(walletId);
      if (!signer) continue; // job for a wallet this instance cannot sign for

      const dispatched = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
        // Steady-state orphan cleanup: a building row whose wallet lease expired
        // belongs to a dead executor — fail it here so the wallet unblocks without
        // needing a reboot (boot recovery only covers restarts of THIS instance).
        await failOrphanedBuildingJobs(tx, walletId);
        // DB truth serializes across restarts and instances: a building OR submitted
        // job blocks the wallet queue until the tracker finalizes it (design §6).
        if (await walletHasActiveJob(tx, walletId)) return false;
        return tryAcquireWalletLease(tx, walletId, this.deps.instanceId);
      }));
      if (!dispatched) continue;

      this.spawn(walletId, () => this.executeJob(job, signer));
    }
  }

  /**
   * Adopt `submitting` rows left behind by a dead executor (this process before a
   * restart, or another instance whose lease expired) and resolve them against the
   * chain. Runs per wallet under the same lease the executor would hold.
   */
  private async reconcileOrphanedSubmissions(): Promise<void> {
    const { instanceId } = this.deps;
    for (const walletId of this.getWalletIds()) {
      if (!this.running) return;
      if (this.executing.size >= this.deps.config.maxConcurrentWallets) return;
      if (this.executing.has(walletId)) continue;

      const orphan = await runWithoutAmbientTx(() => cds.tx(async (tx) => {
        const stuck = await findOrphanedSubmittingJob(tx, walletId);
        if (!stuck) return null;
        return (await tryAcquireWalletLease(tx, walletId, instanceId)) ? stuck : null;
      }));
      if (!orphan) continue;

      this.spawn(walletId, () => this.reconcileSubmitting(orphan));
    }
  }

  /** Run one wallet's work in the background, tracked for concurrency + shutdown. */
  private spawn(walletId: string, work: () => Promise<void>): void {
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

  /**
   * Execute one job: building → (build → sign) → submitting → submit → submitted,
   * then hand to the tracker. The wallet lease is held for the duration — renewed by
   * a heartbeat, because build+sign can outlast its TTL — and released afterwards
   * (queue serialization continues via the job row, not the lease).
   *
   * Everything up to and including the `submitting` commit may fail freely — nothing
   * has been sent, so the job re-queues or fails normally. Past that commit the job
   * belongs to `reconcileSubmitting`.
   */
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

      if (job.kind === 'submitSigned') {
        const request = JSON.parse(job.request ?? '{}') as { signedTxCbor?: string };
        if (!request.signedTxCbor) {
          throw new BackendError('submitSigned job has no signedTxCbor in its request', 400, ERROR_CODES.INVALID_INPUT);
        }
        signedTxCbor = request.signedTxCbor;
      } else {
        const rawReq = JSON.parse(job.request ?? '{}') as Record<string, unknown>;
        // The worker wallet is ALWAYS the sender/change target — callers cannot
        // spend from foreign addresses through a worker wallet.
        rawReq.network = this.deps.network;
        rawReq.senderAddress = signer.getAddress();
        if (!rawReq.changeAddress) rawReq.changeAddress = signer.getAddress();
        // The stored request has the documented Build*-action payload shape
        // (assetsJson/mintActionsJson/… strings) — transform it into the
        // TxBuildRequest shape the indexer build methods expect.
        const buildReq = prepareWorkerBuildRequest(job.kind as WalletJobKindValue, rawReq, this.deps.network as Network);

        // Fencing: if the lease was lost (instance stalled past the TTL, another
        // instance may have taken over the wallet), abort BEFORE building — the
        // orphan cleanup will fail the row once the lease is provably dead.
        if (!(await heartbeat.fence())) {
          logger.warn(`Job ${job.ID}: wallet lease for ${job.walletId} lost before build — aborting execution`);
          return;
        }
        const buildResult = await runWithoutAmbientTx(() => cds.tx((tx) => this.buildForKind(tx, job, buildReq)));
        unsignedTxCbor = buildResult.unsignedTxCbor as string;
        fee = (buildResult.fee as string | number | null) ?? null;
        buildId = (buildResult.id as string) ?? null;

        signedTxCbor = signer.signTransaction(unsignedTxCbor, buildResult.txBodyHash as string);
      }

      // The hash comes from the signed bytes, not from the submit response, so the
      // row can name the transaction before anyone has seen it.
      const txHash = getTxHashFromCbor(signedTxCbor);

      // Last fence before the irreversible part. Build+sign just consumed real time;
      // if the wallet moved to another instance meanwhile, that instance is entitled
      // to spend the same UTxOs — submitting now would race it. Nothing has been sent
      // yet, so standing down here costs only a rebuild.
      if (!(await heartbeat.fence())) {
        logger.warn(`Job ${job.ID}: wallet lease for ${job.walletId} lost after signing — NOT submitting tx ${txHash}`);
        return;
      }

      // Point of no return: commit the signed tx BEFORE it can reach a backend.
      // A crash after this leaves a `submitting` row that reconciliation resolves;
      // a crash before it leaves a `building` row that was provably never sent.
      // The guard on `building` is also the second half of the fence: if a takeover
      // already failed this row, the transition returns false and nothing is sent.
      const stored = await runWithoutAmbientTx(() => cds.tx((tx) =>
        markSubmitting(tx, job.ID, { txHash, unsignedTxCbor, signedTxCbor, fee }),
      ));
      if (!stored) {
        logger.warn(`Job ${job.ID}: submitting transition was fenced — not submitting (another executor owns this job)`);
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

  /**
   * Send a transaction that is already durable in its `submitting` row and advance
   * the job to `submitted`.
   *
   * A submit failure is NEVER propagated as a job failure here: a rejection from one
   * backend does not prove the tx is absent from every mempool (failover, timeouts,
   * a node that accepted before the connection dropped). The row simply stays
   * `submitting` and the next tick reconciles it against the chain.
   */
  private async submitStoredTransaction(
    job: WalletJobRow,
    tx: { txHash: string; signedTxCbor: string; buildId: string | null; attempt: number },
  ): Promise<void> {
    let submittedHash: string;
    try {
      submittedHash = await this.submitWithAlreadyKnownTolerance(tx.signedTxCbor);
    } catch (err) {
      logger.error(`Job ${job.ID}: submit failed for tx ${tx.txHash} — job stays submitting for chain reconciliation:`, err);
      return;
    }

    if (job.kind !== 'submitSigned') {
      // Observability parity with the synchronous flow: record the submission row.
      await runWithoutAmbientTx(() => cds.tx((t) =>
        this.deps.indexer.persistTransactionSubmission(t, { signedTxCbor: tx.signedTxCbor, txHash: submittedHash, buildId: tx.buildId }),
      )).catch((err) => logger.warn(`Job ${job.ID}: submission bookkeeping failed (job continues):`, err));
    }

    await this.adoptSubmitted(job, submittedHash, tx.signedTxCbor);
    logger.info(`Job ${job.ID} (wallet ${job.walletId}, kind ${job.kind}): submitted as ${submittedHash} (attempt ${tx.attempt})`);
  }

  /** submitting → submitted + hand to the confirmation tracker. */
  private async adoptSubmitted(job: WalletJobRow, txHash: string, signedTxCbor: string): Promise<void> {
    const submitted = await runWithoutAmbientTx(() => cds.tx((tx) => markSubmitted(tx, job.ID, txHash)));
    if (!submitted) {
      logger.error(`Job ${job.ID}: tx ${txHash} is out there but the submitted transition was fenced — tracker adopts the tx anyway`);
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

  /**
   * Resolve a `submitting` job whose submit outcome is unknown (process died around
   * the network call, or the call failed ambiguously). The stored transaction is the
   * only one this job may ever have — it is re-submitted verbatim, never rebuilt.
   *
   * 1. Re-submit the same CBOR: mempool/ledger dedup makes this a no-op if it was
   *    accepted before, so success (or "already known") simply promotes the job.
   * 2. If that fails, ask the chain: found → the tx did make it, promote it.
   * 3. Only when the chain proves absence AND the node rejects the tx for good (or
   *    it has been absent past the confirmation timeout) is the job failed —
   *    failing releases the idempotency key, so it needs that proof.
   * Anything else leaves the row as-is; the next tick tries again.
   *
   * Runs under the same heartbeat-kept wallet lease as an execution: the chain
   * lookups here are slow enough to outlive the raw TTL. Losing the lease mid-way
   * is not dangerous (the re-submit is the same transaction, and every terminal
   * transition is row-guarded), so it only stops further work.
   */
  private async reconcileSubmitting(job: WalletJobRow): Promise<void> {
    const { instanceId } = this.deps;
    const heartbeat = this.leaseHeartbeat(job.walletId);
    try {
      if (!job.signedTxCbor || !job.txHash) {
        // Cannot happen via markSubmitting; treat as a never-sent job rather than
        // leaving the wallet queue blocked forever.
        logger.error(`Job ${job.ID}: submitting row without signed transaction — failing as PROCESS_RESTART`);
        await this.failReconciled(job, JOB_ERROR_CODES.PROCESS_RESTART,
          new Error('Job was interrupted before its signed transaction was stored.'));
        return;
      }

      logger.warn(`Job ${job.ID}: reconciling interrupted submit of tx ${job.txHash}`);
      let submitError: unknown;
      try {
        const txHash = await this.submitWithAlreadyKnownTolerance(job.signedTxCbor);
        await this.adoptSubmitted(job, txHash, job.signedTxCbor);
        logger.info(`Job ${job.ID}: re-submitted the original signed tx (${txHash}) — now awaiting confirmation`);
        return;
      } catch (err) {
        submitError = err;
      }

      // The tx may have been rejected precisely BECAUSE it is already on-chain
      // (its inputs are spent), so the chain — not the rejection — decides.
      let onChain: boolean;
      try {
        await this.deps.client.getTransaction(job.txHash);
        onChain = true;
      } catch (lookupErr) {
        if (!isNotFoundOnAllBackends(lookupErr)) {
          logger.warn(`Job ${job.ID}: chain lookup for ${job.txHash} inconclusive — retrying next tick:`, lookupErr);
          return;
        }
        onChain = false;
      }

      if (onChain) {
        logger.info(`Job ${job.ID}: tx ${job.txHash} is on-chain despite the failed submit — awaiting confirmation`);
        await this.adoptSubmitted(job, job.txHash, job.signedTxCbor);
        return;
      }

      const ageMs = job.submittedAt ? Date.now() - Date.parse(job.submittedAt) : 0;
      const expired = ageMs > this.deps.config.confirmationTimeoutMs;
      if (isTransientJobError(submitError) && !expired) {
        logger.warn(`Job ${job.ID}: re-submit failed transiently and tx is not on-chain — retrying next tick:`, submitError);
        return;
      }

      // Proven absent + a rejection that will not change (or a tx that is past its
      // mempool lifetime): no transaction of this job can reach the chain anymore,
      // so releasing the idempotency key is safe.
      const code = expired ? JOB_ERROR_CODES.TX_DROPPED : JOB_ERROR_CODES.SUBMIT_REJECTED;
      logger.error(`Job ${job.ID}: tx ${job.txHash} is not on-chain and cannot be submitted (${code}) — failing:`, submitError);
      await this.failReconciled(job, code, submitError);
    } finally {
      heartbeat.stop();
      await runWithoutAmbientTx(() => cds.tx((tx) => releaseWalletLease(tx, job.walletId, instanceId)))
        .catch(() => undefined);
    }
  }

  private async failReconciled(job: WalletJobRow, code: string, err: unknown): Promise<void> {
    await runWithoutAmbientTx(() => cds.tx(async (tx) => {
      const transitioned = await markFailed(tx, job.ID, code, err ?? new Error(code));
      if (transitioned) await bumpWalletStats(tx, job.walletId, 'failed');
    })).catch((persistErr) => logger.error(`Job ${job.ID}: failure persist failed:`, persistErr));
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

  /**
   * Submit tolerant of "already known": after a crash between submit and the
   * `submitted` transition, the retry re-submits the same CBOR — mempool dedup
   * answers with an already-submitted error that IS our success case.
   */
  private async submitWithAlreadyKnownTolerance(signedTxCbor: string): Promise<string> {
    try {
      return await this.deps.client.submitTransaction(signedTxCbor);
    } catch (err) {
      if (err instanceof TransactionAlreadySubmittedError) {
        const txHash = getTxHashFromCbor(signedTxCbor);
        logger.info(`Submit reported tx already known — treating as success (${txHash})`);
        return txHash;
      }
      throw err;
    }
  }

  private async handleExecutionFailure(job: WalletJobRow, attempt: number, err: unknown): Promise<void> {
    // Only a pre-submit job may be re-queued (rebuild) or failed from here. Once the
    // row is `submitting`, a signed tx exists that may be in a mempool: rebuilding it
    // would double-pay and failing it would release the idempotency key on a
    // transaction the chain has not ruled on. Those rows go to reconciliation.
    const current = await runWithoutAmbientTx(() => cds.tx((tx) => getJobById(tx, job.ID)))
      .catch(() => null);
    if (current && current.status !== 'building') {
      logger.error(`Job ${job.ID}: execution error while ${current.status} — leaving the outcome to reconciliation:`, err);
      return;
    }

    if (isTransientJobError(err) && attempt < job.maxAttempts) {
      const backoff = retryBackoffMs(attempt);
      logger.warn(`Job ${job.ID}: transient failure on attempt ${attempt}/${job.maxAttempts} — retrying in ${backoff}ms:`, err);
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
