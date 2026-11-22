import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { BackendError, NotFoundError, rejectInvalid, rejectMissing } from './utils/errors';
import { ERROR_CODES } from './utils/error-codes';
import { validateJsonWithLimits } from './utils/validators';
import { answerNumbersAsText } from './utils/result-numbers';
import {
  getWalletWorker,
  isWalletWorkerRunning,
  startWalletWorker,
  stopWalletWorker,
} from './blockchain/wallet-worker';
import {
  countPendingJobs,
  getJobById,
  insertJob,
  markCancelled,
  readWallet,
  runWithoutAmbientTx,
  type WalletJobKindValue,
  type WalletJobRow,
} from './blockchain/wallet-worker/job-store';
import { getCardanoClient, getCardanoIndexer, getHsmConfig } from './server';
import { loadWalletWorkerConfigFromEnv } from './config';
import type { WalletWorkerConfig } from './blockchain/wallet-worker';
import { SubmitWalletJob, CancelJob, GetJobStatus } from '#cds-models/CardanoWorkerService';

const logger = cds.log('CardanoWorkerService');

const TERMINAL_JOB_STATUS: ReadonlySet<string> = new Set(['confirmed', 'failed', 'cancelled']);
const JOB_WAIT_POLL_MS = 1000;

function isAdmin(req: Request): boolean {
  return req.user?.is?.('Admin') ?? false;
}

/** The first role the caller lacks for this wallet: its own requiresRole, then hsm.requiresRole on an HSM wallet. */
function missingWalletRole(req: Request, wallet: { signerType?: string; requiresRole?: string | null } | undefined): string | null {
  const roles = [wallet?.requiresRole, wallet?.signerType === 'hsm' ? getHsmConfig()?.requiresRole : null];
  return roles.find((role) => role && !req.user?.is(role)) ?? null;
}

function toJobStatus(job: WalletJobRow) {
  return {
    jobId: job.ID,
    walletId: job.walletId,
    kind: job.kind,
    status: job.status,
    attempt: job.attempt,
    txHash: job.txHash,
    fee: job.fee != null ? String(job.fee) : null,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    submittedAt: job.submittedAt,
    confirmedAt: job.confirmedAt,
    finishedAt: job.finishedAt,
  };
}

