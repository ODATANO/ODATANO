/**
 * CIP-68 decimals from the crawled chain (srv/blockchain/asset-decimals.ts) and the catalogue
 * backfill (srv/blockchain/crawler/asset-decimals-backfill.ts) against a tiny in-memory store that
 * interprets the modules' CQL: the reference NFT is followed from its mint to the output that holds
 * it now, a datum by hash comes from TransactionDatums, and every slice of a unit gets the value.
 */

import { DataConstr, DataMap, DataPair, DataB, DataI, dataToCbor } from '@harmoniclabs/plutus-data';

type Row = Record<string, unknown>;
type Query = Row & { _op: string; entity: string; _where?: Row; _orderBy?: string; _limit?: number; _set?: Row };

const tables = new Map<string, Row[]>();
const table = (e: string): Row[] => { if (!tables.has(e)) tables.set(e, []); return tables.get(e)!; };
const cmp = (a: unknown, b: unknown): number => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1);
const matches = (r: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && '>' in (v as Row)) return cmp(r[k], (v as Row)['>']) > 0;
    return r[k] === v;
  });

const fakeTx = {
  run: vi.fn(async (q: Query) => {
    if (q._op === 'UPDATE') {
      let n = 0;
      for (const r of table(q.entity)) if (matches(r, q._where ?? {})) { Object.assign(r, q._set); n++; }
      return n;
    }
    let rows = table(q.entity).filter((r) => matches(r, q._where ?? {}));
    if (q._orderBy) {
      const [field, dir] = q._orderBy.split(' ');
      rows = [...rows].sort((a, b) => cmp(a[field], b[field]) * (dir === 'desc' ? -1 : 1));
    }
    if (q._op === 'SELECT.one') return rows[0] ? { ...rows[0] } : undefined;
    return rows.slice(0, q._limit ?? rows.length).map((r) => ({ ...r }));
  }),
};

