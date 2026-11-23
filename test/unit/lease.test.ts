/**
 * The shared lease (srv/utils/lease.ts) on the real model in an in-memory SQLite: takeover only
 * of an expired lease, a renewal that lands first wins, requirements on the row, owner-only release.
 */
import cds from '@sap/cds';
import path from 'path';
import { tryAcquireLease, renewLease, releaseLease, type LeaseRow } from '../../srv/utils/lease';

const { SELECT, INSERT, DELETE } = cds.ql;
const STATE = 'odatano.cardano.CardanoSyncState';
const WALLETS = 'odatano.cardano.CardanoWorkerWallets';
const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const TTL = 15_000;

const crawler: LeaseRow = {
  entity: STATE,
  key: { ID: 'SINGLETON' },
  requires: { desiredRunning: true },
  holds: (row) => row.desiredRunning !== false,
};
const wallet: LeaseRow = { entity: WALLETS, key: { walletId: 'w1' } };
const owner = async (lease: LeaseRow) =>
  ((await cds.run(SELECT.one.from(lease.entity as never).where(lease.key))) as { leaseOwner?: string | null } | undefined)?.leaseOwner ?? null;
const run = <T>(fn: (tx: cds.Transaction) => Promise<T>) => cds.tx(fn) as Promise<T>;

beforeAll(async () => {
  const csn = await cds.load(path.resolve(__dirname, '../../db'));
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  // cds.deploy is not part of the published typings
  await (cds as unknown as { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } }).deploy(csn).to(db);
});

beforeEach(async () => {
  await cds.run(DELETE.from(STATE));
  await cds.run(DELETE.from(WALLETS));
  await cds.run(INSERT.into(STATE).entries({ ID: 'SINGLETON', network: 'preview', desiredRunning: true }));
  await cds.run(INSERT.into(WALLETS).entries({ walletId: 'w1', signerType: 'software', enabled: true }));
});

describe('tryAcquireLease', () => {
  it('takes a free lease and refuses a second owner while it is live', async () => {
    expect(await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }))).toBe(true);
    expect(await run((tx) => tryAcquireLease(tx, crawler, 'B', { now: at(5_000), ttlMs: TTL }))).toBe(false);
    expect(await owner(crawler)).toBe('A');
  });

  it('takes an expired lease', async () => {
    await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }));
    expect(await run((tx) => tryAcquireLease(tx, crawler, 'B', { now: at(20_000), ttlMs: TTL }))).toBe(true);
    expect(await owner(crawler)).toBe('B');
  });

  it('leaves a lease alone that was renewed between the taker reading it and its UPDATE', async () => {
    await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }));
    // B reads A's lease as expired at t+16s; A renews (until t+31s) before B's UPDATE runs
    const taken = await run(async (tx) => {
      const racing = {
        run: async (q: unknown) => {
          if ((q as { UPDATE?: unknown }).UPDATE) await cds.run(cds.ql.UPDATE.entity(STATE).set({ leaseUntil: at(31_000).toISOString() }).where({ ID: 'SINGLETON' }));
          return tx.run(q as never);
        },
      };
      return tryAcquireLease(racing as never, crawler, 'B', { now: at(16_000), ttlMs: TTL });
    });
    expect(taken).toBe(false);
    expect(await owner(crawler)).toBe('A');
  });

  it('refuses a row that fails the requirement or the admit check', async () => {
    await cds.run(cds.ql.UPDATE.entity(STATE).set({ desiredRunning: false }).where({ ID: 'SINGLETON' }));
    expect(await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }))).toBe(false);
    expect(await run((tx) => tryAcquireLease(tx, wallet, 'A', { now: T0, ttlMs: TTL }, () => false))).toBe(false);
    expect(await run((tx) => tryAcquireLease(tx, wallet, 'A', { now: T0, ttlMs: TTL }, () => true))).toBe(true);
  });
});

describe('renewLease and releaseLease', () => {
  it('renews only for the owner and writes the extra columns in the same statement', async () => {
    await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }));
    expect(await run((tx) => renewLease(tx, crawler, 'B', { now: at(1_000), ttlMs: TTL }))).toBe(false);
    expect(await run((tx) => renewLease(tx, crawler, 'A', { now: at(1_000), ttlMs: TTL }, { lastSlot: 42 }))).toBe(true);
    const row = await cds.run(SELECT.one.from(STATE).where({ ID: 'SINGLETON' })) as { lastSlot: unknown };
    expect(Number(row.lastSlot)).toBe(42);
  });

  it('fences a renewal once the cluster is paused', async () => {
    await run((tx) => tryAcquireLease(tx, crawler, 'A', { now: T0, ttlMs: TTL }));
    await cds.run(cds.ql.UPDATE.entity(STATE).set({ desiredRunning: false }).where({ ID: 'SINGLETON' }));
    expect(await run((tx) => renewLease(tx, crawler, 'A', { now: at(1_000), ttlMs: TTL }))).toBe(false);
  });

  it('releases only the caller lease', async () => {
    await run((tx) => tryAcquireLease(tx, wallet, 'A', { now: T0, ttlMs: TTL }));
    await run((tx) => releaseLease(tx, wallet, 'B'));
    expect(await owner(wallet)).toBe('A');
    await run((tx) => releaseLease(tx, wallet, 'A'));
    expect(await owner(wallet)).toBeNull();
  });
});
