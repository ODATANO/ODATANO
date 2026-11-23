import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { createHash, randomUUID } from 'node:crypto';
import { CardanoWalletJobs, CardanoWorkerWallets } from '#cds-models/odatano/cardano';
import { parseJson, stringifyJson } from '../../utils/deep-json';
import { BackendError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { optionalNum, requiredNum, timestamp } from '../../utils/row-values';
import { tryAcquireLease, renewLease, releaseLease, type LeaseRow } from '../../utils/lease';

const { SELECT, INSERT, UPDATE } = cds.ql;
const logger = cds.log('CardanoWalletWorker');

// Job flow: pending, building, submitting, submitted, confirmed. Each state can also end in failed.
// submitting stores the signed CBOR before the network call. Transitions are conditional UPDATEs.
// insertJob uses the caller's tx, since a separate one would deadlock on the SQLite write lock.

/** Per-wallet DB lease TTL. */
export const WORKER_LEASE_TTL_MS = 15_000;

export const JOB_ERROR_CODES = {
  PROCESS_RESTART: 'PROCESS_RESTART',
  TX_DROPPED: 'TX_DROPPED',
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  CANCELLED: 'CANCELLED',
  /** Reconciliation proved the tx is not on-chain and the node rejects it for good. */
  SUBMIT_REJECTED: 'SUBMIT_REJECTED',
  /** The tx is on chain with failing scripts: only its collateral was spent, the payment did not happen. */
  SCRIPT_FAILED: 'SCRIPT_FAILED',
  /** The tx can no longer land and nothing shows whether it did; an operator resolves the job. */
  OUTCOME_UNRESOLVED: 'OUTCOME_UNRESOLVED',
  /** An operator resolved an unresolved job as failed after reading the chain. */
  RESOLVED_FAILED: 'RESOLVED_FAILED',
  /** A confirmed self-transfer spent an input of the job's transaction, which had no expiry; it can never land. */
  INVALIDATED: 'INVALIDATED',
} as const;

export type WalletJobStatusValue =
  'pending' | 'building' | 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'cancelled' | 'unresolved';
export type WalletJobKindValue = 'simpleAda' | 'metadata' | 'multiAsset' | 'mint' | 'plutusSpend' | 'payout' | 'submitSigned';
export type WorkerSignerTypeValue = 'hsm' | 'software';

export const WALLET_JOB_KINDS: readonly WalletJobKindValue[] =
  ['simpleAda', 'metadata', 'multiAsset', 'mint', 'plutusSpend', 'payout', 'submitSigned'];

/** Normalized, number-typed view of a job row. */
export interface WalletJobRow {
  ID: string;
  walletId: string;
  kind: WalletJobKindValue;
  status: WalletJobStatusValue;
  idempotencyKey: string | null;
  request: string | null;
  priority: number;
  notBefore: string | null;
  attempt: number;
  maxAttempts: number;
  txHash: string | null;
  unsignedTxCbor: string | null;
  signedTxCbor: string | null;
  fee: number | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  confirmedSlot: number | null;
  confirmedHeight: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string | null;
  createdBy: string | null;
  finishedAt: string | null;
  resolution: string | null;
  invalidationTxHash: string | null;
  invalidationTxCbor: string | null;
  invalidationSentAt: string | null;
  spendsNoWalletUtxo: boolean;
}

/** Normalized view of a worker-wallet row. */
export interface WorkerWalletRow {
  walletId: string;
  signerType: WorkerSignerTypeValue;
  address: string | null;
  publicKeyHash: string | null;
  requiresRole: string | null;
  enabled: boolean;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastJobAt: string | null;
  jobsConfirmed: number;
  jobsFailed: number;
}

function toJobRow(row: Record<string, unknown>): WalletJobRow {
  return {
    ID: String(row.ID),
    walletId: String(row.walletId),
    kind: row.kind as WalletJobKindValue,
    status: row.status as WalletJobStatusValue,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    request: (row.request as string) ?? null,
    priority: requiredNum(row.priority, 100),
    notBefore: timestamp(row.notBefore),
    attempt: requiredNum(row.attempt),
    maxAttempts: requiredNum(row.maxAttempts, 3),
    txHash: (row.txHash as string) ?? null,
    unsignedTxCbor: (row.unsignedTxCbor as string) ?? null,
    signedTxCbor: (row.signedTxCbor as string) ?? null,
    fee: optionalNum(row.fee),
    submittedAt: timestamp(row.submittedAt),
    confirmedAt: timestamp(row.confirmedAt),
    confirmedSlot: optionalNum(row.confirmedSlot),
    confirmedHeight: optionalNum(row.confirmedHeight),
    errorCode: (row.errorCode as string) ?? null,
    errorMessage: (row.errorMessage as string) ?? null,
    createdAt: timestamp(row.createdAt),
    createdBy: (row.createdBy as string) ?? null,
    finishedAt: timestamp(row.finishedAt),
    resolution: (row.resolution as string) ?? null,
    invalidationTxHash: (row.invalidationTxHash as string) ?? null,
    invalidationTxCbor: (row.invalidationTxCbor as string) ?? null,
    invalidationSentAt: timestamp(row.invalidationSentAt),
    spendsNoWalletUtxo: row.spendsNoWalletUtxo === true,
  };
}

function toWalletRow(row: Record<string, unknown>): WorkerWalletRow {
  return {
    walletId: String(row.walletId),
    signerType: row.signerType as WorkerSignerTypeValue,
    address: (row.address as string) ?? null,
    publicKeyHash: (row.publicKeyHash as string) ?? null,
    requiresRole: (row.requiresRole as string) ?? null,
    enabled: row.enabled !== false,
    leaseOwner: (row.leaseOwner as string) ?? null,
    leaseUntil: timestamp(row.leaseUntil),
    lastJobAt: timestamp(row.lastJobAt),
    jobsConfirmed: requiredNum(row.jobsConfirmed),
    jobsFailed: requiredNum(row.jobsFailed),
  };
}

// Re-exported from the shared tx-utils so existing imports keep working.
export { runWithoutAmbientTx } from '../../utils/tx-utils';

// ---- Job creation ------------------------------------------------------------

export interface InsertJobArgs {
  walletId: string;
  kind: WalletJobKindValue;
  /** Build-action payload as a JSON string (already validated + size-limited). */
  request: string;
  idempotencyKey?: string | null;
  priority?: number;
  notBefore?: string | null;
  maxAttempts?: number;
  createdBy?: string | null;
}

export interface InsertJobResult {
  jobId: string;
  status: WalletJobStatusValue;
  /** True when an idempotent retry matched the job that holds the key. */
  deduplicated: boolean;
}

/** Unique-constraint error on SQLite or HANA. Unknown errors must propagate, or the job is dropped silently. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, errno, message } = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (String(code ?? '').includes('SQLITE_CONSTRAINT')) return true;
  if (String(code ?? '') === '301' || String(errno ?? '') === '301') return true;
  const text = String(message ?? '').toLowerCase();
  return text.includes('unique constraint') || text.includes('duplicate key');
}

/** Dedup key scoped to the submitting user. An owned key is hashed with an `o:` prefix, an owner-less key stays raw. */
export function dedupKeyFor(owner: string | null | undefined, idempotencyKey: string): string {
  const scope = owner?.trim() ?? '';
  if (!scope) return idempotencyKey;
  return `o:${createHash('sha256').update(`${scope}\0${idempotencyKey}`).digest('hex').slice(0, 48)}`;
}

/** Request JSON with sorted object keys, so two spellings of one request compare equal. */
function canonicalRequest(json: string | null): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v === null || typeof v !== 'object') return v;
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, value]) => [key, sorted(value)]));
  };
  if (json == null) return '';
  try {
    return stringifyJson(sorted(parseJson(json)));
  } catch {
    return json;
  }
}

