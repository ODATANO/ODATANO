import cds, { Request } from '@sap/cds';
import { TransactionAlreadySubmittedError } from '../../utils/errors';
import { detachedTx, runWithoutAmbientTx } from '../../utils/tx-utils';
import { extractTxCacheTargets } from '../../utils/tx-build-helper';
import { getExternalSignerModule } from './external-signer';
import type { CardanoIndexer } from '../cardano-indexer';
import type { CardanoClient } from '../cardano-client';
import { AddressTransactionBuilds, type TransactionSubmission } from '#cds-models/CardanoTransactionService';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('SubmissionFinalizer');

/** Shape persisted by indexVerifiedTransactionSubmission. */
export interface FinalizeParams {
  signingRequestId: string;
  buildId: string;
  fullSignedTxCbor: string;
  txHash: string;
  verificationResult: {
    txBodyHash: string;
    witnessCount: number;
    signerKeyHashes: string[];
    warnings: string[];
  };
  signerType?: string;
  signerInfo?: string;
}

type SubmissionIndexer = Pick<CardanoIndexer, 'persistTransactionSubmission' | 'updateSubmissionStatus' | 'dropDuplicateSubmission' | 'invalidateUtxoCacheForTx'>;

// Lazy require avoids the srv/server.ts <-> this-module import cycle; the app-context
// getters are only needed at runtime.
function server(): typeof import('../../server') {
  return require('../../server') as typeof import('../../server');
}

// Outcomes are written in detached transactions, so no DB lock is held across the network call.
// A failure is marked 'failed' and rethrown. A crash before finalize leaves 'submitting'.
export async function submitAndFinalize(
  SigningRequests: unknown,
  params: FinalizeParams,
  afterFinalize?: (db: cds.Transaction) => Promise<void>
): Promise<unknown> {
  // Persist the submission + 'submitted' status in its own committed transaction.
  const finalizeSubmitted = () => detachedTx('finalize transaction submission', async (db: cds.Transaction) => {
    const submission = await server().getCardanoIndexer().indexVerifiedTransactionSubmission(db as never, params);
    if (afterFinalize) await afterFinalize(db);
    // Best effort; must never roll back the durable submission record.
    try {
      await server().getCardanoIndexer().invalidateUtxoCacheForTx(db as never, extractTxCacheTargets(params.fullSignedTxCbor));
    } catch (invalidateErr: unknown) {
      logger.warn(`UTxO cache invalidation failed (submit unaffected): ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`);
    }
    return submission;
  });

  try {
    await server().getCardanoClient().submitTransaction(params.fullSignedTxCbor);
  } catch (submitErr: unknown) {
    // Already-submitted means the tx reached the mempool (e.g. first backend accepted it, response
    // lost, fallback saw the duplicate): finalize as 'submitted' rather than recording a spurious 'failed'.
    if (submitErr instanceof TransactionAlreadySubmittedError) {
      logger.info({ signingRequestId: params.signingRequestId, txHash: params.txHash },
        'Submit reported already-submitted; finalizing as submitted (tx already in mempool)');
      return finalizeSubmitted();
    }
    try {
      await detachedTx('mark signing request failed', (db: cds.Transaction) => db.run(
        UPDATE.entity(SigningRequests as never).set({ status: 'failed' }).where({ id: params.signingRequestId })
      ));
    } catch (markErr: unknown) {
      logger.error({ err: markErr, signingRequestId: params.signingRequestId },
        'Could not durably mark signing request failed after submit error');
    }
    throw submitErr;
  }

  return finalizeSubmitted();
}

