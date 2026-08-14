import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { CardanoWalletJobs, CardanoWorkerWallets } from '#cds-models/odatano/cardano';

const { SELECT, INSERT, UPDATE } = cds.ql;
const logger = cds.log('CardanoWalletWorker');

/**
 * Wallet-worker job store (v2.0).
 *
 * Persistence layer for `CardanoWalletJobs` + `CardanoWorkerWallets`. Ports the two
 * hard-won CAP lessons from NIGHTGATE's background-job runner:
 *
 *  1. `insertJob` runs on the CALLER's ambient transaction. CAP wraps every action
 *     handler in its own root tx which may already hold the SQLite write lock; a
 *     detached insert would deadlock against it. The row simply commits together
 *     with the handler, and the worker's dispatch loop only sees it once visible.
 *  2. Every transition helper runs in its own short `db.tx()` (callers pass a fresh
 *     tx or use `runWithoutAmbientTx`), so the single pooled SQLite connection is
 *     never held across the seconds-to-minutes job execution.
 *
 * State machine (see WALLET_WORKER_DESIGN.md §5):
 *   pending → building → submitting → submitted → confirmed
 *      │          │           │            └────→ failed
 *      │          │           └→ submitted (reconciled) | failed (proven absent)
 *      │          └→ pending (transient retry) | failed
 *      └→ cancelled
 *
 * `submitting` is the durable pre-submit state: the signed CBOR, its hash and the
 * fee are committed BEFORE the transaction can reach the network, so a process
 * death anywhere around `submitTransaction` leaves a row that can be reconciled
 * against the chain (or re-submitted verbatim) instead of a `building` row that
 * looks un-submitted. It is a NON-terminal state, so it keeps holding the
 * idempotency key — a caller retry gets the same job back rather than a rebuild.
 *
 * Transitions use guarded UPDATEs (WHERE includes the expected source status) with
 * a read-back verification — the wallet lease already fences concurrent workers,
 * this is defense in depth. NOTE (CAP 10): numeric columns read back as STRINGS;
 * all reads coerce via `num()` so callers get clean numbers.
 */

/** Per-wallet DB lease TTL — same rationale as the crawler lease. */
export const WORKER_LEASE_TTL_MS = 15_000;

export const JOB_ERROR_CODES = {
  PROCESS_RESTART: 'PROCESS_RESTART',
  TX_DROPPED: 'TX_DROPPED',
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  CANCELLED: 'CANCELLED',
  /** Reconciliation proved the tx is not on-chain and the node rejects it for good. */
  SUBMIT_REJECTED: 'SUBMIT_REJECTED',
} as const;

export type WalletJobStatusValue =
  'pending' | 'building' | 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';
export type WalletJobKindValue = 'simpleAda' | 'metadata' | 'multiAsset' | 'mint' | 'plutusSpend' | 'submitSigned';
export type WorkerSignerTypeValue = 'hsm' | 'software';

export const WALLET_JOB_KINDS: readonly WalletJobKindValue[] =
  ['simpleAda', 'metadata', 'multiAsset', 'mint', 'plutusSpend', 'submitSigned'];

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
}

/** Normalized view of a worker-wallet row. */
export interface WorkerWalletRow {
  walletId: string;
  signerType: WorkerSignerTypeValue;
  address: string | null;
  publicKeyHash: string | null;
  enabled: boolean;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastJobAt: string | null;
  jobsConfirmed: number;
  jobsFailed: number;
}

function optionalNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function requiredNum(v: unknown, fallback = 0): number {
  return optionalNum(v) ?? fallback;
}

function timestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
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
  };
}

function toWalletRow(row: Record<string, unknown>): WorkerWalletRow {
  return {
    walletId: String(row.walletId),
    signerType: row.signerType as WorkerSignerTypeValue,
    address: (row.address as string) ?? null,
    publicKeyHash: (row.publicKeyHash as string) ?? null,
    enabled: row.enabled !== false,
    leaseOwner: (row.leaseOwner as string) ?? null,
    leaseUntil: timestamp(row.leaseUntil),
    lastJobAt: timestamp(row.lastJobAt),
    jobsConfirmed: requiredNum(row.jobsConfirmed),
    jobsFailed: requiredNum(row.jobsFailed),
  };
}