/** The holder of the key answers a retry of the same request. Another request, wallet or kind under the key is a 409. */
function answerFromHolder(holder: WalletJobRow, args: InsertJobArgs): InsertJobResult {
  const same = holder.walletId === args.walletId && holder.kind === args.kind
    && canonicalRequest(holder.request) === canonicalRequest(args.request);
  if (!same) {
    throw new BackendError(
      `idempotencyKey "${args.idempotencyKey}" belongs to job ${holder.ID} with a different request`,
      409, ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, undefined, undefined, 'idempotencyKey',
    );
  }
  return { jobId: holder.ID, status: holder.status, deduplicated: true };
}

async function readDedupHolder(db: CapTransaction, dedupKey: string): Promise<WalletJobRow | null> {
  const row = await db.run(SELECT.one.from(CardanoWalletJobs).where({ dedupKey }));
  return row ? toJobRow(row as Record<string, unknown>) : null;
}

/** Inserts a job, or returns the job that holds the dedup key. The UNIQUE constraint settles races. */
export async function insertJob(db: CapTransaction, args: InsertJobArgs): Promise<InsertJobResult> {
  const idempotencyKey = args.idempotencyKey ?? null;
  // The claim is per principal: the same key from another owner is another job.
  const claim = idempotencyKey ? dedupKeyFor(args.createdBy, idempotencyKey) : null;

  if (claim) {
    // A failed holder kept its key because its transaction may have been sent.
    const holder = await readDedupHolder(db, claim);
    if (holder) {
      if (holder.status !== 'cancelled') return answerFromHolder(holder, args);
      // Defensive: a cancelled job frees its key, so this row would block retries forever.
      logger.warn(`Job ${holder.ID} is cancelled but still held idempotency key "${idempotencyKey}", releasing it`);
      await releaseDedupClaim(db, holder.ID);
    }
  }

  const jobId = randomUUID();
  const entry = {
    ID: jobId,
    walletId: args.walletId,
    kind: args.kind,
    status: 'pending' as const,
    idempotencyKey,
    // No key → the row's own ID, so keyless jobs never contend for the constraint.
    dedupKey: claim ?? jobId,
    request: args.request,
    priority: args.priority ?? 100,
    notBefore: args.notBefore ?? null,
    attempt: 0,
    maxAttempts: args.maxAttempts ?? 3,
    createdAt: new Date().toISOString(),
    createdBy: args.createdBy ?? null,
  };

  try {
    await db.run(INSERT.into(CardanoWalletJobs).entries(entry));
  } catch (err) {
    // Lost the race to another transaction with the same key. Return its job.
    if (!claim || !isUniqueViolation(err)) throw err;
    const winner = await readDedupHolder(db, claim);
    if (!winner) throw err; // constraint fired for another reason, do not mask it
    logger.info(`Concurrent submission for idempotency key "${idempotencyKey}", returning job ${winner.ID}`);
    return answerFromHolder(winner, args);
  }

  return { jobId, status: 'pending', deduplicated: false };
}

