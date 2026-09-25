import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { CardanoSyncState } from '#cds-models/odatano/cardano';
import { ConfigError } from '../../utils/errors';

const { SELECT, INSERT, UPDATE } = cds.ql;
const logger = cds.log('CardanoCrawler');

/**
 * Chain crawler cursor helpers (v2.0 pre-sync).
 *
 * `CardanoSyncState` is a singleton row (key = SINGLETON_ID) that records how far
 * the crawler has indexed the chain, so a restart resumes instead of re-crawling.
 *
 * NOTE (CAP 10): Integer64 / Decimal columns are read back from SQLite/HANA as
 * STRINGS, not JS numbers — the same change that makes them strings over OData.
 * Every read here therefore coerces numeric fields with `num()`; callers get a
 * clean numeric `SyncCursor` and never have to think about it.
 */

export const SINGLETON_ID = 'SINGLETON';

/** Circuit-breaker threshold: pause crawling after this many back-to-back failures. */
export const MAX_CONSECUTIVE_ERRORS = 10;

/** A short, renewable DB lease prevents two app instances from advancing one cursor. */
export const CRAWLER_LEASE_TTL_MS = 15_000;

export type CrawlSyncStatusValue = 'stopped' | 'syncing' | 'synced' | 'error';

/** A chain point the crawler can start from or roll back to. */
export interface CrawlPoint {
  slot: number;
  hash: string;
  height?: number;
}

export type UtxoSetStatusValue = 'none' | 'importing' | 'active' | 'invalid';

/** Crawler-fed ledger state (crawler.utxoSet): the anchor the imported UTxO set describes. */
export interface UtxoSetState {
  status: UtxoSetStatusValue;
  anchorSlot: number | null;
  anchorHash: string | null;
  importedAt: string | null;
  /** Slot of the last block applied to the ledger tables (null = nothing applied since the import). */
  appliedSlot: number | null;
  error: string | null;
}

/** Normalized, number-typed view of the cursor row (numeric fields already coerced). */
export interface SyncCursor {
  network: string | null;
  startSlot: number | null;
  startBlockHash: string | null;
  lastSlot: number;
  lastBlockHash: string | null;
  lastHeight: number;
  tipSlot: number | null;
  tipHeight: number | null;
  syncStatus: CrawlSyncStatusValue;
  consecutiveErrors: number;
  desiredRunning: boolean;
  leaseOwner: string | null;
  leaseUntil: string | null;
  utxoSet: UtxoSetState;
}

/**
 * Coerce a CAP-10 numeric-as-string (or number/bigint/null) into a JS number.
 * Separate optional/required helpers avoid overload declarations (and the
 * no-redeclare lint false-positive they caused).
 */
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

/**
 * Import-lease read-back: ownership and deadline only. The crawler variant below also
 * requires `desiredRunning`, which `pauseCrawler` clears — and an import runs exactly then.
 */
function importLeaseHeld(cursor: SyncCursor | null, owner: string, expectedMs: number): boolean {
  if (!cursor || cursor.leaseOwner !== owner || !cursor.leaseUntil) return false;
  const actualMs = Date.parse(cursor.leaseUntil);
  return Number.isFinite(actualMs) && actualMs >= expectedMs - 1_000;
}

function leaseDeadlineReached(cursor: SyncCursor | null, owner: string, expectedMs: number): boolean {
  if (cursor?.desiredRunning !== true || cursor.leaseOwner !== owner || !cursor.leaseUntil) return false;
  const actualMs = Date.parse(cursor.leaseUntil);
  // Some adapters normalize Timestamp precision/format. One second tolerance covers
  // that representation change without accepting an old lease interval.
  return Number.isFinite(actualMs) && actualMs >= expectedMs - 1_000;
}

/** Map a raw DB row into the normalized numeric cursor. */
function toCursor(row: Record<string, unknown>): SyncCursor {
  return {
    network: (row.network as string) ?? null,
    startSlot: optionalNum(row.startSlot),
    startBlockHash: (row.startBlockHash as string) ?? null,
    lastSlot: requiredNum(row.lastSlot),
    lastBlockHash: (row.lastBlockHash as string) ?? null,
    lastHeight: requiredNum(row.lastHeight),
    tipSlot: optionalNum(row.tipSlot),
    tipHeight: optionalNum(row.tipHeight),
    syncStatus: ((row.syncStatus as CrawlSyncStatusValue) ?? 'stopped'),
    consecutiveErrors: requiredNum(row.consecutiveErrors),
    desiredRunning: row.desiredRunning !== false,
    leaseOwner: (row.leaseOwner as string) ?? null,
    leaseUntil: timestamp(row.leaseUntil),
    utxoSet: {
      status: ((row.utxoSetStatus as UtxoSetStatusValue) ?? 'none'),
      anchorSlot: optionalNum(row.utxoAnchorSlot),
      anchorHash: (row.utxoAnchorHash as string) ?? null,
      importedAt: timestamp(row.utxoSetImportedAt),
      appliedSlot: optionalNum(row.utxoAppliedSlot),
      error: (row.utxoSetError as string) ?? null,
    },
  };
}

