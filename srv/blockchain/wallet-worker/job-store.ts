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
 *   pending → building → submitted → confirmed
 *      │          │           └────→ failed
 *      │          └→ pending (transient retry) | failed
 *      └→ cancelled
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
} as const;

export type WalletJobStatusValue = 'pending' | 'building' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';
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
 * Insert a job row ON THE CALLER'S transaction (NIGHTGATE lesson 1 — see module
 * docs). Idempotency: an active-or-successful row with the same (walletId, kind,
 * idempotencyKey) is returned instead of creating a duplicate. `failed` AND
 * `cancelled` rows do NOT block a retry — both are terminal states in which the
 * intended work never reached the chain, so re-using the key must be able to
 * actually execute it (a cancelled job would otherwise burn its key forever).
 */
export async function insertJob(db: CapTransaction, args: InsertJobArgs): Promise<InsertJobResult> {
  if (args.idempotencyKey) {
    const existing = await db.run(
      SELECT.one.from(CardanoWalletJobs)
        .where({ walletId: args.walletId, kind: args.kind, idempotencyKey: args.idempotencyKey })
        .orderBy('createdAt desc'),
    );
    const status = (existing as { status: string } | undefined)?.status;
    if (existing && status !== 'failed' && status !== 'cancelled') {
      const row = toJobRow(existing as Record<string, unknown>);
      return { jobId: row.ID, status: row.status, deduplicated: true };
    }
  }

  const jobId = randomUUID();
  await db.run(INSERT.into(CardanoWalletJobs).entries({
    ID: jobId,
    walletId: args.walletId,
    kind: args.kind,
    status: 'pending',
    idempotencyKey: args.idempotencyKey ?? null,
    request: args.request,
    priority: args.priority ?? 100,
    notBefore: args.notBefore ?? null,
    attempt: 0,
    maxAttempts: args.maxAttempts ?? 3,
    createdAt: new Date().toISOString(),
    createdBy: args.createdBy ?? null,
  }));
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

/** Whether the wallet has a job currently in flight (building or submitted). */
export async function walletHasActiveJob(db: CapTransaction, walletId: string): Promise<boolean> {
  const row = await db.run(
    SELECT.one.from(CardanoWalletJobs).where({ walletId, status: { in: ['building', 'submitted'] } }),
  );
  return !!row;
}

// ---- Guarded transitions ---------------------------------------------------------

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

/** building → submitted. Persists the tx artifacts in the SAME transition. */
export async function markSubmitted(
  db: CapTransaction,
  jobId: string,
  artifacts: { txHash: string; unsignedTxCbor: string | null; signedTxCbor: string; fee: string | number | null },
): Promise<boolean> {
  return guardedTransition(db, jobId, ['building'], {
    status: 'submitted',
    txHash: artifacts.txHash,
    unsignedTxCbor: artifacts.unsignedTxCbor,
    signedTxCbor: artifacts.signedTxCbor,
    fee: artifacts.fee,
    submittedAt: new Date().toISOString(),
  });
}

/**
 * building → pending (transient failure, attempts left). Keeps the error visible
 * and defers the next attempt via `notBefore` (exponential backoff).
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

/** Any active state → failed (terminal). */
export async function markFailed(db: CapTransaction, jobId: string, code: string, err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  return guardedTransition(db, jobId, ['pending', 'building', 'submitted'], {
    status: 'failed',
    errorCode: code.slice(0, 50),
    errorMessage: message.slice(0, 500),
    finishedAt: new Date().toISOString(),
  });
}

/** pending → cancelled. Only pending jobs are cancellable (the tx may otherwise reach the chain). */
export async function markCancelled(db: CapTransaction, jobId: string): Promise<boolean> {
  return guardedTransition(db, jobId, ['pending'], {
    status: 'cancelled',
    errorCode: JOB_ERROR_CODES.CANCELLED,
    finishedAt: new Date().toISOString(),
  });
}

// ---- Crash recovery -----------------------------------------------------------

export interface RecoveryResult {
  /** `building` rows flipped to failed (no txHash by construction — never submitted). */
  failedBuilding: number;
  /** `submitted` rows to re-enqueue into the confirmation tracker — the chain decides. */
  submittedToReconcile: WalletJobRow[];
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
 * must not be touched: it may already have submitted, and failing its row would
 * un-block the idempotencyKey and invite a duplicate payment.
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
  await db.run(
    UPDATE.entity(CardanoWalletJobs)
      .set({
        status: 'failed',
        errorCode: JOB_ERROR_CODES.PROCESS_RESTART,
        errorMessage: 'Job was interrupted before submission (executor died or lost its wallet lease).',
        finishedAt: now.toISOString(),
      })
      .where({ walletId, status: 'building' }),
  );
  logger.warn(`Wallet ${walletId}: failed ${building.length} orphaned building job(s) as failed:PROCESS_RESTART`);
  return building.length;
}

/**
 * Boot-time recovery (design §8): `building` rows cannot have been submitted —
 * submit and txHash persist happen in one transition — so they fail safely with
 * PROCESS_RESTART (caller retries via idempotencyKey). `submitted` rows are NOT
 * failed: they are returned for the confirmation tracker to reconcile against the
 * chain, because blindly failing them would invite a duplicate payment.
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
  return { failedBuilding, submittedToReconcile: submitted };
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