// ---- Job reads -----------------------------------------------------------------

export async function getJobById(db: CapTransaction, jobId: string): Promise<WalletJobRow | null> {
  const row = await db.run(SELECT.one.from(CardanoWalletJobs).where({ ID: jobId }));
  return row ? toJobRow(row as Record<string, unknown>) : null;
}

/** A due job's place in the dispatch order, without its payload. */
export interface DueJobRef {
  ID: string;
  walletId: string;
  priority: number;
  createdAt: string | null;
}

/** The next due pending job of a wallet by priority and age, or null. One row per call, whatever the queue holds. */
export async function findNextDueJob(db: CapTransaction, walletId: string, now = new Date()): Promise<DueJobRef | null> {
  const due = { notBefore: null, or: { notBefore: { '<=': now.toISOString() } } };
  const row = await db.run(
    SELECT.one.from(CardanoWalletJobs).columns('ID', 'walletId', 'priority', 'createdAt')
      .where({ walletId, status: 'pending', and: due })
      .orderBy('priority', 'createdAt'),
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ID: String(row.ID), walletId: String(row.walletId), priority: requiredNum(row.priority, 100), createdAt: timestamp(row.createdAt) };
}

/** Number of jobs in a status. */
export async function countJobs(db: CapTransaction, status: WalletJobStatusValue): Promise<number> {
  const row = await db.run(SELECT.one.from(CardanoWalletJobs).columns('count(*) as n').where({ status })) as { n?: number | string } | undefined;
  return Number(row?.n ?? 0);
}

/** Number of pending jobs, due or not. */
export function countPendingJobs(db: CapTransaction): Promise<number> {
  return countJobs(db, 'pending');
}