/** CardanoWorkerService handlers: job submission and status, worker control. */
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);

  // SubmitWalletJob: queue an async transaction job; returns the jobId immediately.
  srv.on(SubmitWalletJob, async (req) => {
    const { walletId, kind, requestJson, idempotencyKey, priority, notBefore } = req.data;

    if (!walletId?.trim()) return rejectInvalid(req, 'SubmitWalletJob', 'walletId is required', 'walletId');
    // the model rejects an unknown kind and a priority outside 0..10000
    if (!kind) return rejectMissing(req, 'SubmitWalletJob', 'kind');
    if (!requestJson?.trim()) return rejectInvalid(req, 'SubmitWalletJob', 'requestJson is required', 'requestJson');
    const jsonResult = validateJsonWithLimits(requestJson, 'requestJson');
    if (!jsonResult.valid) return rejectInvalid(req, 'SubmitWalletJob', jsonResult.error!, 'requestJson');
    if (notBefore != null && Number.isNaN(Date.parse(String(notBefore)))) {
      return rejectInvalid(req, 'SubmitWalletJob', 'notBefore must be a valid timestamp', 'notBefore');
    }
    if (idempotencyKey != null && String(idempotencyKey).length > 100) {
      return rejectInvalid(req, 'SubmitWalletJob', 'idempotencyKey exceeds 100 characters', 'idempotencyKey');
    }

    let config: WalletWorkerConfig;
    try {
      config = loadWalletWorkerConfigFromEnv();
    } catch (err) {
      return rejectInvalid(req, 'SubmitWalletJob', err instanceof Error ? err.message : String(err));
    }
    if (!config.enabled) {
      return rejectInvalid(req, 'SubmitWalletJob',
        'Wallet worker is not enabled: set cds.requires.odatano-core.walletWorker.enabled (or WALLET_WORKER_ENABLED=true) with configured wallets.');
    }

    // Role gate on this instance's config, mirroring the sign service's 403.
    const configuredRole = missingWalletRole(req, config.wallets.find((w) => w.walletId === walletId));
    if (configuredRole) {
      return req.reject(403, `SubmitWalletJob on wallet "${walletId}" requires role '${configuredRole}'`);
    }

    return handleRequest(req, async (db) => {
      const wallet = await readWallet(db, walletId);
      if (!wallet) return rejectInvalid(req, 'SubmitWalletJob', `Unknown wallet "${walletId}": configured wallets are registered at worker start`, 'walletId');
      if (!wallet.enabled) return rejectInvalid(req, 'SubmitWalletJob', `Wallet "${walletId}" is disabled`, 'walletId');
      // Registered row too: another instance may run the wallet this one has no config for.
      const registeredRole = missingWalletRole(req, wallet);
      if (registeredRole) {
        throw new BackendError(
          `SubmitWalletJob on wallet "${walletId}" requires role '${registeredRole}'`,
          403, ERROR_CODES.FORBIDDEN, undefined, undefined, 'walletId'
        );
      }

      const result = await insertJob(db, {
        walletId,
        kind: kind as WalletJobKindValue,
        request: requestJson,
        idempotencyKey: idempotencyKey ?? null,
        priority: priority ?? undefined,
        notBefore: notBefore ? new Date(notBefore).toISOString() : null,
        maxAttempts: config.defaultMaxAttempts,
        createdBy: req.user?.id ?? null,
      });
      logger.info(`Job ${result.jobId} accepted (wallet=${walletId}, kind=${kind}, dedup=${result.deduplicated})`);
      return result;
    });
  });

  // CancelJob: pending jobs only; scoped to the creator unless Admin.
  srv.on(CancelJob, async (req) => {
    const { jobId } = req.data;
    if (!jobId) return rejectInvalid(req, 'CancelJob', 'jobId is required', 'jobId');

    return handleRequest(req, async (db) => {
      const job = await getJobById(db, jobId);
      if (!job || (!isAdmin(req) && job.createdBy !== req.user?.id)) {
        // Same 404 for "not found" and "not yours" (no existence oracle). Throw, don't
        // req.reject: inside handleRequest a plain CAP error is remapped to 500.
        throw new NotFoundError(`Job ${jobId}`);
      }
      const cancelled = await markCancelled(db, jobId);
      if (!cancelled) {
        return rejectInvalid(req, 'CancelJob',
          `Job ${jobId} is ${job.status}: only pending jobs can be cancelled`, 'jobId');
      }
      return true;
    });
  });

  // GetJobStatus: scoped to the creator unless Admin. With waitMs it answers once the job is
  // confirmed, failed or cancelled, or when the time is up. Each read has its own transaction,
  // so a waiting request holds no database connection.
  srv.on(GetJobStatus, async (req) => {
    const { jobId, waitMs } = req.data;
    if (!jobId) return rejectInvalid(req, 'GetJobStatus', 'jobId is required', 'jobId');
    const deadline = Date.now() + Number(waitMs ?? 0);

    return handleRequest(req, async () => {
      for (;;) {
        const job = await runWithoutAmbientTx(() => cds.tx((tx) => getJobById(tx, jobId)));
        if (!job || (!isAdmin(req) && job.createdBy !== req.user?.id)) {
          throw new NotFoundError(`Job ${jobId}`); // see CancelJob: reject() here becomes a 500
        }
        const timeUp = Date.now() + JOB_WAIT_POLL_MS > deadline || req.http?.res.destroyed === true;
        if (TERMINAL_JOB_STATUS.has(job.status) || timeUp) return toJobStatus(job);
        await new Promise((resolve) => setTimeout(resolve, JOB_WAIT_POLL_MS));
      }
    });
  });

  // GetWorkerStatus: live summary of the local worker instance.
  srv.on('GetWorkerStatus', async (req: Request) => {
    return handleRequest(req, async (db) => {
      const worker = getWalletWorker();
      const summary = worker?.getStatusSummary() ?? {
        running: false, wallets: [], executing: [], awaitingConfirmation: 0,
      };
      return { ...summary, pendingJobs: await countPendingJobs(db) };
    });
  });

  // PauseWorker: stop the local instance; queued jobs stay pending.
  srv.on('PauseWorker', async (req: Request) => {
    return handleRequest(req, async () => {
      await stopWalletWorker();
      logger.info('Wallet worker paused via control action');
      return true;
    });
  });

  // ResumeWorker: (re)start the local instance from config. Gated on enabled,
  // mirroring resumeCrawler.
  srv.on('ResumeWorker', async (req: Request) => {
    let config: WalletWorkerConfig;
    try {
      config = loadWalletWorkerConfigFromEnv();
    } catch (err) {
      return rejectInvalid(req, 'ResumeWorker', err instanceof Error ? err.message : String(err));
    }
    if (!config.enabled) {
      return rejectInvalid(req, 'ResumeWorker',
        'Wallet worker is not enabled: set cds.requires.odatano-core.walletWorker.enabled (or WALLET_WORKER_ENABLED=true) before resuming.');
    }
    return handleRequest(req, async () => {
      const client = getCardanoClient();
      await startWalletWorker({
        client,
        indexer: getCardanoIndexer(),
        network: client.network,
        config,
      });
      logger.info('Wallet worker resumed via control action');
      return isWalletWorkerRunning();
    });
  });
};