/**
 * Idempotently ensure the singleton cursor row exists and return it.
 * On first call (fresh DB) the row is created with the configured start point
 * (if given) and status 'stopped'. Subsequent calls just return the current row.
 * Safe to call from both the crawler and the control service.
 */
export async function ensureSyncStateSingleton(
  db: CapTransaction,
  network: string,
  start?: CrawlPoint,
): Promise<SyncCursor> {
  const existing = await db.run(SELECT.one.from(CardanoSyncState).where({ ID: SINGLETON_ID }));
  if (existing) {
    const cursor = toCursor(existing as Record<string, unknown>);
    if (cursor.network !== network) {
      throw new ConfigError(
        `Crawler cursor network mismatch: persisted cursor tracks ${cursor.network ?? 'an unknown network'}, configured client is ${network}.`,
      );
    }
    return cursor;
  }

  const row = {
    ID: SINGLETON_ID,
    network,
    startSlot: start?.slot ?? null,
    startBlockHash: start?.hash ?? null,
    lastSlot: start?.slot ?? 0,
    lastBlockHash: start?.hash ?? null,
    lastHeight: start?.height ?? 0,
    tipSlot: null,
    tipHeight: null,
    syncStatus: 'stopped' as CrawlSyncStatusValue,
    consecutiveErrors: 0,
    desiredRunning: true,
    leaseOwner: null,
    leaseUntil: null,
    utxoSetStatus: 'none' as UtxoSetStatusValue,
    utxoAnchorSlot: null,
    utxoAnchorHash: null,
    utxoSetImportedAt: null,
    utxoAppliedSlot: null,
    utxoSetError: null,
  };
  await db.run(INSERT.into(CardanoSyncState).entries(row));
  logger.info(`Sync cursor initialized (network=${network}, start=${start ? `${start.slot}/${start.hash}` : 'none'})`);
  return toCursor(row);
}

/** Read the current cursor, or null if it has not been initialized yet. */
export async function readCursor(db: CapTransaction): Promise<SyncCursor | null> {
  const row = await db.run(SELECT.one.from(CardanoSyncState).where({ ID: SINGLETON_ID }));
  return row ? toCursor(row as Record<string, unknown>) : null;
}

/** Whether the shared lease currently represents a live cluster-wide crawler. */
export function isCrawlerLeaseActive(cursor: SyncCursor | null, now = new Date()): boolean {
  if (!cursor?.desiredRunning || !cursor.leaseOwner || !cursor.leaseUntil) return false;
  const deadline = Date.parse(cursor.leaseUntil);
  return Number.isFinite(deadline) && deadline > now.getTime();
}

/**
 * Atomically acquire an expired/unowned lease with compare-and-swap semantics.
 * The post-update read is intentional: CAP adapters consistently return the row
 * for SELECT, whereas affected-row return shapes differ between SQLite and HANA.
 */
export async function tryAcquireCrawlerLease(
  db: CapTransaction,
  owner: string,
  now = new Date(),
  ttlMs = CRAWLER_LEASE_TTL_MS,
): Promise<boolean> {
  const raw = await db.run(SELECT.one.from(CardanoSyncState).where({ ID: SINGLETON_ID })) as Record<string, unknown> | undefined;
  if (!raw) return false;
  const current = toCursor(raw);
  if (!current.desiredRunning) return false;

  const deadline = current.leaseUntil ? Date.parse(current.leaseUntil) : Number.NEGATIVE_INFINITY;
  if (current.leaseOwner && current.leaseOwner !== owner && deadline > now.getTime()) return false;

  // CAS on the observed OWNER only (a plain string that round-trips identically
  // on every adapter). If two instances race, the first writer changes leaseOwner
  // and the loser's UPDATE matches 0 rows → its read-back verification fails.
  // Deliberately NOT comparing leaseUntil: HANA/driver timestamp normalization can
  // make the read-back representation differ from what the WHERE serializes, so a
  // timestamp-equality CAS may NEVER match again after a leader crash — the lease
  // would be stuck until the row is cleared by hand. The residual race (the old
  // owner renewing concurrently) resolves via fencing: its next renew no longer
  // matches leaseOwner and it halts.
  const where: Record<string, unknown> = {
    ID: SINGLETON_ID,
    leaseOwner: raw.leaseOwner ?? null,
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'desiredRunning')) {
    where.desiredRunning = raw.desiredRunning;
  }
  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(UPDATE.entity(CardanoSyncState).set({ leaseOwner: owner, leaseUntil }).where(where));

  const verified = await readCursor(db);
  return leaseDeadlineReached(verified, owner, now.getTime() + ttlMs);
}