// Moved to srv/utils/tx-utils.ts (shared with the sign-service's deadlock
// guard); re-exported here so existing imports keep working.
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
  /** True when an idempotent retry matched an existing non-failed job. */
  deduplicated: boolean;
}

/**
 * Recognize a unique-constraint rejection across the adapters we support —
 * SQLite (`SQLITE_CONSTRAINT_UNIQUE`, "UNIQUE constraint failed") and HANA
 * (code 301, "unique constraint violated").
 *
 * Errors it does not recognize are deliberately NOT treated as duplicates: they
 * propagate, and the caller's retry dedups through the read path. Swallowing an
 * unrelated insert failure as "already exists" would drop the job silently.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, errno, message } = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (String(code ?? '').includes('SQLITE_CONSTRAINT')) return true;
  if (String(code ?? '') === '301' || String(errno ?? '') === '301') return true;
  const text = String(message ?? '').toLowerCase();
  return text.includes('unique constraint') || text.includes('duplicate key');
}

/** The job that currently owns an idempotency key, or null when it is free. */
async function readDedupHolder(
  db: CapTransaction,
  walletId: string,
  kind: WalletJobKindValue,
  dedupKey: string,
): Promise<WalletJobRow | null> {
  const row = await db.run(SELECT.one.from(CardanoWalletJobs).where({ walletId, kind, dedupKey }));
  return row ? toJobRow(row as Record<string, unknown>) : null;
}

/**
 * Insert a job row ON THE CALLER'S transaction (NIGHTGATE lesson 1 — see module
 * docs). Idempotency: an active-or-successful row with the same (walletId, kind,
 * idempotencyKey) is returned instead of creating a duplicate. `failed` AND
 * `cancelled` rows do NOT block a retry — both are terminal states in which the
 * intended work never reached the chain, so re-using the key must be able to
 * actually execute it (a cancelled job would otherwise burn its key forever).
 *
 * The deduplication is enforced by the `dedup` UNIQUE constraint on
 * (walletId, kind, dedupKey), NOT by the read below: two concurrent retries — two
 * app instances, or two HANA sessions — can both read "no such job" before either
 * commits, and would both insert. The read is only a fast path; the constraint is
 * what makes it correct, and the loser of the race returns the winner's job.
 *
 * `dedupKey` holds the caller's key while the job owns it and the job's own ID
 * otherwise, so keyless jobs never collide and terminated jobs free their key
 * (see releaseDedupClaim) — without depending on how a database treats NULLs
 * inside a unique index.
 */
