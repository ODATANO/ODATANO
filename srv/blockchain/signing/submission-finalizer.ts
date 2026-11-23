import cds, { Request } from '@sap/cds';
import { SubmitOutcomeUnknownError, TransactionAlreadySubmittedError, TransactionValidationError } from '../../utils/errors';
import { detachedTx, runWithoutAmbientTx } from '../../utils/tx-utils';
import { extractTxCacheTargets } from '../../utils/tx-build-helper';
import { getExternalSignerModule } from './external-signer';
import { isExpired, isFinalRefusal, judgeLanding, type LandingClient } from './landing-proof';
import type { CardanoIndexer } from '../cardano-indexer';
import type { CardanoClient } from '../cardano-client';
import { AddressTransactionBuilds, TransactionSubmissions, type TransactionSubmission } from '#cds-models/CardanoTransactionService';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('SubmissionFinalizer');

const SIGNING_REQUESTS = 'odatano.cardano.SigningRequests';

/** An open submit is sent again for this long. After it only the chain is read. */
export const RESUBMIT_WINDOW_MS = 10 * 60_000;
const RECONCILE_INTERVAL_MS = 60_000;

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
  /** When the transaction was first sent; bounds a transaction without an expiry. */
  sentAtMs?: number | null;
}

type SubmissionIndexer = Pick<CardanoIndexer,
  'persistTransactionSubmission' | 'updateSubmissionStatus' | 'dropDuplicateSubmission' | 'invalidateUtxoCacheForTx' | 'findCrawledTransaction'>;
type SubmissionClient = Pick<CardanoClient, 'submitTransaction'> & LandingClient;

interface SubmissionDeps {
  indexer: SubmissionIndexer & Pick<CardanoIndexer, 'indexVerifiedTransactionSubmission'>;
  client: SubmissionClient;
}

// accepted: the node or the chain has the transaction. rejected: it can never land. scriptFailed: it
// landed with failing scripts. unresolved: it can no longer land, nothing shows whether it did.
// unknown: it may still land.
type SubmitOutcome = 'accepted' | 'rejected' | 'scriptFailed' | 'unresolved' | 'unknown';

interface RecordedSubmission {
  id: string;
  signedTxCbor: string;
  txHash: string;
  buildId: string | null;
  sentAtMs: number | null;
}

// Record ids this process is sending right now. The reconciler leaves them alone.
const inFlight = new Set<string>();
// Stale records (no expiry, can still land, key not held here) and when the reconciler reads them next.
const STALE_RECHECK_MS = 60 * 60_000;
const staleUntil = new Map<string, number>();

function noteStale(id: string, txHash: string, unspentInputs: Array<{ txHash: string; outputIndex: number }>): void {
  staleUntil.set(id, Date.now() + STALE_RECHECK_MS);
  logger.warn({ id, txHash, unspentInputs: unspentInputs.map((r) => `${r.txHash}#${r.outputIndex}`) },
    'Transaction without an expiry has not landed and still can; only spending one of its inputs ends it. Read again in an hour');
}

/** Records the reconciler reads only once an hour: no expiry, not landed, an input still unspent. */
export function staleRecordIds(): string[] {
  return [...staleUntil.keys()];
}
// Signing requests whose stored transaction no longer verifies. Reported once, then skipped.
const unverifiable = new Set<string>();

// Lazy require avoids the srv/server.ts <-> this-module import cycle; the app-context
// getters are only needed at runtime.
function server(): typeof import('../../server') {
  return require('../../server') as typeof import('../../server');
}

