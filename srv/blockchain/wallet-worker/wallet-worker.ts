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
import { ConfirmationTracker } from './confirmation-tracker';
import { prepareWorkerBuildRequest } from './build-request';
import { createWorkerSigner, type WorkerSigner, type WorkerWalletConfig } from './signers';
import {
  JOB_ERROR_CODES,
  bumpWalletStats,
  failOrphanedBuildingJobs,
  findDueJobs,
  markBuilding,
  markFailed,
  markSubmitted,
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
 *   building → CardanoIndexer.index<Kind>BuildResult (build + TransactionBuilds row)
 *            → signer.signTransaction → client.submitTransaction
 *   submitted → hand to the ConfirmationTracker (crawler hook or polling)
 *
 * Transient failures (provider outages, rate limits, HSM hiccups) re-queue the
 * job with exponential backoff up to `maxAttempts`; deterministic rejections
 * (validation, insufficient funds) fail immediately. After a successful submit
 * a rebuilt tx is NEVER auto-re-submitted — only the tracker may re-send the
 * same signed CBOR after a rollback.
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
      onFinal: ({ walletId, outcome }) => {
        logger.debug(`Wallet ${walletId} unblocked (job ${outcome}) — next tick dispatches`);
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

    // 2. Crash recovery: fail interrupted builds, re-watch submitted jobs.
    const recovery = await cds.tx((tx) => recoverInterruptedJobs(tx));
    for (const job of recovery.submittedToReconcile) {
      if (!job.txHash) continue; // defensive: submitted implies txHash
      this.tracker.track({
        jobId: job.ID,
        walletId: job.walletId,
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

      this.executing.add(walletId);
      const execution = this.executeJob(job, signer)
        .catch((err) => logger.error(`Job ${job.ID}: unhandled execution error:`, err))
        .finally(() => {
          this.executing.delete(walletId);
          this.executionPromises.delete(execution);
        });
      this.executionPromises.add(execution);
    }
  }

  /**
   * Execute one job: building → (build → sign) → submit → submitted, then hand to
   * the tracker. The wallet lease is held for the duration and released afterwards
   * (queue serialization continues via the submitted row, not the lease).
   */
  private async executeJob(job: WalletJobRow, signer: WorkerSigner): Promise<void> {
    const { instanceId } = this.deps;
    const attempt = job.attempt + 1;

    const claimed = await runWithoutAmbientTx(() => cds.tx((tx) => markBuilding(tx, job.ID, attempt)));
    if (!claimed) return; // cancelled or claimed elsewhere

    try {
      let txHash: string;
      let unsignedTxCbor: string | null = null;
      let signedTxCbor: string;
      let fee: string | number | null = null;

      if (job.kind === 'submitSigned') {
        const request = JSON.parse(job.request ?? '{}') as { signedTxCbor?: string };
        if (!request.signedTxCbor) {
          throw new BackendError('submitSigned job has no signedTxCbor in its request', 400, ERROR_CODES.INVALID_INPUT);
        }
        signedTxCbor = request.signedTxCbor;
        txHash = await this.submitWithAlreadyKnownTolerance(signedTxCbor);
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
        // instance may have taken over the wallet), abort BEFORE building/submitting
        // — the orphan cleanup will fail the row once the lease is provably dead.
        const renewed = await runWithoutAmbientTx(() => cds.tx((tx) => renewWalletLease(tx, job.walletId, instanceId)));
        if (!renewed) {
          logger.warn(`Job ${job.ID}: wallet lease for ${job.walletId} lost before build — aborting execution`);
          return;
        }
        const buildResult = await runWithoutAmbientTx(() => cds.tx((tx) => this.buildForKind(tx, job, buildReq)));
        unsignedTxCbor = buildResult.unsignedTxCbor as string;
        fee = (buildResult.fee as string | number | null) ?? null;

        signedTxCbor = signer.signTransaction(unsignedTxCbor, buildResult.txBodyHash as string);
        txHash = await this.submitWithAlreadyKnownTolerance(signedTxCbor);

        // Observability parity with the synchronous flow: record the submission row.
        const buildId = (buildResult.id as string) ?? null;
        await runWithoutAmbientTx(() => cds.tx((tx) =>
          this.deps.indexer.persistTransactionSubmission(tx, { signedTxCbor, txHash, buildId }),
        )).catch((err) => logger.warn(`Job ${job.ID}: submission bookkeeping failed (job continues):`, err));
      }

      const submitted = await runWithoutAmbientTx(() => cds.tx((tx) =>
        markSubmitted(tx, job.ID, { txHash, unsignedTxCbor, signedTxCbor, fee }),
      ));
      if (!submitted) {
        logger.error(`Job ${job.ID}: submit succeeded (tx ${txHash}) but the submitted transition was fenced — tracker adopts the tx anyway`);
      }
      logger.info(`Job ${job.ID} (wallet ${job.walletId}, kind ${job.kind}): submitted as ${txHash} (attempt ${attempt})`);

      this.tracker.track({
        jobId: job.ID,
        walletId: job.walletId,
        txHash,
        signedTxCbor,
        submittedAt: new Date().toISOString(),
      });
    } catch (err) {
      await this.handleExecutionFailure(job, attempt, err);
    } finally {
      await runWithoutAmbientTx(() => cds.tx((tx) => releaseWalletLease(tx, job.walletId, instanceId)))
        .catch(() => undefined);
    }
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