vi.mock('@sap/cds', () => {
  const select = (op: string) => (entity: string) => {
    const q: Query = { _op: op, entity };
    Object.assign(q, {
      columns: () => q,
      where: (w: Row) => { q._where = w; return q; },
      orderBy: (o: string) => { q._orderBy = o; return q; },
      limit: (n: number) => { q._limit = n; return q; },
    });
    return q;
  };
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
    ql: {
      SELECT: Object.assign({ from: select('SELECT') }, { one: { from: select('SELECT.one') } }),
      UPDATE: { entity: (entity: string) => ({ set: (_set: Row) => ({ where: (_where: Row) => ({ _op: 'UPDATE', entity, _set, _where }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  Assets: 'Assets', AssetHistory: 'AssetHistory', Transactions: 'Transactions', TransactionInputs: 'TransactionInputs',
  TransactionOutputs: 'TransactionOutputs', TransactionOutputAssets: 'TransactionOutputAssets', TransactionDatums: 'TransactionDatums',
}));

import { cip68Decimals, applyReferenceDatums, setAssetDecimals } from '../../srv/blockchain/asset-decimals';
import { backfillAssetDecimals } from '../../srv/blockchain/crawler/asset-decimals-backfill';
import { CIP68_LABEL } from '../../srv/cbor/cip68';
import type { Transaction } from '../../srv/utils/types';

const POLICY = 'b2'.repeat(28);
const NAME = Buffer.from('INDY').toString('hex');
const REF = POLICY + CIP68_LABEL.reference + NAME;
const FT = POLICY + CIP68_LABEL.ft + NAME;
const RFT = POLICY + CIP68_LABEL.rft + NAME;
const PLAIN = POLICY + Buffer.from('OTHER').toString('hex');
const MINT = 'a1'.repeat(32);
const UPDATE_TX = 'c3'.repeat(32);
const DATUM_HASH = 'd4'.repeat(32);

const hex = (d: Parameters<typeof dataToCbor>[0]): string => Buffer.from(dataToCbor(d) as unknown as Uint8Array).toString('hex');
const datum = (decimals: number) => hex(new DataConstr(0, [
  new DataMap([new DataPair(new DataB(Buffer.from('decimals').toString('hex')), new DataI(decimals))]), new DataI(1),
]));

const input = (txSeq: number, inputIndex: number, over: Row = {}): Row =>
  ({ txSeq, inputIndex, spentTxHash: MINT, spentOutputIndex: 1, isCollateral: false, isReference: false, ...over });

/** The reference NFT minted at MINT#1 with 6 decimals, spent by UPDATE_TX whose output 0 gives the datum by hash. */
function seedTrail(): void {
  tables.set('AssetHistory', [{ unit: REF, txHash: MINT, action: 'mint', blockHeight: 10 }]);
  tables.set('Transactions', [{ hash: MINT, txSeq: 100 }, { hash: UPDATE_TX, txSeq: 200 }]);
  tables.set('TransactionOutputAssets', [
    { output_txSeq: 100, output_outputIndex: 1, unit: REF }, { output_txSeq: 100, output_outputIndex: 0, unit: FT },
    { output_txSeq: 200, output_outputIndex: 0, unit: REF },
  ]);
  tables.set('TransactionOutputs', [
    { txSeq: 100, outputIndex: 1, utxo_inlineDatum: datum(6), utxo_dataHash: null },
    { txSeq: 200, outputIndex: 0, utxo_inlineDatum: null, utxo_dataHash: DATUM_HASH },
  ]);
  tables.set('TransactionInputs', [input(200, 0)]);
  tables.set('TransactionDatums', [{ dataHash: DATUM_HASH, datum: datum(8) }]);
}

const tx = (over: Partial<Transaction>): Transaction => ({
  hash: 'f'.repeat(64), blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0, fee: '0', deposit: '0', size: 0, blockTime: 0,
  inputs: [], outputs: [], ...over,
});
const output = (unit: string, over: Row = {}) => ({
  address: 'addr', amount: [{ unit: 'lovelace', quantity: '2000000' }, { unit, quantity: '1' }], txHash: 'f'.repeat(64), outputIndex: 0,
  dataHash: null, inlineDatum: null, isCollateral: false, ...over,
});

beforeEach(() => { tables.clear(); fakeTx.run.mockClear(); });

describe('cip68Decimals', () => {
  it('follows the reference NFT to the output that holds it now and reads a hashed datum from TransactionDatums', async () => {
    seedTrail();
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(8);
    expect(await cip68Decimals(fakeTx as never, RFT)).toBe(8);
  });

  it('keeps the last datum it saw when the newest output gives none the chain stored', async () => {
    seedTrail();
    tables.set('TransactionDatums', []);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(6);
  });

  it('starts from the latest mint, so a burn and re-mint is not followed into the burn', async () => {
    seedTrail();
    table('AssetHistory').push({ unit: REF, txHash: UPDATE_TX, action: 'mint', blockHeight: 20 });
    tables.set('TransactionInputs', []);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(8);
  });

  it('does not take a transaction that only reads the reference NFT as its spender', async () => {
    seedTrail();
    tables.set('TransactionInputs', [input(150, 0, { isReference: true }), input(200, 0)]);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(8);
    tables.set('TransactionInputs', [input(150, 0, { isReference: true })]);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(6);
  });

  it('takes collateral as the spender only in a phase-2 failure', async () => {
    seedTrail();
    // valid tx 150 lists the output as collateral next to a regular input: not consumed
    tables.set('TransactionInputs', [input(150, 1, { isCollateral: true }), input(150, 0, { spentTxHash: 'e5'.repeat(32) })]);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(6);
    // failed tx 200 is stored with its collateral alone: consumed
    tables.set('TransactionInputs', [input(200, 0, { isCollateral: true })]);
    expect(await cip68Decimals(fakeTx as never, FT)).toBe(8);
  });

  it("tries the token's own mint when AssetHistory has no mint of the reference NFT", async () => {
    seedTrail();
    tables.set('AssetHistory', []);
    expect(await cip68Decimals(fakeTx as never, FT)).toBeNull();
    expect(await cip68Decimals(fakeTx as never, FT, MINT)).toBe(8);
  });

  it('answers null without a lookup for a unit that has no reference NFT', async () => {
    seedTrail();
    expect(await cip68Decimals(fakeTx as never, PLAIN)).toBeNull();
    expect(await cip68Decimals(fakeTx as never, REF)).toBeNull();
    expect(fakeTx.run).not.toHaveBeenCalled();
  });

  it('answers null when the trail breaks before any datum', async () => {
    seedTrail();
    tables.set('TransactionOutputAssets', []);
    expect(await cip68Decimals(fakeTx as never, FT)).toBeNull();
  });
});

describe('setAssetDecimals / applyReferenceDatums', () => {
  it('writes every slice of the unit and reports the rows changed', async () => {
    tables.set('Assets', [{ unit: FT, decimals: null }, { unit: FT, decimals: 0 }, { unit: PLAIN, decimals: null }]);
    expect(await setAssetDecimals(fakeTx as never, FT, 6)).toBe(2);
    expect(table('Assets').map((r) => r.decimals)).toEqual([6, 6, null]);
  });

  it('applies the inline datum of a reference-NFT output to the label-333 and label-444 units', async () => {
    tables.set('Assets', [{ unit: FT, decimals: null }, { unit: RFT, decimals: null }, { unit: REF, decimals: null }, { unit: PLAIN, decimals: null }]);
    const changed = await applyReferenceDatums(fakeTx as never, [tx({ outputs: [output(REF, { inlineDatum: datum(6) })] })]);
    expect(changed).toBe(2);
    expect(table('Assets').map((r) => [r.unit, r.decimals])).toEqual([[FT, 6], [RFT, 6], [REF, null], [PLAIN, null]]);
  });

  it('resolves a datum hash from the witness datums of the transaction, else from TransactionDatums', async () => {
    tables.set('Assets', [{ unit: FT, decimals: null }]);
    tables.set('TransactionDatums', [{ dataHash: DATUM_HASH, datum: datum(3) }]);
    const witnessed = tx({ outputs: [output(REF, { dataHash: 'e5'.repeat(32) })], datums: [{ hash: 'e5'.repeat(32), cbor: datum(2) }] });
    const stored = tx({ outputs: [output(REF, { dataHash: DATUM_HASH })] });
    await applyReferenceDatums(fakeTx as never, [witnessed]);
    expect(table('Assets')[0].decimals).toBe(2);
    await applyReferenceDatums(fakeTx as never, [stored]);
    expect(table('Assets')[0].decimals).toBe(3);
  });

  it('touches nothing for outputs without a reference NFT or without decimals in the datum', async () => {
    tables.set('Assets', [{ unit: FT, decimals: null }]);
    const noDecimals = hex(new DataConstr(0, [new DataMap([]), new DataI(1)]));
    const changed = await applyReferenceDatums(fakeTx as never, [
      tx({ outputs: [output(FT, { inlineDatum: datum(6) }), output(REF, { inlineDatum: noDecimals }), output(REF)] }),
    ]);
    expect(changed).toBe(0);
    expect(fakeTx.run.mock.calls.some(([q]) => (q as Query)._op === 'UPDATE')).toBe(false);
  });
});

describe('backfillAssetDecimals', () => {
  it('pages the catalogue by unit, resolves each label-333/444 unit once and fills all its slices', async () => {
    seedTrail();
    // ordered by unit: REF < FT < RFT < PLAIN (labels 000643b0 < 0014df10 < 001bc280 < 4f...)
    tables.set('Assets', [
      { unit: PLAIN, initialMintTxHash: null, decimals: null },
      { unit: FT, initialMintTxHash: null, decimals: null },
      { unit: FT, initialMintTxHash: MINT, decimals: 0 },
      { unit: RFT, initialMintTxHash: null, decimals: null },
      { unit: REF, initialMintTxHash: null, decimals: null },
    ]);
    const seen: unknown[] = [];

    const r = await backfillAssetDecimals({ chunkSize: 2, onProgress: (p) => seen.push(p) });

    expect(r).toEqual({ scanned: 5, candidates: 2, filled: 2 });
    expect(table('Assets').map((x) => [x.unit, x.decimals])).toEqual([[PLAIN, null], [FT, 8], [FT, 8], [RFT, 8], [REF, null]]);
    expect(seen.at(-1)).toEqual(r);
    // page queries carry the unit cursor only, never a column predicate
    const pages = fakeTx.run.mock.calls.map(([q]) => q as Query).filter((q) => q._op === 'SELECT' && q.entity === 'Assets');
    expect(pages.length).toBeGreaterThan(1);
    for (const q of pages) expect(Object.keys(q._where ?? {}).every((k) => k === 'unit')).toBe(true);
  });

  it("uses the token's own mint from an enriched slice when the reference mint is not in AssetHistory", async () => {
    seedTrail();
    tables.set('AssetHistory', []);
    tables.set('Assets', [{ unit: FT, initialMintTxHash: null, decimals: null }, { unit: FT, initialMintTxHash: MINT, decimals: null }]);
    expect(await backfillAssetDecimals({ chunkSize: 5 })).toEqual({ scanned: 2, candidates: 1, filled: 1 });
    expect(table('Assets').map((x) => x.decimals)).toEqual([8, 8]);
  });

  it('is complete and idle on an empty or label-free catalogue', async () => {
    tables.set('Assets', [{ unit: PLAIN, initialMintTxHash: null, decimals: null }]);
    expect(await backfillAssetDecimals()).toEqual({ scanned: 1, candidates: 0, filled: 0 });
    tables.set('Assets', []);
    expect(await backfillAssetDecimals()).toEqual({ scanned: 0, candidates: 0, filled: 0 });
  });
});
