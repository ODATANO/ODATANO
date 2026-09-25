/**
 * Certificate backfill — a second chain-sync stream over already crawled blocks that writes
 * the certificate and withdrawal tables only. The CQL/tx layer is mocked like in the engine
 * tests; the fake backend replays scripted blocks through the callbacks.
 */
type Q = { _op: string; entity: string; _where?: any; entries?: unknown };
const { dbRun, fakeDb } = vi.hoisted(() => {
  const dbRun = vi.fn<(q: Q) => Promise<unknown>>();
  return { dbRun, fakeDb: { run: dbRun } };
});
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
    ql: {
      SELECT: {
        one: {
          // one object that is both the builder and the query the fake db receives
          from: (entity: string) => {
            const q: any = { _op: 'SELECT.one', entity };
            q.columns = () => q;
            q.where = (where: unknown) => { q._where = where; return q; };
            q.orderBy = () => q;
            return q;
          },
        },
          from: (entity: string) => {
          const q: any = { _op: 'SELECT.many', entity };
          q.columns = () => q;
          q.where = (where: unknown) => { q._where = where; return q; };
          return q;
        },
      },
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({
  Block: 'odatano.cardano.Blocks',
  TransactionCertificates: 'odatano.cardano.TransactionCertificates',
  TransactionWithdrawals: 'odatano.cardano.TransactionWithdrawals',
}));
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  readCursor: vi.fn(async () => ({ startSlot: 100, startBlockHash: 'start', lastSlot: 900 })),
}));

import { backfillCertificates, intersectionBefore } from '../../srv/blockchain/crawler/certificate-backfill';
import type { ChainSyncCallbacks, ChainSyncHandle } from '../../srv/blockchain/backends/cardano-backend';

const block = (slot: number, hash: string) => ({ time: slot, height: slot, hash, slot, slotLeader: '' }) as any;
const tx = (hash: string, certs: any[] = [], withdrawals: any[] = []) => ({ hash, certificates: certs, withdrawals }) as any;

/** Blocks the index knows, by hash and slot: the intersection query (newest below) and the batch range query. */
function fakeIndex(known: Record<string, number>) {
  dbRun.mockImplementation(async (q: Q) => {
    if (q.entity !== 'odatano.cardano.Blocks') return undefined;
    const w = q._where;
    if (q._op === 'SELECT.one') {
      const inRange = (s: number) => ('<' in w.slot ? s < w.slot['<'] : s >= w.slot.between && s <= w.slot.and);
      const below = Object.entries(known).filter(([, s]) => inRange(s)).sort((a, b) => b[1] - a[1])[0];
      return below ? { hash: below[0], slot: below[1] } : null;
    }
    const { between, and } = w.slot;
    return Object.entries(known).filter(([, s]) => s >= between && s <= and).map(([hash]) => ({ hash }));
  });
}

function fakeClient(script: Array<[ReturnType<typeof block>, any[]]>, afterScript?: (cb: ChainSyncCallbacks) => Promise<void>) {
  const closed = vi.fn(async () => undefined);
  const opened: unknown[] = [];
  const backend = {
    openChainSync: vi.fn(async (from: unknown, cb: ChainSyncCallbacks): Promise<ChainSyncHandle> => {
      opened.push(from);
      void (async () => {
        await cb.rollBackward({ slot: 0, hash: 'x' });   // the handshake
        for (const [b, txs] of script) await cb.rollForward(b, txs);
        await afterScript?.(cb);
      })();
      return { close: closed };
    }),
  };
  return { client: { getChainSyncBackend: () => backend } as any, closed, opened };
}

beforeEach(() => { dbRun.mockReset(); });

describe('intersectionBefore', () => {
  it('takes the newest indexed block below the slot, else the crawl start point', async () => {
    fakeIndex({ a: 100, b: 200, c: 300 });
    expect(await intersectionBefore(fakeDb as any, 250)).toEqual({ hash: 'b', slot: 200, height: undefined });
    expect(await intersectionBefore(fakeDb as any, 100)).toEqual({ slot: 100, hash: 'start' });
  });

  it('ignores indexed blocks below the crawl start', async () => {
    fakeIndex({ lazy: 50, start: 100, b: 200 });
    expect(await intersectionBefore(fakeDb as any, 150)).toEqual({ hash: 'start', slot: 100, height: undefined });
    expect(await intersectionBefore(fakeDb as any, 100)).toEqual({ slot: 100, hash: 'start' });
    expect(await intersectionBefore(fakeDb as any, 80)).toEqual({ slot: 100, hash: 'start' });
  });
});

