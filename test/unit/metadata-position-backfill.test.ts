/**
 * Metadata position fill: every TransactionMetadata row without a chain position takes the txSeq
 * of its transaction, one statement per slot window. CQL is mocked; the fake db records the calls.
 */
export {};

type Q = { _op: string; entity: string; _where?: Record<string, any>; _set?: Record<string, unknown> };
const { dbRun, state } = vi.hoisted(() => ({
  dbRun: vi.fn<(q: Q | string, params?: unknown[]) => Promise<unknown>>(),
  state: { kind: 'sqlite' },
}));

vi.mock('@sap/cds', () => {
  const select = (op: string) => (entity: string) => {
    const q: any = { _op: op, entity };
    q.columns = () => q;
    q.where = (where: unknown) => { q._where = where; return q; };
    return q;
  };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: (fn: (db: { run: typeof dbRun }) => unknown) => fn({ run: dbRun }),
    get db() { return { kind: state.kind }; },
    ql: {
      SELECT: Object.assign({ one: { from: select('SELECT.one') } }, { from: select('SELECT') }),
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, _set: set, _where: where }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({ Transactions: 'Transactions', TransactionMetadata: 'TransactionMetadata' }));
vi.mock('../../srv/utils/mappers', () => ({ TX_SEQ_SLOT_FACTOR: 65536 }));

import { backfillMetadataPositions, metadataPositionStatement } from '../../srv/blockchain/crawler/metadata-position-backfill';

const F = 65536;

/** Stored transactions span slots lo..hi; every bulk statement fills `perWindow` rows. */
function fakeDb(lo: number | null, hi: number | null, perWindow = 3, txs: Array<{ hash: string; txSeq: number }> = []) {
  dbRun.mockImplementation(async (q) => {
    if (typeof q === 'string') return { changes: perWindow };
    if (q._op === 'SELECT.one') return lo == null ? { lo: null, hi: null } : { lo: lo * F + 2, hi: hi! * F + 7 };
    if (q._op === 'SELECT') return txs.filter((t) => t.txSeq >= q._where!.txSeq['>='] && t.txSeq < q._where!.txSeq['<']);
    return 1;
  });
}
const statements = () => dbRun.mock.calls.filter(([q]) => typeof q === 'string') as Array<[string, number[]]>;

beforeEach(() => { dbRun.mockReset(); state.kind = 'sqlite'; });

describe('backfillMetadataPositions', () => {
  it('walks the stored range in slot windows and sums the filled rows', async () => {
    fakeDb(100, 250);
    const seen: number[] = [];

    const r = await backfillMetadataPositions({ slotWindow: 100, onProgress: (p) => seen.push(p.atSlot) });

    expect(statements().map(([, params]) => params)).toEqual([[100 * F, 200 * F], [200 * F, 300 * F]]);
    expect(statements()[0][0]).toBe(metadataPositionStatement('sqlite'));
    expect(seen).toEqual([199, 250]);
    expect(r).toEqual({ atSlot: 250, toSlot: 250, rows: 6 });
  });

  it('does nothing without stored transactions', async () => {
    fakeDb(null, null);

    await expect(backfillMetadataPositions()).resolves.toEqual({ atSlot: 0, toSlot: 0, rows: 0 });
    expect(statements()).toEqual([]);
  });

  it('updates transaction by transaction on a database without the bulk statement', async () => {
    state.kind = 'hana';
    fakeDb(10, 10, 0, [{ hash: 'h1', txSeq: 10 * F }, { hash: 'h2', txSeq: 10 * F + 1 }]);

    const r = await backfillMetadataPositions({ slotWindow: 5 });

    const updates = dbRun.mock.calls.map(([q]) => q as Q).filter((q) => q._op === 'UPDATE');
    expect(updates).toEqual([
      expect.objectContaining({ entity: 'TransactionMetadata', _set: { txSeq: 10 * F }, _where: { tx_hash: 'h1', txSeq: null } }),
      expect.objectContaining({ entity: 'TransactionMetadata', _set: { txSeq: 10 * F + 1 }, _where: { tx_hash: 'h2', txSeq: null } }),
    ]);
    expect(r.rows).toBe(2);
  });
});

describe('metadataPositionStatement', () => {
  it('joins the transaction row, touches only rows without a position and binds the window', () => {
    const pg = metadataPositionStatement('postgres')!;
    expect(pg).toContain('SET txSeq = t.txSeq FROM odatano_cardano_Transactions AS t');
    expect(pg).toContain('m.txSeq IS NULL');
    expect(pg).toContain('t.txSeq >= $1 AND t.txSeq < $2');
    expect(metadataPositionStatement('sqlite')).toContain('t.txSeq >= ? AND t.txSeq < ?');
    expect(metadataPositionStatement('better-sqlite')).toBe(metadataPositionStatement('sqlite'));
    expect(metadataPositionStatement('hana')).toBeNull();
  });
});