/** All jobs awaiting confirmation (used by the tracker on start/recovery). */
export async function findSubmittedJobs(db: CapTransaction): Promise<WalletJobRow[]> {
  const rows = await db.run(
    SELECT.from(CardanoWalletJobs).where({ status: 'submitted' }),
  ) as Record<string, unknown>[];
  return (rows ?? []).map(toJobRow);
}

/** Jobs of a wallet whose transaction an invalidating self-transfer is spending around. */
export async function findInvalidatingJobs(db: CapTransaction, walletId: string): Promise<WalletJobRow[]> {
  const rows = await db.run(
    SELECT.from(CardanoWalletJobs)
      .where({ walletId, status: { in: ['submitting', 'submitted'] }, invalidationTxHash: { '!=': null } }),
  ) as Record<string, unknown>[];
  return (rows ?? []).map(toJobRow);
}

// Whether the wallet has a job in flight (building, submitting or submitted). A job whose transaction
// spends no UTxO the wallet holds cannot take the wallet funds, so it does not hold the queue.
export async function walletHasActiveJob(db: CapTransaction, walletId: string): Promise<boolean> {
  // a wallet has at most a few jobs in flight, so they are filtered here
  const rows = await db.run(
    SELECT.from(CardanoWalletJobs).columns('ID', 'spendsNoWalletUtxo').where({ walletId, status: { in: ['building', 'submitting', 'submitted'] } }),
  ) as Array<{ spendsNoWalletUtxo?: boolean | null }> | undefined;
  return (rows ?? []).some((r) => r.spendsNoWalletUtxo !== true);
}

/** Marks a job whose transaction spends no UTxO the wallet holds, so it no longer holds the wallet queue. */
export async function markSpendsNoWalletUtxo(db: CapTransaction, jobId: string): Promise<boolean> {
  const affected = await db.run(
    UPDATE.entity(CardanoWalletJobs).set({ spendsNoWalletUtxo: true }).where({ ID: jobId, status: { in: ['submitting', 'submitted'] } }),
  );
  return Number(affected) > 0;
}

/** Oldest submitting row of a wallet without a live lease. Its submit outcome is unknown and needs a chain check. */
export async function findOrphanedSubmittingJob(
  db: CapTransaction,
  walletId: string,
  now = new Date(),
): Promise<WalletJobRow | null> {
  const wallet = await readWallet(db, walletId);
  if (walletLeaseHeld(wallet, now)) return null;
  const row = await db.run(
    SELECT.one.from(CardanoWalletJobs).where({ walletId, status: 'submitting' }).orderBy('createdAt'),
  );
  return row ? toJobRow(row as Record<string, unknown>) : null;
}

// ---- Guarded transitions ---------------------------------------------------------

/** Frees the idempotency key by pointing dedupKey at the job ID. */
export async function releaseDedupClaim(db: CapTransaction, jobId: string): Promise<void> {
  await db.run(UPDATE.entity(CardanoWalletJobs).set({ dedupKey: jobId }).where({ ID: jobId }));
}

/** True only when this call made the transition. That caller owns the stats bump and the terminal event. */
async function guardedTransition(
  db: CapTransaction,
  jobId: string,
  fromStatuses: WalletJobStatusValue[],
  set: Record<string, unknown>,
): Promise<boolean> {
  const affected = await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set(set)
      .where({ ID: jobId, status: { in: fromStatuses } }),
  );
  const n = typeof affected === 'number' ? affected : Number(affected);
  if (Number.isFinite(n)) return n > 0;
  // Non-numeric return: the row is in the target state and could not have been there before.
  const row = await getJobById(db, jobId);
  return row?.status === set.status && !fromStatuses.includes(set.status as WalletJobStatusValue);
}

/** pending → building. Increments the attempt counter. Returns false when lost. */
export async function markBuilding(db: CapTransaction, jobId: string, attempt: number): Promise<boolean> {
  return guardedTransition(db, jobId, ['pending'], { status: 'building', attempt });
}

/** Stores the signed tx before the network call, so the exact bytes survive a crash. submittedAt is the attempt time. */
export async function markSubmitting(
  db: CapTransaction,
  jobId: string,
  artifacts: { txHash: string; unsignedTxCbor: string | null; signedTxCbor: string; fee: string | number | null },
): Promise<boolean> {
  return guardedTransition(db, jobId, ['building'], {
    status: 'submitting',
    txHash: artifacts.txHash,
    unsignedTxCbor: artifacts.unsignedTxCbor,
    signedTxCbor: artifacts.signedTxCbor,
    fee: artifacts.fee,
    submittedAt: new Date().toISOString(),
  });
}

