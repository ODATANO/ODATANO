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

// Lazy require breaks the srv/server.ts <-> this-module import cycle (the
// server calls redriveInterruptedSubmissions at boot; we need its app-context
// getters at runtime only). Same pattern as src/plugin.ts.
function server(): typeof import('../../server') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../server') as typeof import('../../server');
}

/**
 * Submit a verified+claimed signing request to the blockchain and persist the
 * outcome — DELIBERATELY outside the caller's request transaction.
 *
 * The caller must already have durably committed `status:'submitting'` (the
 * claim). This function then:
 *   1. submits with NO DB write-lock held (the lock was the reason concurrent
 *      submits serialized and the SQLite busy-timeout could fire mid-network),
 *   2. on submit failure: marks the request 'failed' in its own committed tx
 *      and rethrows (NOT rolled back to a pre-submit status — losing the
 *      attempt would hide a tx the node may have accepted),
 *   3. on success: persists the submission + 'submitted' status in a committed
 *      transaction.
 *
 * Crash window: a process death between (1) and (3) leaves the request durably
 * at 'submitting'. Deferred-path requests carry their signed CBOR on the row
 * and are re-driven at the next boot (redriveInterruptedSubmissions); sync-path
 * requests are left for the operator/poller exactly as before.
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
    // Already-submitted means the tx reached the mempool — e.g. the first backend accepted
    // it but its response was lost and a fallback observed the duplicate. That is SUCCESS,
    // not failure: finalize it as 'submitted' (same as the happy path) instead of durably
    // recording a spurious 'failed' for a tx the node already holds.
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
 * Deferred-submit scheduler (KNOWN_ISSUES #11, Layer 2).
 *
 * Called by an action handler AFTER verify + claim ran on the CALLER's
 * transaction. Hooks the request's post-commit event: only once the caller's
 * root transaction has committed (claim durable, pooled connection released)
 * does the network submit + finalize run — detached via setImmediate +
 * runWithoutAmbientTx, so no ambient transaction is held across it.
 *
 * If the caller's transaction rolls back instead, 'succeeded' never fires and
 * nothing was claimed — strictly consistent.
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
 * Boot-time recovery: re-drive submissions that were claimed on the deferred
 * path (status 'submitting' WITH persisted signedTxCbor) but never finalized —
 * i.e. the process died between the caller's commit and the detached submit.
 *
 * Safe to repeat: a tx the node already holds finalizes as 'submitted' via the
 * TransactionAlreadySubmittedError path in submitAndFinalize. Rows at
 * 'submitting' WITHOUT signed CBOR (sync-path crash window) are deliberately
 * left untouched for the operator/poller, exactly as before Layer 2.
 *
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
      // Re-verify from the persisted CBOR (deterministic — it passed at claim
      // time; this recomputes the witness metadata the finalize step persists).
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
      // submitAndFinalize marked the row 'failed' on submit errors; verification
      // errors leave it at 'submitting' for manual inspection (should not happen
      // for CBOR that verified once).
      logger.error({ err, signingRequestId: row.id }, 'Re-drive of interrupted submission failed');
    }
  }
  return attempted;
}
