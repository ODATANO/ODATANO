import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { CardanoSyncState } from '#cds-models/odatano/cardano';
import { ConfigError } from '../../utils/errors';

const { SELECT, INSERT, UPDATE } = cds.ql;
const logger = cds.log('CardanoCrawler');

/**
 * Cursor helpers for `CardanoSyncState`, the singleton row recording how far the crawler
 * has indexed. Integer64/Decimal columns come back from the DB as strings, so every read
 * coerces numeric fields; callers get a numeric `SyncCursor`.
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

/** Coerce a numeric-as-string (or number/bigint/null) into a JS number. */
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
 * Import-lease read-back: ownership and deadline only. Unlike the crawler lease it does not
 * require `desiredRunning`, which is cleared while an import runs.
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
 * Ensure the singleton cursor row exists and return it; a fresh DB gets the configured
 * start point and status 'stopped'.
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
 * Acquire an expired/unowned lease with compare-and-swap semantics. Verified by a read-back
 * SELECT: affected-row return shapes differ between SQLite and HANA.
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

  // CAS on the observed OWNER only, verified by read-back. leaseUntil is deliberately not
  // compared: timestamp normalization on some adapters would make that CAS never match again
  // after a leader crash. A concurrently renewing old owner is fenced by its next renew.
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
 * Release only the caller's lease. `pauseCluster` clears `desiredRunning`, which no restart
 * undoes — reserve it for failures a restart cannot fix (misconfiguration, no resume point).
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
 * Persist the pause/resume intent shared by every instance. Resuming clears the error
 * streak so the standby backoff restarts at its base.
 */
export async function setCrawlerDesiredRunning(db: CapTransaction, desiredRunning: boolean): Promise<void> {
  const set: Record<string, unknown> = { desiredRunning };
  if (desiredRunning) set.consecutiveErrors = 0;
  else set.syncStatus = 'stopped';
  await db.run(UPDATE.entity(CardanoSyncState).set(set).where({ ID: SINGLETON_ID }));
}

/**
 * Latch the cluster off because of a poison block. Deliberately not lease-scoped: the poison
 * is a property of the block, not of the instance. Only resumeCrawler brings the crawler back.
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
 * Advance the cursor to a freshly indexed block, clear the error streak and optionally
 * record the latest known tip. Pass status 'synced' when the block is at the tip.
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
 * Lease for the UTxO set import, on the crawler's lease columns: a crawler start on any
 * instance and a second import are refused while it is held. Does not require `desiredRunning`.
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