describe('backfillCertificates', () => {
  it('writes certificates and withdrawals of known blocks in the range, skips the rest, ends at toSlot', async () => {
    fakeIndex({ start: 100, b1: 110, b2: 120, b3: 130, b4: 140 });
    const { client, closed, opened } = fakeClient([
      [block(105, 'before'), [tx('t0', [{ certIndex: 0, kind: 'stake_registration', stakeAddress: 'stake1' }])]],   // below fromSlot
      [block(110, 'b1'), [tx('t1', [{ certIndex: 0, kind: 'pool_delegation', stakeAddress: 'stake1', poolId: 'pool1' }], [{ stakeAddress: 'stake1', amount: '5' }])]],
      [block(120, 'orphan'), [tx('t2', [{ certIndex: 0, kind: 'pool_retirement', poolId: 'pool1', epoch: 9 }])]],  // not in the index
      [block(130, 'b3'), [tx('t3'), tx('t4', [{ certIndex: 1, kind: 'vote_delegation', stakeAddress: 'stake1', drepId: 'drep1' }])]],
      [block(140, 'b4'), [tx('t5', [{ certIndex: 0, kind: 'stake_deregistration', stakeAddress: 'stake1', deposit: 2000000 }])]],  // past toSlot
    ]);
    const progress: number[] = [];
    const r = await backfillCertificates({ client, fromSlot: 110, toSlot: 130, batchBlocks: 1, onProgress: (p) => progress.push(p.blocks) });

    expect(opened[0]).toEqual([{ hash: 'start', slot: 100, height: undefined }]);
    expect(r.blocks).toBe(2);
    expect(r.transactions).toBe(3);
    expect(r.certificates).toBe(2);
    expect(r.withdrawals).toBe(1);
    expect(r.atSlot).toBe(130);
    expect(closed).toHaveBeenCalled();

    const upserts = dbRun.mock.calls.map(([q]) => q).filter((q) => q._op === 'UPSERT');
    expect(upserts.map((q) => q.entity)).toEqual([
      'odatano.cardano.TransactionCertificates', 'odatano.cardano.TransactionWithdrawals', 'odatano.cardano.TransactionCertificates',
    ]);
    expect(upserts[0].entries).toEqual([{ tx_hash: 't1', certIndex: 0, kind: 'pool_delegation', stakeAddress: 'stake1', poolId: 'pool1', drepId: null, deposit: null, epoch: null }]);
    expect(upserts[1].entries).toEqual([{ tx_hash: 't1', stakeAddress: 'stake1', lovelace: '5' }]);
    expect(upserts[2].entries).toEqual([{ tx_hash: 't4', certIndex: 1, kind: 'vote_delegation', stakeAddress: 'stake1', poolId: null, drepId: 'drep1', deposit: null, epoch: null }]);
    expect(progress).toEqual([1, 1, 2]);   // one report per batch; the skipped block's batch reports the unchanged count
  });

  it('ends at the first block past toSlot when no block sits on it, and rejects a stream error', async () => {
    fakeIndex({ start: 100, b1: 110 });
    const past = fakeClient([[block(110, 'b1'), [tx('t1')]], [block(131, 'b5'), [tx('t9', [{ certIndex: 0, kind: 'pool_registration', poolId: 'p' }])]]]);
    const r = await backfillCertificates({ client: past.client, fromSlot: 100, toSlot: 130 });
    expect(r.blocks).toBe(1);
    expect(r.certificates).toBe(0);

    const broken = fakeClient([], async (cb) => { await cb.onError?.(new Error('socket closed')); });
    await expect(backfillCertificates({ client: broken.client, fromSlot: 100, toSlot: 130 })).rejects.toThrow('socket closed');
  });

  it('refuses a bad range and a client without chain-sync', async () => {
    await expect(backfillCertificates({ client: { getChainSyncBackend: () => null } as any, fromSlot: 1, toSlot: 2 })).rejects.toThrow(/chain-sync/);
    await expect(backfillCertificates({ client: {} as any, fromSlot: 5, toSlot: 2 })).rejects.toThrow(/Invalid slot range/);
  });
});