/** submitting → submitted (accepted by a backend or found on-chain). Re-asserts only the hash. */
export async function markSubmitted(db: CapTransaction, jobId: string, txHash: string): Promise<boolean> {
  return guardedTransition(db, jobId, ['submitting'], { status: 'submitted', txHash });
}

/** Requeues a building job after a transient error. Never a submitting job, since a rebuild could pay twice. */
export async function requeueForRetry(
  db: CapTransaction,
  jobId: string,
  err: unknown,
  notBefore?: string,
): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['building'], {
    status: 'pending',
    errorMessage: message.slice(0, 500),
    ...(notBefore ? { notBefore } : {}),
  });
}

/** Record where the submitted tx was seen on-chain (not yet at depth). */
export async function recordConfirmationPoint(
  db: CapTransaction,
  jobId: string,
  point: { slot: number | null; height: number | null },
): Promise<void> {
  await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set({ confirmedSlot: point.slot, confirmedHeight: point.height })
      .where({ ID: jobId, status: 'submitted' }),
  );
}

/** A rollback invalidated the recorded confirmation point. */
export async function clearConfirmationPoint(db: CapTransaction, jobId: string): Promise<void> {
  await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set({ confirmedSlot: null, confirmedHeight: null })
      .where({ ID: jobId, status: 'submitted' }),
  );
}

/** submitted → confirmed (depth reached). */
export async function markConfirmed(db: CapTransaction, jobId: string): Promise<boolean> {
  const now = new Date().toISOString();
  return guardedTransition(db, jobId, ['submitted'], {
    status: 'confirmed',
    confirmedAt: now,
    finishedAt: now,
    errorCode: null,
    errorMessage: null,
  });
}

/** Fails a job that never sent a transaction and frees its key for the caller's retry. */
export async function markFailed(db: CapTransaction, jobId: string, code: string, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['pending', 'building'], {
    status: 'failed',
    errorCode: code.slice(0, 50),
    errorMessage: message.slice(0, 500),
    finishedAt: new Date().toISOString(),
    dedupKey: jobId,
  });
}

// The signed bytes may still reach the chain, so the key stays: a retry gets this job, not a second payment.
export async function markFailedAfterSend(db: CapTransaction, jobId: string, code: string, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['submitting', 'submitted'], {
    status: 'failed',
    errorCode: code.slice(0, 50),
    errorMessage: message.slice(0, 500),
    finishedAt: new Date().toISOString(),
  });
}

// Past the last moment its transaction could land, with nothing showing whether it did. The key
// stays, polling stops and the wallet queue goes on; an operator resolves the job.
export async function markUnresolved(db: CapTransaction, jobId: string, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['submitting', 'submitted'], {
    status: 'unresolved',
    errorCode: JOB_ERROR_CODES.OUTCOME_UNRESOLVED,
    errorMessage: message.slice(0, 500),
    finishedAt: new Date().toISOString(),
  });
}

// Stores the signed self-transfer before it is sent, so its bytes survive a crash. A later one
// replaces an earlier one that can no longer land. `previous` is the hash the caller read: when
// another instance stored one meanwhile, nothing is written.
export async function recordInvalidation(
  db: CapTransaction, jobId: string, invalidation: { txHash: string; signedTxCbor: string }, previous: string | null = null,
): Promise<boolean> {
  const affected = await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set({ invalidationTxHash: invalidation.txHash, invalidationTxCbor: invalidation.signedTxCbor, invalidationSentAt: new Date().toISOString() })
      .where({ ID: jobId, status: { in: ['submitting', 'submitted'] }, invalidationTxHash: previous }),
  );
  return Number(affected) > 0;
}

// A job an earlier version failed on time or a refusal alone, whose transaction is on chain: back to
// submitted, so the tracker confirms it by depth. The key it kept stays with it.
export async function reopenFailedJob(db: CapTransaction, jobId: string, resolution: string): Promise<boolean> {
  return guardedTransition(db, jobId, ['failed'], {
    status: 'submitted', errorCode: null, errorMessage: null, finishedAt: null, resolution: resolution.slice(0, 500),
  });
}