/**
 * Renew/fence a lease. Call this inside the same transaction as every crawler write:
 * the conditional UPDATE serializes a former leader against a newly elected one.
 */
export async function renewCrawlerLease(
  db: CapTransaction,
  owner: string,
  now = new Date(),
  ttlMs = CRAWLER_LEASE_TTL_MS,
): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(UPDATE.entity(CardanoSyncState).set({ leaseUntil }).where({
    ID: SINGLETON_ID,
    leaseOwner: owner,
    desiredRunning: true,
  }));
  const verified = await readCursor(db);
  return leaseDeadlineReached(verified, owner, now.getTime() + ttlMs);
}

/**
 * Release only the caller's lease; a stale process can never clear a successor.
 *
 * `pauseCluster` clears `desiredRunning`, which no restart undoes — every instance
 * then refuses to start until an operator calls resumeCrawler. Reserve it for
 * failures a restart genuinely cannot fix (misconfiguration, no resume point). A
 * crashed stream, a provider outage or a node restart must NOT latch: those are
 * exactly the cases where coming back up should resume the pre-sync by itself.
 */
export async function releaseCrawlerLease(
  db: CapTransaction,
  owner: string,
  status: CrawlSyncStatusValue,
  pauseCluster = false,
): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({
    leaseOwner: null,
    leaseUntil: null,
    syncStatus: status,
    ...(pauseCluster ? { desiredRunning: false } : {}),
  }).where({ ID: SINGLETON_ID, leaseOwner: owner }));
}

/**
 * Persist the pause/resume intent shared by every app instance. Resuming also clears
 * the error streak: the operator says the cause is fixed, and a stale streak would
 * otherwise keep the standby backoff at its cap for the first retry.
 */
export async function setCrawlerDesiredRunning(db: CapTransaction, desiredRunning: boolean): Promise<void> {
  const set: Record<string, unknown> = { desiredRunning };
  if (desiredRunning) set.consecutiveErrors = 0;
  else set.syncStatus = 'stopped';
  await db.run(UPDATE.entity(CardanoSyncState).set(set).where({ ID: SINGLETON_ID }));
}

/**
 * Latch the cluster off because of a poison block (a block whose data the database
 * deterministically rejects). Deliberately NOT lease-scoped, unlike releaseCrawlerLease:
 * the poison is a property of the block, not of the instance that observed it, and
 * that instance may have lost its lease while the failure was being recorded. Only
 * an operator's resumeCrawler brings the crawler back.
 */
export async function latchPoisonBlock(db: CapTransaction, message: string): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({
    desiredRunning: false,
    syncStatus: 'error',
    lastError: message.slice(0, 500),
    lastErrorAt: new Date().toISOString(),
  }).where({ ID: SINGLETON_ID }));
}

/**
 * Advance the cursor to a freshly-indexed block. Sets the status (default 'syncing';
 * pass 'synced' when the block is at the tip), clears the error streak, and refreshes
 * lastIndexedAt. Optionally records the latest known tip (for progress).
 */
export async function advanceCursor(
  db: CapTransaction,
  block: CrawlPoint,
  tip?: { slot: number; height?: number },
  status: CrawlSyncStatusValue = 'syncing',
  /** Extra cursor columns written in the same statement (e.g. the ledger's `utxoAppliedSlot`). */
  extra?: Record<string, unknown>,
): Promise<void> {
  const set: Record<string, unknown> = {
    lastSlot: block.slot,
    lastBlockHash: block.hash,
    lastHeight: block.height ?? 0,
    lastIndexedAt: new Date().toISOString(),
    syncStatus: status,
    consecutiveErrors: 0,
    lastError: null,
    ...(extra ?? {}),
  };
  if (tip) {
    set.tipSlot = tip.slot;
    if (tip.height !== undefined) set.tipHeight = tip.height;
  }
  await db.run(UPDATE.entity(CardanoSyncState).set(set).where({ ID: SINGLETON_ID }));
}

