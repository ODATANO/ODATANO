/**
 * Output datum repair: outputs with a datum hash and no inline datum are read again, and what the
 * backend returns goes to the output, to the inputs that spent it and to its UTxO set row.
 * CQL is mocked; the fake db answers by entity and records every UPDATE.
 */
export {};

type Q = { _op: string; entity: string; _where?: Record<string, any>; _set?: Record<string, unknown>; _limit?: number };
const { dbRun } = vi.hoisted(() => ({ dbRun: vi.fn<(q: Q) => Promise<unknown>>() }));

vi.mock('@sap/cds', () => {
  const select = (entity: string) => {
    const q: any = { _op: 'SELECT', entity };
    q.columns = () => q;
    q.where = (where: unknown) => { q._where = where; return q; };
    q.orderBy = () => q;
    q.limit = (n: number) => { q._limit = n; return q; };
    return q;
  };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: (fn: (db: { run: typeof dbRun }) => unknown) => fn({ run: dbRun }),
    ql: {
      SELECT: { from: select },
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, _set: set, _where: where }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({
  Transactions: 'Transactions', TransactionInputs: 'TransactionInputs', TransactionOutputs: 'TransactionOutputs', LedgerUTxOs: 'LedgerUTxOs',
}));

import { backfillOutputDatums, fillOutputFields, OutputDatumBackfillError } from '../../srv/blockchain/crawler/output-datum-backfill';
import type { Transaction, TxOutputLine } from '../../srv/utils/types';

const HASH = 'a'.repeat(64);
const DATUM_HASH = 'd'.repeat(64);
const SEQ = 7 * 65536;

const output = (outputIndex: number, over: Partial<TxOutputLine> = {}): TxOutputLine =>
  ({ address: 'addr', amount: [], txHash: HASH, outputIndex, dataHash: null, inlineDatum: null, isCollateral: false, ...over });
const stored = (outputIndex: number, over: Record<string, unknown> = {}) => ({
  txSeq: SEQ, outputIndex, utxo_dataHash: null, utxo_inlineDatum: null,
  utxo_referenceScriptHash: null, utxo_referenceScriptSize: null, utxo_referenceScriptType: null, ...over,
});

/** UPDATE statements the fake db saw for one entity. */
const updates = (entity: string) => dbRun.mock.calls.map(([q]) => q).filter((q) => q._op === 'UPDATE' && q.entity === entity);

/** Stored outputs by page; UPDATEs answer with the given affected rows. */
function fakeDb(outputs: Array<Record<string, unknown>>, affected: Record<string, number> = {}) {
  dbRun.mockImplementation(async (q: Q) => {
    if (q._op === 'UPDATE') return affected[q.entity] ?? 1;
    if (q.entity === 'Transactions') return [{ hash: HASH, txSeq: SEQ }];
    if (q.entity === 'TransactionOutputs') {
      const after = q._where?.txSeq?.['>'];
      const rows = after == null ? outputs : outputs.filter((r) => Number(r.txSeq) > after);
      return q._limit ? rows.slice(0, q._limit) : rows;
    }
    return [];
  });
}

beforeEach(() => { dbRun.mockReset(); });

describe('fillOutputFields', () => {
  it('writes the inline datum to the output, the spending input and the UTxO set row', async () => {
    fakeDb([stored(0, { utxo_dataHash: DATUM_HASH })], { TransactionInputs: 2, LedgerUTxOs: 1 });

    const counts = await fillOutputFields({ run: dbRun } as never, [
      { hash: HASH, txSeq: SEQ, outputs: [output(0, { dataHash: DATUM_HASH, inlineDatum: 'd87980' })] },
    ]);

    expect(counts).toEqual({ outputs: 1, inputs: 2, ledgerUtxos: 1 });
    expect(updates('TransactionOutputs')).toEqual([expect.objectContaining({
      _set: { utxo_inlineDatum: 'd87980' }, _where: { txSeq: SEQ, outputIndex: 0 },
    })]);
    expect(updates('TransactionInputs')).toEqual([expect.objectContaining({
      _set: { utxoData_inlineDatum: 'd87980' },
      _where: { spentTxHash: HASH, spentOutputIndex: 0, utxoData_inlineDatum: null },
    })]);
    expect(updates('LedgerUTxOs')).toEqual([expect.objectContaining({
      _set: { utxo_inlineDatum: 'd87980' }, _where: { txHash: HASH, outputIndex: 0, utxo_inlineDatum: null },
    })]);
  });

  it('fills the reference-script fields the output lacks, one guarded statement per field', async () => {
    fakeDb([stored(1)], { TransactionInputs: 0, LedgerUTxOs: 1 });

    const counts = await fillOutputFields({ run: dbRun } as never, [
      { hash: HASH, txSeq: SEQ, outputs: [output(1, { referenceScriptHash: 'e'.repeat(56), referenceScriptSize: 420, referenceScriptType: 'plutusV3' })] },
    ]);

    expect(counts).toEqual({ outputs: 1, inputs: 0, ledgerUtxos: 1 });
    expect(updates('TransactionOutputs')[0]._set).toEqual({
      utxo_referenceScriptHash: 'e'.repeat(56), utxo_referenceScriptSize: 420, utxo_referenceScriptType: 'plutusV3',
    });
    expect(updates('LedgerUTxOs').map((q) => Object.keys(q._set!)[0])).toEqual([
      'utxo_referenceScriptHash', 'utxo_referenceScriptSize', 'utxo_referenceScriptType',
    ]);
  });

  it('never overwrites a stored value and writes nothing for a hash-only datum', async () => {
    fakeDb([
      stored(0, { utxo_dataHash: DATUM_HASH, utxo_inlineDatum: 'd87980' }),
      stored(1, { utxo_dataHash: DATUM_HASH }),
    ]);

    const counts = await fillOutputFields({ run: dbRun } as never, [{
      hash: HASH, txSeq: SEQ,
      outputs: [output(0, { dataHash: DATUM_HASH, inlineDatum: 'ffff' }), output(1, { dataHash: DATUM_HASH })],
    }]);

    expect(counts).toEqual({ outputs: 0, inputs: 0, ledgerUtxos: 0 });
    expect(dbRun.mock.calls.filter(([q]) => q._op === 'UPDATE')).toEqual([]);
  });

  it('skips a stored output the source does not carry', async () => {
    fakeDb([stored(5, { utxo_dataHash: DATUM_HASH })]);

    const counts = await fillOutputFields({ run: dbRun } as never, [{ hash: HASH, txSeq: SEQ, outputs: [output(0, { inlineDatum: 'd87980' })] }]);

    expect(counts.outputs).toBe(0);
  });
});

describe('backfillOutputDatums', () => {
  const fresh = (outputs: TxOutputLine[]) => new Map([[HASH, { hash: HASH, outputs } as Transaction]]);
  const makeClient = (read: Map<string, Transaction> = new Map()) => ({
    supports: vi.fn(() => true),
    getTransactionsBatch: vi.fn(async () => read),
  });

  it('refuses to run when no backend serves transactions', async () => {
    const client = makeClient();
    client.supports.mockReturnValue(false);

    await expect(backfillOutputDatums({ client })).rejects.toBeInstanceOf(OutputDatumBackfillError);
    expect(client.supports).toHaveBeenCalledWith('getTransaction');
    expect(dbRun).not.toHaveBeenCalled();
  });

  it('reads again only transactions with a datum hash and no inline datum', async () => {
    fakeDb([
      stored(0, { utxo_dataHash: DATUM_HASH }),
      stored(1),
      { ...stored(0, { utxo_dataHash: DATUM_HASH, utxo_inlineDatum: 'd87980' }), txSeq: SEQ + 1 },
    ]);
    const client = makeClient(fresh([output(0, { dataHash: DATUM_HASH, inlineDatum: 'd87980' }), output(1)]));

    const progress = await backfillOutputDatums({ client });

    expect(client.getTransactionsBatch).toHaveBeenCalledTimes(1);
    expect(client.getTransactionsBatch).toHaveBeenCalledWith([HASH]);
    expect(progress).toEqual({ scanned: 3, candidates: 1, transactions: 1, missing: 0, outputs: 1, inputs: 1, ledgerUtxos: 1 });
  });

  it('counts a candidate transaction the backend does not return and writes nothing for it', async () => {
    fakeDb([stored(0, { utxo_dataHash: DATUM_HASH })]);
    const client = makeClient(new Map());

    const progress = await backfillOutputDatums({ client });

    expect(progress).toMatchObject({ candidates: 1, transactions: 0, missing: 1, outputs: 0 });
    expect(dbRun.mock.calls.filter(([q]) => q._op === 'UPDATE')).toEqual([]);
  });

  it('asks no backend when nothing is a candidate', async () => {
    fakeDb([stored(0), stored(1, { utxo_dataHash: DATUM_HASH, utxo_inlineDatum: 'd87980' })]);
    const client = makeClient();

    const progress = await backfillOutputDatums({ client });

    expect(client.getTransactionsBatch).not.toHaveBeenCalled();
    expect(progress).toMatchObject({ scanned: 2, candidates: 0 });
  });

  it('pages by transaction: the last transaction of a full page waits for the next one', async () => {
    const rows = [
      { ...stored(0), txSeq: 1 }, { ...stored(1), txSeq: 1 },
      { ...stored(0, { utxo_dataHash: DATUM_HASH }), txSeq: 2 }, { ...stored(1), txSeq: 2 },
    ];
    fakeDb(rows);
    const client = makeClient(fresh([output(0, { dataHash: DATUM_HASH, inlineDatum: 'd87980' })]));
    const pages: number[] = [];

    const progress = await backfillOutputDatums({ client, chunkSize: 3, onProgress: (p) => pages.push(p.scanned) });

    // page 1 holds tx 1 and half of tx 2: only tx 1 counts; page 2 starts after tx 1 and holds tx 2 whole
    expect(pages).toEqual([2, 4]);
    expect(progress.candidates).toBe(1);
    expect(client.getTransactionsBatch).toHaveBeenCalledTimes(1);
  });
});