/** unresolved → confirmed or failed, as an operator read it on the chain. The key stays either way. */
export async function resolveUnresolvedJob(db: CapTransaction, jobId: string, outcome: 'confirmed' | 'failed', resolution: string): Promise<boolean> {
  const now = new Date().toISOString();
  return guardedTransition(db, jobId, ['unresolved'], outcome === 'confirmed'
    ? { status: 'confirmed', confirmedAt: now, finishedAt: now, errorCode: null, errorMessage: null, resolution: resolution.slice(0, 500) }
    : { status: 'failed', finishedAt: now, errorCode: JOB_ERROR_CODES.RESOLVED_FAILED, resolution: resolution.slice(0, 500) });
}

/** pending → cancelled. Only pending jobs are cancellable (the tx may otherwise reach the chain). */
export async function markCancelled(db: CapTransaction, jobId: string): Promise<boolean> {
  return guardedTransition(db, jobId, ['pending'], {
    status: 'cancelled',
    errorCode: JOB_ERROR_CODES.CANCELLED,
    finishedAt: new Date().toISOString(),
    dedupKey: jobId, // free the idempotency key for the caller's retry
  });
}

// ---- Crash recovery -----------------------------------------------------------

export interface RecoveryResult {
  /** `building` rows flipped to failed (never signed+stored, so never submitted). */
  failedBuilding: number;
  /** `submitted` rows for the confirmation tracker. The chain decides. */
  submittedToReconcile: WalletJobRow[];
  /** `submitting` rows with an unknown outcome. The dispatch loop reconciles them. */
  submittingToReconcile: WalletJobRow[];
}

/** True when the wallet's lease is currently held (unexpired) by SOME instance. */
function walletLeaseHeld(wallet: WorkerWalletRow | null, now: Date): boolean {
  if (!wallet?.leaseOwner || !wallet.leaseUntil) return false;
  const deadline = Date.parse(wallet.leaseUntil);
  return Number.isFinite(deadline) && deadline > now.getTime();
}

/** Fails orphaned building rows of a wallet without a live lease. Such rows were never sent. */
export async function failOrphanedBuildingJobs(
  db: CapTransaction,
  walletId: string,
  now = new Date(),
): Promise<number> {
  const wallet = await readWallet(db, walletId);
  if (walletLeaseHeld(wallet, now)) return 0;
  const building = await db.run(
    SELECT.from(CardanoWalletJobs).columns('ID').where({ walletId, status: 'building' }),
  ) as Array<{ ID: string }>;
  if (!building?.length) return 0;
  // Per row: each releases its idempotency key to its OWN ID, which one bulk UPDATE cannot express portably.
  for (const { ID } of building) {
    await db.run(
      UPDATE.entity(CardanoWalletJobs)
        .set({
          status: 'failed',
          errorCode: JOB_ERROR_CODES.PROCESS_RESTART,
          errorMessage: 'Job was interrupted before submission (executor died or lost its wallet lease).',
          finishedAt: now.toISOString(),
          dedupKey: ID,
        })
        .where({ ID, status: 'building' }),
    );
  }
  logger.warn(`Wallet ${walletId}: failed ${building.length} orphaned building job(s) as failed:PROCESS_RESTART`);
  return building.length;
}

// Boot recovery. Building rows without a live lease fail with PROCESS_RESTART.
// Submitting rows are checked against the chain, never rebuilt. Submitted rows go to the tracker.
export async function recoverInterruptedJobs(db: CapTransaction, now = new Date()): Promise<RecoveryResult> {
  const building = await db.run(
    SELECT.from(CardanoWalletJobs).columns('ID', 'walletId').where({ status: 'building' }),
  ) as Array<{ ID: string; walletId: string }>;
  let failedBuilding = 0;
  const skippedWallets: string[] = [];
  for (const walletId of new Set((building ?? []).map((row) => row.walletId))) {
    const failed = await failOrphanedBuildingJobs(db, walletId, now);
    if (failed > 0) failedBuilding += failed;
    else skippedWallets.push(walletId);
  }
  if (skippedWallets.length) {
    logger.info(`Recovery skipped building job(s) for wallet(s) ${skippedWallets.join(', ')}, lease still held by a live instance`);
  }
  const submitted = await findSubmittedJobs(db);
  if (submitted.length) {
    logger.info(`${submitted.length} submitted job(s) pending chain reconciliation after restart`);
  }
  const submitting = (await db.run(
    SELECT.from(CardanoWalletJobs).where({ status: 'submitting' }),
  ) as Record<string, unknown>[] ?? []).map(toJobRow);
  if (submitting.length) {
    logger.warn(`${submitting.length} job(s) interrupted around submit. The dispatch loop will reconcile them against the chain (never a rebuild)`);
  }
  return { failedBuilding, submittedToReconcile: submitted, submittingToReconcile: submitting };
}

