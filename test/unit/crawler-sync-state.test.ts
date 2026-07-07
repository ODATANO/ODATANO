/**
 * Chain crawler — sync-state cursor helpers (C1/C7).
 * Mocks the @sap/cds CQL layer (matching the repo's indexer-test style) and drives the
 * cursor primitives through a fake `db.run`, asserting the CQL payloads and the CAP-10
 * numeric-as-string normalization.
 */

// UPDATE/INSERT builders echo their payload so tests can inspect what would be written.
jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  ql: {
    SELECT: { one: { from: () => ({ where: () => ({ _op: 'SELECT.one' }) }) } },
    INSERT: { into: () => ({ entries: (rows: unknown) => ({ _op: 'INSERT', entries: rows }) }) },
    UPDATE: { entity: () => ({ set: (s: unknown) => ({ where: (w: unknown) => ({ _op: 'UPDATE', set: s, where: w }) }) }) },
  },
}));

// The typed entity proxies need the real cds runtime — stub them with plain names.
jest.mock('#cds-models/odatano/cardano', () => ({
  CardanoSyncState: 'odatano.cardano.CardanoSyncState',
}));

import {
  ensureSyncStateSingleton,
  readCursor,
  advanceCursor,
  resetCursorTo,
  setSyncStatus,
  recordError,
  SINGLETON_ID,
  MAX_CONSECUTIVE_ERRORS,
} from '../../srv/blockchain/crawler/sync-state';

type FakeDb = { run: jest.Mock };
const makeDb = (): FakeDb => ({ run: jest.fn() });

describe('sync-state: ensureSyncStateSingleton', () => {
  it('INSERTs a new singleton with the configured start point when none exists', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce(undefined); // SELECT.one -> not found

    const cursor = await ensureSyncStateSingleton(db as never, 'preview', { slot: 100, hash: 'aa', height: 7 });

    const insertCall = db.run.mock.calls.find(c => (c[0] as { _op?: string })?._op === 'INSERT');
    expect(insertCall).toBeDefined();
    const entries = (insertCall![0] as { entries: Record<string, unknown> }).entries;
    expect(entries).toMatchObject({
      ID: SINGLETON_ID,
      network: 'preview',
      startSlot: 100,
      startBlockHash: 'aa',
      lastSlot: 100,
      lastBlockHash: 'aa',
      lastHeight: 7,
      syncStatus: 'stopped',
    });
    expect(cursor.lastSlot).toBe(100);
    expect(cursor.startBlockHash).toBe('aa');
  });

  it('returns the existing cursor without INSERT when the singleton is present', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce({ ID: SINGLETON_ID, lastSlot: '55', lastBlockHash: 'bb', lastHeight: '3', syncStatus: 'syncing' });

    const cursor = await ensureSyncStateSingleton(db as never, 'preview');

    expect(db.run.mock.calls.some(c => (c[0] as { _op?: string })?._op === 'INSERT')).toBe(false);
    expect(cursor.lastSlot).toBe(55);
    expect(cursor.lastBlockHash).toBe('bb');
  });
});

describe('sync-state: readCursor CAP-10 numeric normalization', () => {
  it('coerces Integer64/Decimal string reads back to numbers', async () => {
    const db = makeDb();
    // CAP 10 returns Int64/Decimal columns as STRINGS even via db.run
    db.run.mockResolvedValueOnce({
      lastSlot: '123456789',
      lastHeight: '42',
      tipSlot: '999',
      tipHeight: '50',
      consecutiveErrors: '2',
      syncStatus: 'syncing',
      lastBlockHash: 'cc',
    });

    const cursor = await readCursor(db as never);
    expect(cursor).not.toBeNull();
    expect(cursor!.lastSlot).toBe(123456789);
    expect(typeof cursor!.lastSlot).toBe('number');
    expect(cursor!.lastHeight).toBe(42);
    expect(cursor!.tipHeight).toBe(50);
    expect(cursor!.consecutiveErrors).toBe(2);
    expect(cursor!.syncStatus).toBe('syncing');
  });

  it('returns null when the singleton is absent', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce(undefined);
    expect(await readCursor(db as never)).toBeNull();
  });
});

describe('sync-state: advanceCursor / resetCursorTo / setSyncStatus', () => {
  it('advanceCursor sets the block, marks syncing and clears the error streak', async () => {
    const db = makeDb();
    await advanceCursor(db as never, { slot: 10, hash: 'h', height: 4 }, { slot: 12, height: 5 });

    const set = (db.run.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(set).toMatchObject({
      lastSlot: 10, lastBlockHash: 'h', lastHeight: 4,
      syncStatus: 'syncing', consecutiveErrors: 0, lastError: null,
      tipSlot: 12, tipHeight: 5,
    });
  });

  it('advanceCursor writes the given status (synced at the tip)', async () => {
    const db = makeDb();
    await advanceCursor(db as never, { slot: 12, hash: 'h', height: 5 }, { slot: 12, height: 5 }, 'synced');
    const set = (db.run.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(set.syncStatus).toBe('synced');
  });

  it('resetCursorTo rewinds the cursor to the fork point', async () => {
    const db = makeDb();
    await resetCursorTo(db as never, { slot: 3, hash: 'fork', height: 1 });
    const set = (db.run.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(set).toMatchObject({ lastSlot: 3, lastBlockHash: 'fork', lastHeight: 1 });
  });

  it('setSyncStatus writes only the status', async () => {
    const db = makeDb();
    await setSyncStatus(db as never, 'synced');
    const set = (db.run.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(set).toEqual({ syncStatus: 'synced' });
  });
});

describe('sync-state: recordError circuit breaker', () => {
  it('stays "syncing" below the threshold', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce({ consecutiveErrors: '0', syncStatus: 'syncing' }); // readCursor
    const streak = await recordError(db as never, new Error('boom'));
    expect(streak).toBe(1);
    const set = (db.run.mock.calls[1][0] as { set: Record<string, unknown> }).set;
    expect(set.consecutiveErrors).toBe(1);
    expect(set.syncStatus).toBe('syncing');
  });

  it('flips to "error" once the streak reaches the threshold', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce({ consecutiveErrors: String(MAX_CONSECUTIVE_ERRORS - 1), syncStatus: 'syncing' });
    const streak = await recordError(db as never, new Error('boom'));
    expect(streak).toBe(MAX_CONSECUTIVE_ERRORS);
    const set = (db.run.mock.calls[1][0] as { set: Record<string, unknown> }).set;
    expect(set.syncStatus).toBe('error');
  });

  it('truncates the error message to 500 chars', async () => {
    const db = makeDb();
    db.run.mockResolvedValueOnce({ consecutiveErrors: '0' });
    await recordError(db as never, new Error('x'.repeat(1000)));
    const set = (db.run.mock.calls[1][0] as { set: Record<string, string> }).set;
    expect(set.lastError.length).toBe(500);
  });
});
