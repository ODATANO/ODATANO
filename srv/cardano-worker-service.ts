import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { BackendError, NotFoundError, rejectInvalid, rejectMissing } from './utils/errors';
import { ERROR_CODES } from './utils/error-codes';
import { validateJsonWithLimits } from './utils/validators';
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
  type WalletJobKindValue,
  type WalletJobRow,
} from './blockchain/wallet-worker/job-store';
import { getCardanoClient, getCardanoIndexer, getHsmConfig, loadWalletWorkerConfigFromEnv } from './server';
import type { WalletWorkerConfig } from './blockchain/wallet-worker';
import { SubmitWalletJob, CancelJob, GetJobStatus } from '#cds-models/CardanoWorkerService';

const logger = cds.log('CardanoWorkerService');

function isAdmin(req: Request): boolean {
  return req.user?.is?.('Admin') ?? false;
}

/** The HSM role a caller lacks for an HSM-backed wallet, the same gate SignWithHsm applies; null when none is missing. */
function missingHsmRole(req: Request, signerType: string | undefined): string | null {
  if (signerType !== 'hsm') return null;
  const requiresRole = getHsmConfig()?.requiresRole;
  if (!requiresRole || req.user?.is(requiresRole)) return null;
  return requiresRole;
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
    const configuredRole = missingHsmRole(req, config.wallets.find((w) => w.walletId === walletId)?.signerType);
    if (configuredRole) {
      return req.reject(403, `SubmitWalletJob on HSM-backed wallet "${walletId}" requires role '${configuredRole}'`);
    }

    return handleRequest(req, async (db) => {
      const wallet = await readWallet(db, walletId);
      if (!wallet) return rejectInvalid(req, 'SubmitWalletJob', `Unknown wallet "${walletId}": configured wallets are registered at worker start`, 'walletId');
      if (!wallet.enabled) return rejectInvalid(req, 'SubmitWalletJob', `Wallet "${walletId}" is disabled`, 'walletId');
      // Registered row too: another instance may run the HSM wallet this one has no config for.
      const registeredRole = missingHsmRole(req, wallet.signerType);
      if (registeredRole) {
        throw new BackendError(
          `Wallet "${walletId}" is HSM-backed and requires role '${registeredRole}'`,
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

  // GetJobStatus: scoped to the creator unless Admin.
  srv.on(GetJobStatus, async (req) => {
    const { jobId } = req.data;
    if (!jobId) return rejectInvalid(req, 'GetJobStatus', 'jobId is required', 'jobId');

    return handleRequest(req, async (db) => {
      const job = await getJobById(db, jobId);
      if (!job || (!isAdmin(req) && job.createdBy !== req.user?.id)) {
        throw new NotFoundError(`Job ${jobId}`); // see CancelJob: reject() here becomes a 500
      }
      return toJobStatus(job);
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
