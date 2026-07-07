import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { CardanoSyncState } from '#cds-models/odatano/cardano';

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
}

/** Coerce a CAP-10 numeric-as-string (or number/bigint/null) into a JS number. */
function num(v: unknown, fallback: number | null = null): number | null {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** Map a raw DB row into the normalized numeric cursor. */
function toCursor(row: Record<string, unknown>): SyncCursor {
  return {
    network: (row.network as string) ?? null,
    startSlot: num(row.startSlot),
    startBlockHash: (row.startBlockHash as string) ?? null,
    lastSlot: num(row.lastSlot, 0) as number,
    lastBlockHash: (row.lastBlockHash as string) ?? null,
    lastHeight: num(row.lastHeight, 0) as number,
    tipSlot: num(row.tipSlot),
    tipHeight: num(row.tipHeight),
    syncStatus: ((row.syncStatus as CrawlSyncStatusValue) ?? 'stopped'),
    consecutiveErrors: num(row.consecutiveErrors, 0) as number,
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
  if (existing) return toCursor(existing as Record<string, unknown>);

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
    syncProgress: 0,
    consecutiveErrors: 0,
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
export async function recordError(db: CapTransaction, err: unknown): Promise<number> {
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