/**
 * Lease for the UTxO set import: the same `leaseOwner` / `leaseUntil` columns the crawler
 * uses, so a crawler start on ANY instance is refused while the import holds it (its CAS
 * sees a foreign owner with a live deadline) and a second import is refused the same way.
 * Unlike the crawler lease it does not require `desiredRunning` — the cluster is paused
 * during an import by design.
 */
export async function tryAcquireImportLease(
  db: CapTransaction,
  owner: string,
  now = new Date(),
  ttlMs = CRAWLER_LEASE_TTL_MS,
): Promise<boolean> {
  const raw = await db.run(SELECT.one.from(CardanoSyncState).where({ ID: SINGLETON_ID })) as Record<string, unknown> | undefined;
  if (!raw) return false;
  const current = toCursor(raw);
  const deadline = current.leaseUntil ? Date.parse(current.leaseUntil) : Number.NEGATIVE_INFINITY;
  if (current.leaseOwner && current.leaseOwner !== owner && deadline > now.getTime()) return false;
  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(UPDATE.entity(CardanoSyncState).set({ leaseOwner: owner, leaseUntil }).where({
    ID: SINGLETON_ID,
    leaseOwner: raw.leaseOwner ?? null,
  }));
  const verified = await readCursor(db);
  return importLeaseHeld(verified, owner, now.getTime() + ttlMs);
}

export async function renewImportLease(
  db: CapTransaction,
  owner: string,
  now = new Date(),
  ttlMs = CRAWLER_LEASE_TTL_MS,
): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + ttlMs).toISOString();
  await db.run(UPDATE.entity(CardanoSyncState).set({ leaseUntil }).where({ ID: SINGLETON_ID, leaseOwner: owner }));
  const verified = await readCursor(db);
  return importLeaseHeld(verified, owner, now.getTime() + ttlMs);
}

export async function releaseImportLease(db: CapTransaction, owner: string): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({ leaseOwner: null, leaseUntil: null }).where({ ID: SINGLETON_ID, leaseOwner: owner }));
}

/** Persist the crawler-fed ledger state's anchor / validity (crawler.utxoSet). */
export async function setUtxoSetState(db: CapTransaction, state: Partial<UtxoSetState>): Promise<void> {
  const set: Record<string, unknown> = {};
  if (state.status !== undefined) set.utxoSetStatus = state.status;
  if (state.anchorSlot !== undefined) set.utxoAnchorSlot = state.anchorSlot;
  if (state.anchorHash !== undefined) set.utxoAnchorHash = state.anchorHash;
  if (state.importedAt !== undefined) set.utxoSetImportedAt = state.importedAt;
  if (state.appliedSlot !== undefined) set.utxoAppliedSlot = state.appliedSlot;
  if (state.error !== undefined) set.utxoSetError = state.error;
  if (!Object.keys(set).length) return;
  await db.run(UPDATE.entity(CardanoSyncState).set(set).where({ ID: SINGLETON_ID }));
}

/** Reset the cursor to a rollback point (used by reorg handling). */
export async function resetCursorTo(db: CapTransaction, point: CrawlPoint): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({
    lastSlot: point.slot,
    lastBlockHash: point.hash,
    lastHeight: point.height ?? 0,
    lastIndexedAt: new Date().toISOString(),
  }).where({ ID: SINGLETON_ID }));
  logger.warn(`Sync cursor reset to fork point ${point.slot}/${point.hash}`);
}

/** Set the crawler status (e.g. 'synced' when caught up, 'stopped' on shutdown). */
export async function setSyncStatus(
  db: CapTransaction,
  status: CrawlSyncStatusValue,
  pauseCluster = false,
): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({
    syncStatus: status,
    ...(pauseCluster ? { desiredRunning: false } : {}),
  }).where({ ID: SINGLETON_ID }));
}

/**
 * Record a crawler error. Increments the consecutive-error counter and flips status
 * to 'error' once the circuit-breaker threshold is reached. Returns the new streak
 * length so the caller can decide whether to back off / stop.
 */
export async function recordError(db: CapTransaction, err: unknown, leaseOwner?: string): Promise<number> {
  if (leaseOwner && !(await renewCrawlerLease(db, leaseOwner))) return -1;
  const current = await readCursor(db);
  const streak = (current?.consecutiveErrors ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);
  await db.run(UPDATE.entity(CardanoSyncState).set({
    consecutiveErrors: streak,
    lastError: message.slice(0, 500),
    lastErrorAt: new Date().toISOString(),
    syncStatus: streak >= MAX_CONSECUTIVE_ERRORS ? 'error' : 'syncing',
  }).where({ ID: SINGLETON_ID }));
  return streak;
}