export async function insertJob(db: CapTransaction, args: InsertJobArgs): Promise<InsertJobResult> {
  const idempotencyKey = args.idempotencyKey ?? null;

  if (idempotencyKey) {
    // Fast path: an owner exists (by construction it is non-terminal). Terminal
    // jobs release their claim, so they never show up here.
    const holder = await readDedupHolder(db, args.walletId, args.kind, idempotencyKey);
    if (holder) {
      if (holder.status !== 'failed' && holder.status !== 'cancelled') {
        return { jobId: holder.ID, status: holder.status, deduplicated: true };
      }
      // Defensive: a terminal row that still owns the key would block retries
      // forever. Free it and continue with a fresh job.
      logger.warn(`Job ${holder.ID} is ${holder.status} but still held idempotency key "${idempotencyKey}" — releasing it`);
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
    // No key → the row's own ID: unique by construction, so keyless jobs never
    // contend for the constraint.
    dedupKey: idempotencyKey ?? jobId,
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
    // Lost the race: another transaction committed the same key first. Its job is
    // the one and only job for this key — hand it back instead of paying twice.
    if (!idempotencyKey || !isUniqueViolation(err)) throw err;
    const winner = await readDedupHolder(db, args.walletId, args.kind, idempotencyKey);
    if (!winner) throw err; // constraint fired for some other reason — do not mask it
    logger.info(`Concurrent submission for idempotency key "${idempotencyKey}" — returning job ${winner.ID}`);
    return { jobId: winner.ID, status: winner.status, deduplicated: true };
  }

  return { jobId, status: 'pending', deduplicated: false };
}

// ---- Job reads -----------------------------------------------------------------

export async function getJobById(db: CapTransaction, jobId: string): Promise<WalletJobRow | null> {
  const row = await db.run(SELECT.one.from(CardanoWalletJobs).where({ ID: jobId }));
  return row ? toJobRow(row as Record<string, unknown>) : null;
}

/**
 * All dispatchable jobs: status pending, ordered by (priority, createdAt).
 * `notBefore` gating happens in JS — queue depths are small and the JS filter
 * avoids adapter-specific NULL/OR predicate quirks.
 */
export async function findDueJobs(db: CapTransaction, now = new Date()): Promise<WalletJobRow[]> {
  const rows = await db.run(
    SELECT.from(CardanoWalletJobs).where({ status: 'pending' }).orderBy('priority', 'createdAt'),
  ) as Record<string, unknown>[];
  return (rows ?? [])
    .map(toJobRow)
    .filter(j => !j.notBefore || Date.parse(j.notBefore) <= now.getTime());
}

/** All jobs awaiting confirmation (used by the tracker on start/recovery). */
export async function findSubmittedJobs(db: CapTransaction): Promise<WalletJobRow[]> {
  const rows = await db.run(
    SELECT.from(CardanoWalletJobs).where({ status: 'submitted' }),
  ) as Record<string, unknown>[];
  return (rows ?? []).map(toJobRow);
}

/** Whether the wallet has a job currently in flight (building, submitting or submitted). */
export async function walletHasActiveJob(db: CapTransaction, walletId: string): Promise<boolean> {
  const row = await db.run(
    SELECT.one.from(CardanoWalletJobs).where({ walletId, status: { in: ['building', 'submitting', 'submitted'] } }),
  );
  return !!row;
}

/**
 * The oldest `submitting` row of a wallet whose lease no longer belongs to a live
 * executor — its submit outcome is unknown (crash, or a submit call that failed
 * ambiguously), so it needs chain reconciliation rather than a rebuild. Rows whose
 * wallet lease is still held are being worked on right now and are left alone.
 */
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

/**
 * Give up a job's idempotency key by pointing `dedupKey` at the job's own ID
 * (unique by construction). Called on every terminal-but-unsuccessful transition,
 * which is what lets a caller re-use the key for a fresh attempt while the row
 * itself — including its `idempotencyKey` — stays intact for the audit trail.
 *
 * Not called for `confirmed`: a completed job keeps its key so a late duplicate
 * request resolves to it instead of paying again.
 */
export async function releaseDedupClaim(db: CapTransaction, jobId: string): Promise<void> {
  await db.run(UPDATE.entity(CardanoWalletJobs).set({ dedupKey: jobId }).where({ ID: jobId }));
}

async function guardedTransition(
  db: CapTransaction,
  jobId: string,
  fromStatuses: WalletJobStatusValue[],
  set: Record<string, unknown>,
): Promise<boolean> {
  await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set(set)
      .where({ ID: jobId, status: { in: fromStatuses } }),
  );
  // Read-back verification: CAP adapters differ in affected-row return shapes,
  // SELECT is consistent everywhere (same pattern as the crawler lease).
  const row = await getJobById(db, jobId);
  return row?.status === set.status;
}

/** pending → building. Increments the attempt counter. Returns false when lost. */
export async function markBuilding(db: CapTransaction, jobId: string, attempt: number): Promise<boolean> {
  return guardedTransition(db, jobId, ['pending'], { status: 'building', attempt });
}

/**
 * building → submitting. Commits the signed transaction, its hash, the unsigned
 * CBOR and the fee BEFORE the tx is handed to a backend — the whole point of the
 * state: whatever happens to the process during `submitTransaction`, the exact
 * bytes that may be on-chain survive, and the job keeps holding its idempotency
 * key so a caller retry can never turn into a second, differently-built payment.
 * `submittedAt` is the attempt time (timeout base), not proof of acceptance.
 */
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

/**
 * submitting → submitted: a backend accepted the tx (or reconciliation found it
 * on-chain). The artifacts are already durable from markSubmitting; only the hash
 * is re-asserted, in case the backend canonicalized it.
 */