// 'pending' commits first and the network call runs outside any DB tx.
// The final status commits on its own and survives a rethrown error.
export async function submitRecorded(
  params: { signedTxCbor: string; txHash: string; buildId: string | null },
  indexer: SubmissionIndexer = server().getCardanoIndexer(),
  client: Pick<CardanoClient, 'submitTransaction'> = server().getCardanoClient(),
): Promise<TransactionSubmission> {
  const record = await detachedTx('record transaction submission', (db) => indexer.persistTransactionSubmission(db as never, params));

  try {
    await client.submitTransaction(params.signedTxCbor);
    logger.info({ txHash: params.txHash }, 'Transaction submitted to blockchain');
  } catch (submitErr: unknown) {
    const alreadySubmitted = submitErr instanceof TransactionAlreadySubmittedError;
    const errMsg = submitErr instanceof Error ? submitErr.message : String(submitErr);
    try {
      // A resubmit keeps one row per transaction: its own row goes when an earlier one exists.
      await detachedTx('record submission outcome', async (db) => {
        if (!alreadySubmitted) return indexer.updateSubmissionStatus(db as never, record.id!, 'failed', errMsg);
        if (await indexer.dropDuplicateSubmission(db as never, record.id!, params.txHash)) return;
        return indexer.updateSubmissionStatus(db as never, record.id!, 'submitted');
      });
    } catch (markErr: unknown) {
      logger.error({ err: markErr, submissionId: record.id }, 'Could not record the submission outcome after a submit error');
    }
    if (!alreadySubmitted) logger.error({ txHash: params.txHash, error: errMsg }, 'Transaction submission failed');
    throw submitErr;
  }

  await detachedTx('record submission outcome', async (db) => {
    await indexer.updateSubmissionStatus(db as never, record.id!, 'submitted');
    // best-effort: a cache failure must not roll back the submitted status
    try {
      const senders = params.buildId
        ? await db.run(SELECT.from(AddressTransactionBuilds).columns('address_address').where({ txBuild_id: params.buildId })) as Array<{ address_address?: string | null }>
        : [];
      await indexer.invalidateUtxoCacheForTx(db as never, extractTxCacheTargets(params.signedTxCbor),
        senders.map(r => r.address_address).filter((a): a is string => !!a));
    } catch (invalidateErr: unknown) {
      logger.warn(`UTxO cache invalidation failed (submit unaffected): ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`);
    }
  });
  return { ...record, status: 'submitted' };
}

// Submits only after the caller's transaction has committed and released its connection.
// If the caller rolls back, 'succeeded' never fires and nothing was claimed.
export function scheduleDeferredSubmit(req: Request, SigningRequests: unknown, params: FinalizeParams): void {
  req.on('succeeded', () => {
    setImmediate(() => {
      runWithoutAmbientTx(() => submitAndFinalize(SigningRequests, params))
        .then(() => {
          logger.info({ signingRequestId: params.signingRequestId, txHash: params.txHash }, 'Deferred submit finalized');
        })
        .catch((err: unknown) => {
          // submitAndFinalize already durably marked the request 'failed'.
          logger.error({ err, signingRequestId: params.signingRequestId },
            'Deferred submit failed (signing request marked failed)');
        });
    });
  });
}

// Boot recovery for rows stuck at 'submitting' that have signed CBOR. Idempotent, since a tx
// the node already holds finalizes as 'submitted'. Returns the number of rows attempted.
export async function redriveInterruptedSubmissions(): Promise<number> {
  const SigningRequests = 'odatano.cardano.SigningRequests';

  const rows = await detachedTx('load interrupted deferred submissions', (db: cds.Transaction) =>
    db.run(
      SELECT.from(SigningRequests)
        .where({ status: 'submitting' })
        .and('signedTxCbor is not null')
    )
  ) as Array<{
    id: string; build_id?: string | null; txBodyHash: string; signedTxCbor: string;
    signerType?: string | null; signerInfo?: string | null;
  }>;

  if (!rows.length) return 0;
  logger.info(`Re-driving ${rows.length} interrupted deferred submission(s)`);

  let attempted = 0;
  for (const row of rows) {
    try {
      // Re-verify from the persisted CBOR to recompute the witness metadata the finalize step persists.
      const verificationResult = getExternalSignerModule().verifyOrThrow(row.signedTxCbor, row.txBodyHash);
      attempted++;
      await submitAndFinalize(SigningRequests, {
        signingRequestId: row.id,
        buildId: row.build_id ?? '',
        fullSignedTxCbor: row.signedTxCbor,
        txHash: row.txBodyHash,
        verificationResult,
        signerType: row.signerType ?? undefined,
        signerInfo: row.signerInfo ?? undefined,
      });
      logger.info({ signingRequestId: row.id, txHash: row.txBodyHash }, 'Interrupted submission re-driven');
    } catch (err: unknown) {
      // Submit errors already marked the row 'failed'; verification errors leave it at
      // 'submitting' for manual inspection.
      logger.error({ err, signingRequestId: row.id }, 'Re-drive of interrupted submission failed');
    }
  }
  return attempted;
}
