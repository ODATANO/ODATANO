import cds, { Request } from '@sap/cds';
import { TransactionAlreadySubmittedError } from '../../utils/errors';
import { detachedTx, runWithoutAmbientTx } from '../../utils/tx-utils';
import { extractTxCacheTargets } from '../../utils/tx-build-helper';
import { getExternalSignerModule } from './external-signer';

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

// Lazy require avoids the srv/server.ts <-> this-module import cycle; the app-context
// getters are only needed at runtime.
function server(): typeof import('../../server') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../server') as typeof import('../../server');
}

/**
 * Submit a claimed signing request (status 'submitting' already committed by the caller) and
 * persist the outcome in detached transactions, so no DB lock is held across the network call.
 * Submit failure → 'failed' in its own tx, then rethrow. A crash before finalize leaves 'submitting'.
 */
export async function submitAndFinalize(
  SigningRequests: unknown,
  params: FinalizeParams,
  afterFinalize?: (db: cds.Transaction) => Promise<void>
): Promise<unknown> {
  // Persist the submission + 'submitted' status in its own committed transaction.
  const finalizeSubmitted = () => detachedTx('finalize transaction submission', async (db: cds.Transaction) => {
    const submission = await server().getCardanoIndexer().indexVerifiedTransactionSubmission(db as never, params);
    if (afterFinalize) await afterFinalize(db);
    // Invalidate stale UTxO cache (spent inputs + output addresses) — best-effort,
    // must never roll back the durable submission record.
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
        'Submit reported already-submitted — finalizing as submitted (tx already in mempool)');
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

/**
 * Deferred submit: runs submitAndFinalize only after the caller's root transaction has committed
 * (claim durable, connection released), detached via setImmediate + runWithoutAmbientTx.
 * If the caller rolls back, 'succeeded' never fires and nothing was claimed.
 */
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

/**
 * Boot-time recovery: re-drive rows at 'submitting' WITH persisted signedTxCbor (process died between
 * the caller's commit and the detached submit). Idempotent: a tx the node already holds finalizes as
 * 'submitted'. Rows without signed CBOR are left for the operator/poller.
 * @returns number of rows re-driven (attempted, not necessarily succeeded)
 */
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