export async function markSubmitted(db: CapTransaction, jobId: string, txHash: string): Promise<boolean> {
  return guardedTransition(db, jobId, ['submitting'], { status: 'submitted', txHash });
}

/**
 * building → pending (transient failure, attempts left). Keeps the error visible
 * and defers the next attempt via `notBefore` (exponential backoff).
 *
 * Guarded on `building` ON PURPOSE: once a job is `submitting` its tx may be in a
 * mempool, and re-queueing it would rebuild a different transaction from the same
 * request — the duplicate-payment path. Those rows go to reconciliation instead.
 */
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

/** A rollback invalidated the recorded confirmation point — back to watching. */
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

/**
 * Any active state → failed (terminal). Failing a `submitting`/`submitted` row is
 * only safe once the chain has been consulted — a failed row releases the
 * idempotency key, so a premature failure invites the caller's retry to pay twice.
 */
export async function markFailed(db: CapTransaction, jobId: string, code: string, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['pending', 'building', 'submitting', 'submitted'], {
    status: 'failed',
    errorCode: code.slice(0, 50),
    errorMessage: message.slice(0, 500),
    finishedAt: new Date().toISOString(),
    dedupKey: jobId, // free the idempotency key for the caller's retry
  });
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
  /** `submitted` rows to re-enqueue into the confirmation tracker — the chain decides. */
  submittedToReconcile: WalletJobRow[];
  /** `submitting` rows with an unknown submit outcome — reconciled by the dispatch loop. */
  submittingToReconcile: WalletJobRow[];
}

/** True when the wallet's lease is currently held (unexpired) by SOME instance. */
function walletLeaseHeld(wallet: WorkerWalletRow | null, now: Date): boolean {
  if (!wallet?.leaseOwner || !wallet.leaseUntil) return false;
  const deadline = Date.parse(wallet.leaseUntil);
  return Number.isFinite(deadline) && deadline > now.getTime();
}

/**
 * Fail one wallet's orphaned `building` row(s) — but ONLY when the wallet's lease
 * is expired/unowned, i.e. no live instance is executing them. Rows whose wallet
 * lease is held belong to a running executor (possibly on another instance) and
 * must not be touched.
 *
 * Safe by construction: a `building` row is pre-submit by definition — the worker
 * transitions to `submitting` (with the signed CBOR) before anything can reach a
 * backend, so nothing that is still `building` has ever been sent. Rows that made
 * it past that point are `submitting` and are reconciled, never failed here.
 */
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
  // Per row rather than one bulk UPDATE: each row releases its idempotency key to
  // its OWN ID (see releaseDedupClaim), which a single statement cannot express
  // portably. Orphan sets are one row in practice — a wallet runs one job at a time.
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

/**
 * Boot-time recovery (design §8), by state:
 *  - `building` — nothing was signed and stored yet, so nothing was submitted:
 *    fail with PROCESS_RESTART (caller retries via idempotencyKey).
 *  - `submitting` — the signed tx is durable but its fate is unknown: NOT failed
 *    and NOT rebuilt. Returned so the dispatch loop reconciles it against the
 *    chain and re-submits those exact bytes if needed.
 *  - `submitted` — NOT failed: handed to the confirmation tracker; the chain
 *    decides (found → confirm; absent past the timeout → TX_DROPPED).
 *
 * Multi-instance safety: a `building` row is only failed when its wallet's lease
 * is expired/unowned. A held lease means ANOTHER live instance is executing that
 * job right now (rolling deploy) — failing it here while its submit succeeds
 * would leave a failed row for an on-chain tx, and since failed rows don't block
 * idempotency dedup, the caller's documented retry would pay twice. Rows skipped
 * here are cleaned up later by failOrphanedBuildingJobs once the lease expires.
 */
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
    logger.info(`Recovery skipped building job(s) for wallet(s) ${skippedWallets.join(', ')} — lease still held by a live instance`);
  }
  const submitted = await findSubmittedJobs(db);
  if (submitted.length) {
    logger.info(`${submitted.length} submitted job(s) pending chain reconciliation after restart`);
  }
  const submitting = (await db.run(
    SELECT.from(CardanoWalletJobs).where({ status: 'submitting' }),
  ) as Record<string, unknown>[] ?? []).map(toJobRow);
  if (submitting.length) {
    logger.warn(`${submitting.length} job(s) interrupted around submit — the dispatch loop will reconcile them against the chain (never a rebuild)`);
  }
  return { failedBuilding, submittedToReconcile: submitted, submittingToReconcile: submitting };
}

