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

/** Release only the caller's lease; a stale process can never clear a successor. */
export async function releaseCrawlerLease(
  db: CapTransaction,
  owner: string,
  status: CrawlSyncStatusValue,
): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({
    leaseOwner: null,
    leaseUntil: null,
    syncStatus: status,
    ...(status === 'error' ? { desiredRunning: false } : {}),
  }).where({ ID: SINGLETON_ID, leaseOwner: owner }));
}

/** Persist the pause/resume intent shared by every app instance. */
export async function setCrawlerDesiredRunning(db: CapTransaction, desiredRunning: boolean): Promise<void> {
  const set: Record<string, unknown> = { desiredRunning };
  if (!desiredRunning) set.syncStatus = 'stopped';
  await db.run(UPDATE.entity(CardanoSyncState).set(set).where({ ID: SINGLETON_ID }));
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
): Promise<void> {
  const set: Record<string, unknown> = {
    lastSlot: block.slot,
    lastBlockHash: block.hash,
    lastHeight: block.height ?? 0,
    lastIndexedAt: new Date().toISOString(),
    syncStatus: status,
    consecutiveErrors: 0,
    lastError: null,
  };
  if (tip) {
    set.tipSlot = tip.slot;
    if (tip.height !== undefined) set.tipHeight = tip.height;
  }
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
export async function setSyncStatus(db: CapTransaction, status: CrawlSyncStatusValue): Promise<void> {
  await db.run(UPDATE.entity(CardanoSyncState).set({ syncStatus: status }).where({ ID: SINGLETON_ID }));
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