function liveDeps(): SubmissionDeps {
  return { indexer: server().getCardanoIndexer(), client: server().getCardanoClient() };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Sends the transaction and says what the attempt proves. With send = false only the chain is read,
// unless no backend can look transactions up: then it is sent again, but never past its expiry. A
// refusal ends the record only where it holds for these bytes; `error` is the failed submit.
export async function attemptSubmit(
  signedTxCbor: string,
  txHash: string,
  send: boolean,
  indexer: Pick<CardanoIndexer, 'findCrawledTransaction'>,
  client: SubmissionClient,
  sentAtMs: number | null = null,
): Promise<{ outcome: SubmitOutcome; error?: unknown; finalRefusal?: boolean; unspentInputs?: Array<{ txHash: string; outputIndex: number }> }> {
  const sent = (send || !client.supports('getTransaction')) && !isExpired(signedTxCbor, client.network);
  let error: unknown;
  if (sent) {
    try {
      await client.submitTransaction(signedTxCbor);
      return { outcome: 'accepted' };
    } catch (submitErr: unknown) {
      if (submitErr instanceof TransactionAlreadySubmittedError) return { outcome: 'accepted', error: submitErr };
      error = submitErr;
    }
  }

  const landing = await judgeLanding(signedTxCbor, txHash, { indexer, client }, sentAtMs);
  if (landing.verdict === 'onChain') return { outcome: 'accepted', error };
  if (landing.verdict === 'scriptFailed') return { outcome: 'scriptFailed', error: new TransactionValidationError(landing.reason, error) };
  if (sent && isFinalRefusal(error)) return { outcome: 'rejected', error, finalRefusal: true };
  if (landing.verdict === 'neverLands') return { outcome: 'rejected', error: new TransactionValidationError(landing.reason, error) };
  if (landing.verdict === 'unresolved') return { outcome: 'unresolved', error: new Error(landing.reason) };
  // without an expiry it can still land: open, and the inputs that would let it are named
  if (landing.verdict === 'stale') return { outcome: 'unknown', error: new Error(landing.reason), unspentInputs: landing.unspentInputs };
  return { outcome: 'unknown', error: error ?? new Error(`Transaction ${txHash} is not on chain yet and may still land`) };
}

// Outcomes are written in detached transactions, so no DB lock is held across the network call.
// A refused transaction is marked 'failed' and the error rethrown. Without a verdict the request
// stays 'submitting' for the reconciler and the call throws SubmitOutcomeUnknownError.
export async function submitAndFinalize(
  SigningRequests: unknown,
  params: FinalizeParams,
  afterFinalize?: (db: cds.Transaction) => Promise<void>,
  send = true,
  { indexer, client }: SubmissionDeps = liveDeps(),
): Promise<unknown> {

  const finalizeSubmitted = () => detachedTx('finalize transaction submission', async (db: cds.Transaction) => {
    // Only the caller that moves the request to 'submitted' writes the records.
    const won = await db.run(
      UPDATE.entity(SigningRequests as never).set({ status: 'submitted', errorMessage: null })
        .where({ id: params.signingRequestId, status: { in: ['submitting', 'failed'] } })
    );
    if (won === 0) {
      const request = await db.run(
        SELECT.one.from(SigningRequests as never).columns('submission_id').where({ id: params.signingRequestId })
      ) as { submission_id?: string | null } | undefined;
      return db.run(SELECT.one.from(TransactionSubmissions).where({ id: request?.submission_id ?? null }));
    }

    const submission = await indexer.indexVerifiedTransactionSubmission(db as never, params);
    if (afterFinalize) await afterFinalize(db);
    // Best effort; must never roll back the durable submission record.
    try {
      await indexer.invalidateUtxoCacheForTx(db as never, extractTxCacheTargets(params.fullSignedTxCbor));
    } catch (invalidateErr: unknown) {
      logger.warn(`UTxO cache invalidation failed (submit unaffected): ${messageOf(invalidateErr)}`);
    }
    return submission;
  });

  inFlight.add(params.signingRequestId);
  try {
    const { outcome, error, unspentInputs } = await attemptSubmit(params.fullSignedTxCbor, params.txHash, send, indexer, client, params.sentAtMs ?? null);
    if (unspentInputs) noteStale(params.signingRequestId, params.txHash, unspentInputs);
    else staleUntil.delete(params.signingRequestId);

    if (outcome === 'unknown') {
      logger.warn({ signingRequestId: params.signingRequestId, txHash: params.txHash, error: messageOf(error) },
        'Submit got no verdict; the signing request stays submitting');
      throw new SubmitOutcomeUnknownError(params.txHash, error);
    }

    if (outcome === 'unresolved') {
      try {
        await detachedTx('mark signing request unresolved', (db: cds.Transaction) => db.run(
          UPDATE.entity(SigningRequests as never).set({ status: 'unresolved', errorMessage: messageOf(error) })
            .where({ id: params.signingRequestId, status: 'submitting' })
        ));
      } catch (markErr: unknown) {
        logger.error({ err: markErr, signingRequestId: params.signingRequestId }, 'Could not mark signing request unresolved');
      }
      logger.error({ signingRequestId: params.signingRequestId, txHash: params.txHash, error: messageOf(error) },
        'Submit outcome cannot be decided any more; the signing request is unresolved and needs an operator');
      throw new SubmitOutcomeUnknownError(params.txHash, error);
    }

    if (outcome === 'rejected' || outcome === 'scriptFailed') {
      try {
        await detachedTx('mark signing request failed', async (db: cds.Transaction) => {
          const marked = await db.run(
            UPDATE.entity(SigningRequests as never).set({ status: 'failed', errorMessage: messageOf(error) })
              .where({ id: params.signingRequestId, status: 'submitting' })
          );
          // it landed and spent the collateral: the submission record keeps that on file
          if (outcome !== 'scriptFailed' || Number(marked) === 0) return;
          const row = await indexer.persistTransactionSubmission(db as never, {
            signedTxCbor: params.fullSignedTxCbor, txHash: params.txHash, buildId: params.buildId || null,
          });
          await indexer.updateSubmissionStatus(db as never, row.id!, 'failed', messageOf(error));
          await db.run(UPDATE.entity(SigningRequests as never).set({ submission_id: row.id }).where({ id: params.signingRequestId }));
        });
      } catch (markErr: unknown) {
        logger.error({ err: markErr, signingRequestId: params.signingRequestId },
          'Could not durably mark signing request failed after submit error');
      }
      throw error;
    }

    if (error) {
      logger.info({ signingRequestId: params.signingRequestId, txHash: params.txHash },
        'Submit failed but the node or the chain has the transaction; finalizing as submitted');
    }
    return await finalizeSubmitted();
  } finally {
    inFlight.delete(params.signingRequestId);
  }
}

// Commits what one attempt proves for a recorded submission. Returns only when the node accepted
// the transaction now. A transaction it already had ends as 409, like a resubmit.
async function settleRecorded(row: RecordedSubmission, send: boolean, indexer: SubmissionIndexer, client: SubmissionClient): Promise<void> {
  inFlight.add(row.id);
  try {
    const { outcome, error, unspentInputs } = await attemptSubmit(row.signedTxCbor, row.txHash, send, indexer, client, row.sentAtMs);
    if (unspentInputs) noteStale(row.id, row.txHash, unspentInputs);
    else staleUntil.delete(row.id);

    // every write changes only a row still pending: another instance may have settled it meanwhile
    if (outcome === 'accepted' && error === undefined) {
      logger.info({ txHash: row.txHash }, 'Transaction submitted to blockchain');
      await detachedTx('record submission outcome', async (db) => {
        await indexer.updateSubmissionStatus(db as never, row.id, 'submitted', undefined, 'pending');
        // best-effort: a cache failure must not roll back the submitted status
        try {
          const senders = row.buildId
            ? await db.run(SELECT.from(AddressTransactionBuilds).columns('address_address').where({ txBuild_id: row.buildId })) as Array<{ address_address?: string | null }>
            : [];
          await indexer.invalidateUtxoCacheForTx(db as never, extractTxCacheTargets(row.signedTxCbor),
            senders.map(r => r.address_address).filter((a): a is string => !!a));
        } catch (invalidateErr: unknown) {
          logger.warn(`UTxO cache invalidation failed (submit unaffected): ${messageOf(invalidateErr)}`);
        }
      });
      return;
    }

    const errMsg = messageOf(error);
    try {
      await detachedTx('record submission outcome', async (db) => {
        // the row stays pending with the last error; a refusal ends only a row that is still pending
        if (outcome === 'unknown') return indexer.updateSubmissionStatus(db as never, row.id, 'pending', errMsg, 'pending');
        if (outcome === 'unresolved') return indexer.updateSubmissionStatus(db as never, row.id, 'unresolved', errMsg, 'pending');
        if (outcome === 'rejected' || outcome === 'scriptFailed') return indexer.updateSubmissionStatus(db as never, row.id, 'failed', errMsg, 'pending');
        // A resubmit keeps one row per transaction: its own row goes when an earlier one exists.
        if (await indexer.dropDuplicateSubmission(db as never, row.id, row.txHash)) return;
        return indexer.updateSubmissionStatus(db as never, row.id, 'submitted', undefined, 'pending');
      });
    } catch (markErr: unknown) {
      logger.error({ err: markErr, submissionId: row.id }, 'Could not record the submission outcome after a submit error');
    }

    if (outcome === 'unknown') {
      logger.warn({ txHash: row.txHash, error: errMsg }, 'Submit got no verdict; the submission stays pending');
      throw new SubmitOutcomeUnknownError(row.txHash, error);
    }
    if (outcome === 'unresolved') {
      logger.error({ txHash: row.txHash, error: errMsg }, 'Submission outcome cannot be decided any more; it is unresolved and needs an operator');
      throw new SubmitOutcomeUnknownError(row.txHash, error);
    }
    if (outcome === 'rejected' || outcome === 'scriptFailed') {
      logger.error({ txHash: row.txHash, error: errMsg }, 'Transaction submission failed');
      throw error;
    }
    throw error instanceof TransactionAlreadySubmittedError ? error : new TransactionAlreadySubmittedError(row.txHash, error);
  } finally {
    inFlight.delete(row.id);
  }
}

// 'pending' commits first and the network call runs outside any DB tx.
// The final status commits on its own and survives a rethrown error.
export async function submitRecorded(
  params: { signedTxCbor: string; txHash: string; buildId: string | null },
  indexer: SubmissionIndexer = server().getCardanoIndexer(),
  client: SubmissionClient = server().getCardanoClient(),
): Promise<TransactionSubmission> {
  const record = await detachedTx('record transaction submission', (db) => indexer.persistTransactionSubmission(db as never, params));
  await settleRecorded({ id: record.id!, ...params, sentAtMs: Date.now() }, true, indexer, client);
  return { ...record, status: 'submitted' };
}

// Submits only after the caller's transaction has committed and released its connection.
// If the caller rolls back, 'succeeded' never fires and nothing was claimed.
export function scheduleDeferredSubmit(req: Request, SigningRequests: unknown, params: FinalizeParams): void {
  req.on('succeeded', () => {
    // from the commit on the row is visible to the reconciler
    inFlight.add(params.signingRequestId);
    setImmediate(() => {
      runWithoutAmbientTx(() => submitAndFinalize(SigningRequests, params))
        .then(() => {
          logger.info({ signingRequestId: params.signingRequestId, txHash: params.txHash }, 'Deferred submit finalized');
        })
        .catch((err: unknown) => {
          // submitAndFinalize already recorded the outcome and logged an open one.
          if (err instanceof SubmitOutcomeUnknownError) return;
          logger.error({ err, signingRequestId: params.signingRequestId },
            'Deferred submit failed (signing request marked failed)');
        });
    });
  });
}

/** Milliseconds of a stored timestamp, or null when there is none. */
function msOrNull(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function olderThanWindow(sinceMs: number): boolean {
  return Number.isFinite(sinceMs) && Date.now() - sinceMs > RESUBMIT_WINDOW_MS;
}

// Resolves signing requests left at 'submitting' and submissions left at 'pending': after a crash
// or a submit without a verdict. Runs at boot and on a timer. Returns the number of records tried.
export async function redriveInterruptedSubmissions(deps: SubmissionDeps = liveDeps()): Promise<number> {
  const requests = (await detachedTx('load open signing requests', (db: cds.Transaction) =>
    db.run(
      SELECT.from(SIGNING_REQUESTS)
        .columns('id', 'build_id', 'txBodyHash', 'signedTxCbor', 'signerType', 'signerInfo', 'signedAt', 'createdAt')
        .where({ status: 'submitting' })
        .and('signedTxCbor is not null')
    )
  ) as Array<{
    id: string; build_id?: string | null; txBodyHash: string; signedTxCbor: string;
    signerType?: string | null; signerInfo?: string | null; signedAt?: string | null; createdAt?: string | null;
  }>).filter((row) => !inFlight.has(row.id) && !unverifiable.has(row.id) && (staleUntil.get(row.id) ?? 0) <= Date.now());

  const submissions = (await detachedTx('load open submissions', (db: cds.Transaction) =>
    db.run(
      SELECT.from(TransactionSubmissions)
        .columns('id', 'build_id', 'txHash', 'signedTxCbor', 'submittedAt')
        .where({ status: 'pending' })
    )
  ) as Array<{ id: string; build_id?: string | null; txHash: string; signedTxCbor: string; submittedAt?: number | string | null }>)
    .filter((row) => !inFlight.has(row.id) && (staleUntil.get(row.id) ?? 0) <= Date.now());

  if (!requests.length && !submissions.length) return 0;
  logger.info(`Resolving ${requests.length} open signing request(s) and ${submissions.length} open submission(s)`);

  let attempted = 0;
  for (const row of requests) {
    let verificationResult: FinalizeParams['verificationResult'];
    try {
      // Re-verify from the persisted CBOR to recompute the witness metadata the finalize step persists.
      verificationResult = getExternalSignerModule().verifyOrThrow(row.signedTxCbor, row.txBodyHash);
    } catch (err: unknown) {
      unverifiable.add(row.id);
      logger.error({ err, signingRequestId: row.id }, 'Stored signed transaction no longer verifies; the request stays submitting for inspection');
      continue;
    }
    attempted++;
    const send = !olderThanWindow(Date.parse(String(row.signedAt ?? row.createdAt ?? '')));
    try {
      await submitAndFinalize(SIGNING_REQUESTS, {
        signingRequestId: row.id,
        buildId: row.build_id ?? '',
        fullSignedTxCbor: row.signedTxCbor,
        txHash: row.txBodyHash,
        verificationResult,
        signerType: row.signerType ?? undefined,
        signerInfo: row.signerInfo ?? undefined,
        sentAtMs: msOrNull(row.signedAt ?? row.createdAt),
      }, undefined, send, deps);
      logger.info({ signingRequestId: row.id, txHash: row.txBodyHash }, 'Open signing request resolved as submitted');
    } catch (err: unknown) {
      if (err instanceof SubmitOutcomeUnknownError) continue;
      logger.error({ err, signingRequestId: row.id }, 'Open signing request resolved as failed');
    }
  }

  for (const row of submissions) {
    attempted++;
    const send = !olderThanWindow(Number(row.submittedAt) * 1000);
    try {
      const sentAtMs = row.submittedAt == null ? null : Number(row.submittedAt) * 1000;
      await settleRecorded({ id: row.id, signedTxCbor: row.signedTxCbor, txHash: row.txHash, buildId: row.build_id ?? null, sentAtMs },
        send, deps.indexer, deps.client);
      logger.info({ submissionId: row.id, txHash: row.txHash }, 'Open submission resolved as submitted');
    } catch (err: unknown) {
      if (err instanceof SubmitOutcomeUnknownError) continue;
      const level = err instanceof TransactionAlreadySubmittedError ? 'info' : 'error';
      logger[level]({ submissionId: row.id, txHash: row.txHash, error: messageOf(err) }, 'Open submission resolved');
    }
  }
  return attempted;
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconcileRunning = false;

/** Starts the periodic pass over open signing requests and submissions. Idempotent. */
export function startSubmissionReconciler(): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    runWithoutAmbientTx(() => redriveInterruptedSubmissions())
      .catch((err: unknown) => logger.error({ err }, 'Submission reconcile pass failed'))
      .finally(() => { reconcileRunning = false; });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

export function stopSubmissionReconciler(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}