// ---- Worker wallets --------------------------------------------------------------

/** Idempotently register/refresh a configured wallet row (no key material). */
export async function upsertWalletRegistration(
  db: CapTransaction,
  wallet: { walletId: string; signerType: WorkerSignerTypeValue; address: string; publicKeyHash: string },
): Promise<void> {
  const existing = await db.run(SELECT.one.from(CardanoWorkerWallets).where({ walletId: wallet.walletId }));
  if (existing) {
    await db.run(UPDATE.entity(CardanoWorkerWallets).set({
      signerType: wallet.signerType,
      address: wallet.address,
      publicKeyHash: wallet.publicKeyHash,
    }).where({ walletId: wallet.walletId }));
    return;
  }
  await db.run(INSERT.into(CardanoWorkerWallets).entries({
    walletId: wallet.walletId,
    signerType: wallet.signerType,
    address: wallet.address,
    publicKeyHash: wallet.publicKeyHash,
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

function leaseDeadlineReached(wallet: WorkerWalletRow | null, owner: string, expectedMs: number): boolean {
  if (!wallet || wallet.leaseOwner !== owner || !wallet.leaseUntil) return false;
  const actualMs = Date.parse(wallet.leaseUntil);
  // One second tolerance for adapter timestamp normalization (crawler lease pattern).
  return Number.isFinite(actualMs) && actualMs >= expectedMs - 1_000;
}

/**
 * Atomically acquire an expired/unowned per-wallet lease (compare-and-swap +
 * read-back verification, same shape as the crawler lease). At most one worker
 * instance may execute jobs for a wallet at any time.
 */
export async function tryAcquireWalletLease(
  db: CapTransaction,
  walletId: string,
  owner: string,
  now = new Date(),
  ttlMs = WORKER_LEASE_TTL_MS,
): Promise<boolean> {
  const raw = await db.run(SELECT.one.from(CardanoWorkerWallets).where({ walletId })) as Record<string, unknown> | undefined;
  if (!raw) return false;
  const current = toWalletRow(raw);
  if (!current.enabled) return false;

  const deadline = current.leaseUntil ? Date.parse(current.leaseUntil) : Number.NEGATIVE_INFINITY;
  if (current.leaseOwner && current.leaseOwner !== owner && deadline > now.getTime()) return false;

  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  // CAS on the observed owner only — timestamp equality is adapter-fragile and
  // could make an expired lease permanently untakeable (see tryAcquireCrawlerLease).
  await db.run(UPDATE.entity(CardanoWorkerWallets).set({ leaseOwner: owner, leaseUntil }).where({
    walletId,
    leaseOwner: raw.leaseOwner ?? null,
  }));
  const verified = await readWallet(db, walletId);
  return leaseDeadlineReached(verified, owner, now.getTime() + ttlMs);
}

/** Renew/fence the caller's lease. Call before every job-advancing write. */
export async function renewWalletLease(
  db: CapTransaction,
  walletId: string,
  owner: string,
  now = new Date(),
  ttlMs = WORKER_LEASE_TTL_MS,
): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(UPDATE.entity(CardanoWorkerWallets).set({ leaseUntil }).where({
    walletId,
    leaseOwner: owner,
  }));
  const verified = await readWallet(db, walletId);
  return leaseDeadlineReached(verified, owner, now.getTime() + ttlMs);
}

/** Release only the caller's lease; a stale process can never clear a successor. */
export async function releaseWalletLease(db: CapTransaction, walletId: string, owner: string): Promise<void> {
  await db.run(UPDATE.entity(CardanoWorkerWallets).set({ leaseOwner: null, leaseUntil: null }).where({
    walletId,
    leaseOwner: owner,
  }));
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
