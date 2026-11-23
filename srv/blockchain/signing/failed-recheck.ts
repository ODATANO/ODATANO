import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { TransactionSubmissions, CardanoWalletJobs } from '#cds-models/odatano/cardano';
import { runWithoutAmbientTx } from '../../utils/tx-utils';
import { findOnChain, type PresenceIndexer, type TransactionLookup } from '../transaction-presence';
import { getExternalSignerModule } from './external-signer';
import { JOB_ERROR_CODES, reopenFailedJob } from '../wallet-worker/job-store';
import type { CardanoIndexer } from '../cardano-indexer';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('FailedRecheck');

const SIGNING_REQUESTS = 'odatano.cardano.SigningRequests';
const PAGE = 200;

// Earlier versions marked a submit failed on a refusal or elapsed time alone, even when the
// transaction landed. This reads every failed submission, signing request and wallet job again under
// the evidence rule and moves the ones on chain with passing scripts back to submitted.

export interface FailedRecheckProgress {
  submissions: number; // failed submissions read
  requests: number;    // failed signing requests read
  jobs: number;        // wallet jobs failed as TX_DROPPED or SUBMIT_REJECTED read
  restored: number;    // rows found on chain and moved to submitted
}

export interface FailedRecheckDeps {
  indexer: PresenceIndexer & Pick<CardanoIndexer, 'indexVerifiedTransactionSubmission'>;
  client: TransactionLookup;
}

function note(slot: number | null): string {
  return `re-checked at ${new Date().toISOString()}: on chain${slot != null ? ` at slot ${slot}` : ''}`;
}

// Where the chain holds the transaction with passing scripts, or null. A crawled row that cannot tell
// whether its scripts passed asks a backend that can; without such an answer the row stays failed.
async function onChainWithPassingScripts(deps: FailedRecheckDeps, txHash: string): Promise<{ slot: number | null } | null> {
  try {
    let presence = await findOnChain(deps.indexer, deps.client, txHash);
    if (presence && !presence.validityKnown && deps.client.supports('getTransaction')) {
      const found = await deps.client.getTransaction(txHash);
      presence = { slot: presence.slot, height: presence.height, scriptFailed: found.spendsCollaterals === true, validityKnown: typeof found.spendsCollaterals === 'boolean' };
    }
    return presence && presence.validityKnown && !presence.scriptFailed ? { slot: presence.slot } : null;
  } catch (err: unknown) {
    logger.debug({ txHash, error: err instanceof Error ? err.message : String(err) }, 'Lookup gave no answer; the row stays failed');
    return null;
  }
}

/** Ids after `after`, in id order, from one page. */
async function page<T extends { id: string }>(read: (db: CapTransaction, after: string) => Promise<T[]>, after: string): Promise<T[]> {
  return runWithoutAmbientTx(() => cds.tx((db) => read(db, after)));
}

export async function recheckFailed(
  deps: FailedRecheckDeps,
  opts: { shouldStop?: () => boolean; onProgress?: (p: FailedRecheckProgress) => void } = {},
): Promise<FailedRecheckProgress> {
  const progress: FailedRecheckProgress = { submissions: 0, requests: 0, jobs: 0, restored: 0 };

  for (let after = ''; ;) {
    if (opts.shouldStop?.()) return progress;
    const rows = await page((db, a) => db.run(SELECT.from(TransactionSubmissions).columns('id', 'txHash')
      .where({ status: 'failed', id: { '>': a } }).orderBy('id').limit(PAGE)) as Promise<Array<{ id: string; txHash: string }>>, after);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      progress.submissions++;
      const found = await onChainWithPassingScripts(deps, row.txHash);
      if (!found) continue;
      const moved = await runWithoutAmbientTx(() => cds.tx((db) => db.run(UPDATE.entity(TransactionSubmissions)
        .set({ status: 'submitted', errorMessage: null, resolution: note(found.slot) }).where({ id: row.id, status: 'failed' }))));
      if (Number(moved) > 0) {
        progress.restored++;
        logger.warn({ submissionId: row.id, txHash: row.txHash }, 'Failed submission is on chain; moved back to submitted');
      }
    }
    opts.onProgress?.({ ...progress });
  }

  for (let after = ''; ;) {
    if (opts.shouldStop?.()) return progress;
    const rows = await page((db, a) => db.run(SELECT.from(SIGNING_REQUESTS)
      .columns('id', 'build_id', 'txBodyHash', 'signedTxCbor', 'signerType', 'signerInfo', 'submission_id')
      .where({ status: 'failed', id: { '>': a } }).and('signedTxCbor is not null').orderBy('id').limit(PAGE)) as Promise<Array<{
        id: string; build_id?: string | null; txBodyHash: string; signedTxCbor: string; signerType?: string | null; signerInfo?: string | null; submission_id?: string | null;
      }>>, after);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      progress.requests++;
      const found = await onChainWithPassingScripts(deps, row.txBodyHash);
      if (!found) continue;
      try {
        const moved = await runWithoutAmbientTx(() => cds.tx(async (db) => {
          const won = await db.run(UPDATE.entity(SIGNING_REQUESTS)
            .set({ status: 'submitted', errorMessage: null, resolution: note(found.slot) }).where({ id: row.id, status: 'failed' }));
          if (Number(won) === 0 || row.submission_id || !row.build_id) return Number(won) > 0;
          // the submission record a submit writes, from the stored bytes
          await deps.indexer.indexVerifiedTransactionSubmission(db as never, {
            signingRequestId: row.id, buildId: row.build_id, fullSignedTxCbor: row.signedTxCbor, txHash: row.txBodyHash,
            verificationResult: getExternalSignerModule().verifyOrThrow(row.signedTxCbor, row.txBodyHash),
            signerType: row.signerType ?? undefined, signerInfo: row.signerInfo ?? undefined,
          });
          return true;
        }));
        if (moved) {
          progress.restored++;
          logger.warn({ signingRequestId: row.id, txHash: row.txBodyHash }, 'Failed signing request is on chain; moved back to submitted');
        }
      } catch (err: unknown) {
        logger.error({ err, signingRequestId: row.id }, 'Failed signing request is on chain but could not be restored');
      }
    }
    opts.onProgress?.({ ...progress });
  }

  // Jobs failed on time or a refusal alone. Back to submitted, the tracker confirms them by depth,
  // and their submission row follows.
  for (let after = ''; ;) {
    if (opts.shouldStop?.()) return progress;
    const rows = await page((db, a) => db.run(SELECT.from(CardanoWalletJobs).columns('ID as id', 'txHash')
      .where({ status: 'failed', errorCode: { in: [JOB_ERROR_CODES.TX_DROPPED, JOB_ERROR_CODES.SUBMIT_REJECTED] }, ID: { '>': a } })
      .and('txHash is not null').orderBy('ID').limit(PAGE)) as Promise<Array<{ id: string; txHash: string }>>, after);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      progress.jobs++;
      const found = await onChainWithPassingScripts(deps, row.txHash);
      if (!found) continue;
      const moved = await runWithoutAmbientTx(() => cds.tx(async (db) => {
        if (!(await reopenFailedJob(db, row.id, note(found.slot)))) return false;
        await db.run(UPDATE.entity(TransactionSubmissions).set({ status: 'submitted', errorMessage: null, resolution: note(found.slot) })
          .where({ txHash: row.txHash, status: 'failed' }));
        return true;
      }));
      if (moved) {
        progress.restored++;
        logger.warn({ jobId: row.id, txHash: row.txHash }, 'Failed wallet job is on chain; moved back to submitted');
      }
    }
    opts.onProgress?.({ ...progress });
  }
  return progress;
}