// ---- Worker wallets --------------------------------------------------------------

/** Idempotently register/refresh a configured wallet row (no key material). */
export async function upsertWalletRegistration(
  db: CapTransaction,
  wallet: { walletId: string; signerType: WorkerSignerTypeValue; address: string; publicKeyHash: string; requiresRole?: string | null },
): Promise<void> {
  const requiresRole = wallet.requiresRole ?? null;
  const existing = await db.run(SELECT.one.from(CardanoWorkerWallets).where({ walletId: wallet.walletId }));
  if (existing) {
    await db.run(UPDATE.entity(CardanoWorkerWallets).set({
      signerType: wallet.signerType,
      address: wallet.address,
      publicKeyHash: wallet.publicKeyHash,
      requiresRole,
    }).where({ walletId: wallet.walletId }));
    return;
  }
  await db.run(INSERT.into(CardanoWorkerWallets).entries({
    walletId: wallet.walletId,
    signerType: wallet.signerType,
    address: wallet.address,
    publicKeyHash: wallet.publicKeyHash,
    requiresRole,
    enabled: true,
    jobsConfirmed: 0,
    jobsFailed: 0,
  }));
}

export async function readWallet(db: CapTransaction, walletId: string): Promise<WorkerWalletRow | null> {
  const row = await db.run(SELECT.one.from(CardanoWorkerWallets).where({ walletId }));
  return row ? toWalletRow(row as Record<string, unknown>) : null;
}

export async function listWallets(db: CapTransaction): Promise<WorkerWalletRow[]> {
  const rows = await db.run(SELECT.from(CardanoWorkerWallets)) as Record<string, unknown>[];
  return (rows ?? []).map(toWalletRow);
}

const walletLease = (walletId: string): LeaseRow => ({ entity: CardanoWorkerWallets, key: { walletId } });

/** Takes a free wallet lease by compare-and-swap with read-back. One instance runs a wallet's jobs at a time. */
export async function tryAcquireWalletLease(
  db: CapTransaction,
  walletId: string,
  owner: string,
  now = new Date(),
  ttlMs = WORKER_LEASE_TTL_MS,
): Promise<boolean> {
  return tryAcquireLease(db, walletLease(walletId), owner, { now, ttlMs }, (row) => toWalletRow(row).enabled);
}

/** Renew/fence the caller's lease. Call before every job-advancing write. */
export async function renewWalletLease(
  db: CapTransaction,
  walletId: string,
  owner: string,
  now = new Date(),
  ttlMs = WORKER_LEASE_TTL_MS,
): Promise<boolean> {
  return renewLease(db, walletLease(walletId), owner, { now, ttlMs });
}

/** Release only the caller's lease; a stale process can never clear a successor. */
export async function releaseWalletLease(db: CapTransaction, walletId: string, owner: string): Promise<void> {
  await releaseLease(db, walletLease(walletId), owner);
}

/** Bump rolling per-wallet stats on a terminal job state. */
export async function bumpWalletStats(
  db: CapTransaction,
  walletId: string,
  outcome: 'confirmed' | 'failed',
): Promise<void> {
  const wallet = await readWallet(db, walletId);
  if (!wallet) return;
  await db.run(UPDATE.entity(CardanoWorkerWallets).set({
    lastJobAt: new Date().toISOString(),
    ...(outcome === 'confirmed'
      ? { jobsConfirmed: wallet.jobsConfirmed + 1 }
      : { jobsFailed: wallet.jobsFailed + 1 }),
  }).where({ walletId }));
}
