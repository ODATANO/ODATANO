/**
 * Transaction backfill — a second chain-sync stream over already crawled blocks that fills
 * empty input fields (outpoint, datum, address) and the redeemers. CQL is mocked; the fake
 * backend replays scripted blocks, the resolver stands in for CardanoIndexer.resolveInputs.
 */
type Q = { _op: string; entity: string; _where?: any; _set?: any; entries?: unknown };
const { dbRun, fakeDb } = vi.hoisted(() => {
  const dbRun = vi.fn<(q: Q) => Promise<unknown>>();
  return { dbRun, fakeDb: { run: dbRun } };
});
vi.mock('@sap/cds', () => {
  const select = (op: string) => (entity: string) => {
    const q: any = { _op: op, entity };
    q.columns = () => q;
    q.where = (where: unknown) => { q._where = where; return q; };
    q.orderBy = () => q;
    return q;
  };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
    ql: {
      SELECT: Object.assign({ one: { from: select('SELECT.one') } }, { from: select('SELECT.many') }),
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, _set: set, _where: where }) }) }) },
      DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, _where: where }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({
  Block: 'Blocks',
  TransactionCertificates: 'TransactionCertificates',
  TransactionWithdrawals: 'TransactionWithdrawals',
  TransactionInputs: 'TransactionInputs',
  TransactionInputAssets: 'TransactionInputAssets',
  TransactionRedeemers: 'TransactionRedeemers',
  TransactionOutputs: 'TransactionOutputs',
  TransactionOutputAssets: 'TransactionOutputAssets',
}));
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  readCursor: vi.fn(async () => ({ startSlot: 100, startBlockHash: 'start', lastSlot: 900 })),
}));

import cds from '@sap/cds';
import { backfillTransactions, inputFillStatement } from '../../srv/blockchain/crawler/transaction-backfill';
import type { ChainSyncCallbacks, ChainSyncHandle } from '../../srv/blockchain/backends/cardano-backend';
import type { Transaction, TxInputLine } from '../../srv/utils/types';

const SLOT = 110;
const SEQ = SLOT * 65536;
const A = 'a'.repeat(64), B = 'b'.repeat(64), T = 'c'.repeat(64);

const block = (slot: number, hash: string) => ({ time: slot, height: slot, hash, slot, slotLeader: '' }) as any;
const bare = (txHash: string, outputIndex: number, flags: Partial<TxInputLine> = {}): TxInputLine =>
  ({ address: '', amount: [], txHash, outputIndex, ...flags });
const chainTx = (inputs: TxInputLine[], over: Partial<Transaction> = {}): Transaction => ({
  hash: T, blockHash: 'b1', blockHeight: SLOT, slot: SLOT, index: 0, fee: '0', deposit: '0', size: null, blockTime: 0,
  inputs, outputs: [], redeemers: [], ...over,
});

/** Spent outputs the resolver knows: outpoint -> address, lovelace, inline datum. */
const known: Record<string, { address: string; lovelace: string; inlineDatum?: string }> = {
  [`${A}#0`]: { address: 'addrA', lovelace: '5000000', inlineDatum: 'd87980' },
  [`${B}#1`]: { address: 'addrB', lovelace: '2000000' },
};
const resolver = {
  resolveInputs: vi.fn(async (_tx: unknown, txs: Transaction[]) => {
    for (const t of txs) for (const i of t.inputs) {
      const k = known[`${i.txHash}#${i.outputIndex}`];
      if (!k) continue;
      i.address = k.address;
      i.amount = [{ unit: 'lovelace', quantity: k.lovelace }];
      i.inlineDatum = k.inlineDatum ?? null;
    }
  }),
};

type Row = Record<string, unknown>;
function fakeIndex(inputs: Row[], lovelace: Row[] = [], assets: Row[] = lovelace, outputs: Row[] = []) {
  dbRun.mockImplementation(async (q: Q) => {
    if (q.entity === 'Blocks') {
      if (q._op === 'SELECT.one') return { hash: 'start', slot: 100 };
      return [{ hash: 'b1' }];
    }
    if (q.entity === 'TransactionInputs' && q._op === 'SELECT.many') return inputs;
    if (q.entity === 'TransactionOutputs' && q._op === 'SELECT.many') return outputs;
    if (q.entity === 'TransactionInputAssets' && q._op === 'SELECT.many') return q._where?.unit === 'lovelace' ? lovelace : assets;
    return undefined;
  });
}

function fakeClient(script: Array<[ReturnType<typeof block>, Transaction[]]>) {
  const backend = {
    openChainSync: vi.fn(async (_from: unknown, cb: ChainSyncCallbacks): Promise<ChainSyncHandle> => {
      void (async () => {
        await cb.rollBackward({ slot: 0, hash: 'x' });
        for (const [b, txs] of script) await cb.rollForward(b, txs);
      })();
      return { close: vi.fn(async () => undefined) };
    }),
  };
  return { getChainSyncBackend: () => backend } as any;
}

const row = (inputIndex: number, over: Row = {}): Row => ({
  txSeq: String(SEQ), inputIndex, address_address: null, spentTxHash: null, spentOutputIndex: null,
  utxoData_dataHash: null, utxoData_inlineDatum: null, utxoData_referenceScriptHash: null,
  isCollateral: false, isReference: false, ...over,
});
const updates = () => dbRun.mock.calls.map(c => c[0]).filter(q => q._op === 'UPDATE');
const upserts = (entity: string) => dbRun.mock.calls.map(c => c[0]).filter(q => q._op === 'UPSERT' && q.entity === entity);
const run = (txs: Transaction[]) => backfillTransactions({ client: fakeClient([[block(SLOT, 'b1'), txs]]), indexer: resolver, fromSlot: SLOT, toSlot: SLOT });

beforeEach(() => { dbRun.mockReset(); resolver.resolveInputs.mockClear(); });

describe('backfillTransactions', () => {
  it('fills outpoint and datum of old rows and writes the redeemers', async () => {
    fakeIndex(
      [row(0, { address_address: 'addrA' }), row(1, { address_address: 'addrB', isCollateral: true })],
      [{ input_txSeq: String(SEQ), input_inputIndex: 0, asset_quantity: '5000000' }],
    );
    const redeemers = [{ purpose: 'spend', index: 0, data: 'd87980', mem: '1', steps: '2', txHash: A, outputIndex: 0, policyId: null }];
    const r = await run([chainTx([bare(A, 0), bare(B, 1, { isCollateral: true })], { redeemers })]);

    expect(updates().map(u => [u._where, u._set])).toEqual([
      [{ txSeq: SEQ, inputIndex: 0 }, { spentTxHash: A, spentOutputIndex: 0, utxoData_inlineDatum: 'd87980' }],
      [{ txSeq: SEQ, inputIndex: 1 }, { spentTxHash: B, spentOutputIndex: 1 }],
    ]);
    expect(upserts('TransactionRedeemers')[0].entries).toEqual([
      { tx_hash: T, purpose: 'spend', redeemerIndex: 0, data: 'd87980', mem: 1, steps: 2, spentTxHash: A, spentOutputIndex: 0, policyId: null },
    ]);
    expect(r).toMatchObject({ blocks: 1, transactions: 1, inputs: 2, redeemers: 1, skipped: 0, atSlot: SLOT });
  });

  it('leaves a transaction alone whose stored inputs are in another order', async () => {
    // rows written from a provider in a different input order: position 0 holds B's address
    fakeIndex([row(0, { address_address: 'addrB' }), row(1, { address_address: 'addrA' })]);
    const r = await run([chainTx([bare(A, 0), bare(B, 1)])]);
    expect(updates()).toEqual([]);
    expect(r).toMatchObject({ inputs: 0, skipped: 1 });
  });

  it('moves rows stored in another order (Koios crawl) to the ledger order, with their assets', async () => {
    fakeIndex(
      [row(0, { address_address: 'addrB', spentTxHash: B, spentOutputIndex: 1 }), row(1, { address_address: 'addrA', spentTxHash: A, spentOutputIndex: 0 })],
      [],
      [
        { input_txSeq: String(SEQ), input_inputIndex: 0, unit: 'lovelace', asset_quantity: '2000000' },
        { input_txSeq: String(SEQ), input_inputIndex: 1, unit: 'lovelace', asset_quantity: '5000000' },
      ],
    );
    const r = await run([chainTx([bare(A, 0), bare(B, 1)])]);

    const ops = dbRun.mock.calls.map(c => c[0]);
    expect(ops.filter(q => q._op === 'DELETE').map(q => q.entity)).toEqual(['TransactionInputAssets', 'TransactionInputs']);
    const rows = upserts('TransactionInputs')[0].entries as Row[];
    expect(rows.map(x => [x.inputIndex, x.spentTxHash, x.address_address])).toEqual([[0, A, 'addrA'], [1, B, 'addrB']]);
    // the empty inline datum is filled on the way
    expect(rows[0].utxoData_inlineDatum).toBe('d87980');
    const assets = upserts('TransactionInputAssets')[0].entries as Row[];
    expect(assets.map(a => [a.input_inputIndex, a.asset_quantity])).toEqual([[1, '2000000'], [0, '5000000']]);
    expect(r).toMatchObject({ rewritten: 1, skipped: 0 });
  });

  it('drops the regular inputs a provider stored for a phase-2 failure, with their assets', async () => {
    // Koios/Blockfrost stored the declared input (no outpoint yet) next to the collateral
    fakeIndex(
      [row(0, { address_address: 'addrA' }), row(1, { address_address: 'addrB', isCollateral: true })],
      [],
      [
        { input_txSeq: String(SEQ), input_inputIndex: 0, unit: 'lovelace', asset_quantity: '5000000' },
        { input_txSeq: String(SEQ), input_inputIndex: 1, unit: 'lovelace', asset_quantity: '2000000' },
      ],
    );
    const r = await run([chainTx([bare(B, 1, { isCollateral: true })], { spendsCollaterals: true })]);

    const rows = upserts('TransactionInputs')[0].entries as Row[];
    expect(rows.map(x => [x.inputIndex, x.address_address, x.isCollateral, x.spentTxHash])).toEqual([[0, 'addrB', true, B]]);
    expect((upserts('TransactionInputAssets')[0].entries as Row[]).map(a => [a.input_inputIndex, a.asset_quantity])).toEqual([[0, '2000000']]);
    expect(r).toMatchObject({ rewritten: 1, skipped: 0 });
  });

  it('deletes stored outputs the ledger never produced, never when an output of the stream is missing', async () => {
    const out = (i: number) => ({ address: 'addrO', amount: [], txHash: T, outputIndex: i, dataHash: null, inlineDatum: null, isCollateral: false });
    // a valid transaction: the provider also stored its collateral return (#1)
    fakeIndex([], [], [], [{ txSeq: String(SEQ), outputIndex: 0 }, { txSeq: String(SEQ), outputIndex: 1 }]);
    expect(await run([chainTx([], { outputs: [out(0)] })])).toMatchObject({ rewritten: 1 });
    const deletes = dbRun.mock.calls.map(c => c[0]).filter(q => q._op === 'DELETE');
    expect(deletes.map(q => [q.entity, q._where])).toEqual([
      ['TransactionOutputAssets', { output_txSeq: SEQ, output_outputIndex: { in: [1] } }],
      ['TransactionOutputs', { txSeq: SEQ, outputIndex: { in: [1] } }],
    ]);

    dbRun.mockReset();
    fakeIndex([], [], [], [{ txSeq: String(SEQ), outputIndex: 1 }]);
    expect(await run([chainTx([], { outputs: [out(0)] })])).toMatchObject({ rewritten: 0 });
    expect(dbRun.mock.calls.map(c => c[0]).filter(q => q._op === 'DELETE')).toEqual([]);
  });

  it('checks the lovelace where the address alone cannot tell two inputs apart', async () => {
    known[`${A}#1`] = { address: 'addrA', lovelace: '1000000' };
    fakeIndex(
      [row(0, { address_address: 'addrA' }), row(1, { address_address: 'addrA' })],
      [{ input_txSeq: String(SEQ), input_inputIndex: 0, asset_quantity: '1000000' }, { input_txSeq: String(SEQ), input_inputIndex: 1, asset_quantity: '5000000' }],
    );
    const r = await run([chainTx([bare(A, 0), bare(A, 1)])]);
    delete known[`${A}#1`];
    expect(updates()).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('does not touch complete rows, and skips a stored address the stream cannot confirm', async () => {
    fakeIndex([row(0, { address_address: 'addrA', spentTxHash: A, spentOutputIndex: 0, utxoData_inlineDatum: 'd87980' })]);
    expect(await run([chainTx([bare(A, 0)])])).toMatchObject({ inputs: 0, skipped: 0 });
    expect(updates()).toEqual([]);

    dbRun.mockReset();
    fakeIndex([row(0, { address_address: 'addrX' })]);
    expect(await run([chainTx([bare('9'.repeat(64), 0)])])).toMatchObject({ inputs: 0, skipped: 1 });
  });

  it('fills a missing address with its assets', async () => {
    fakeIndex([row(0)]);
    const r = await run([chainTx([bare(B, 1)])]);
    expect(updates()[0]._set).toEqual({ spentTxHash: B, spentOutputIndex: 1, address_address: 'addrB', hasAddresses: true, hasAssets: true });
    expect(upserts('TransactionInputAssets')[0].entries).toMatchObject([{ input_txSeq: SEQ, input_inputIndex: 0, unit: 'lovelace', asset_quantity: '2000000' }]);
    expect(r.inputs).toBe(1);
  });

  it('skips a transaction whose stored input count differs', async () => {
    fakeIndex([row(0, { address_address: 'addrA' })]);
    expect(await run([chainTx([bare(A, 0), bare(B, 1)])])).toMatchObject({ skipped: 1, inputs: 0 });
  });

  it('writes the fills of a batch as one statement with a JSON parameter on Postgres', async () => {
    (cds as unknown as { db?: unknown }).db = { kind: 'postgres' };
    try {
      fakeIndex([row(0, { address_address: 'addrA' }), row(1, { address_address: 'addrB', isCollateral: true })]);
      const r = await run([chainTx([bare(A, 0), bare(B, 1, { isCollateral: true })])]);
      const raw = dbRun.mock.calls.map(c => c as unknown[]).filter(c => typeof c[0] === 'string');
      expect(raw).toHaveLength(1);
      expect(raw[0][0]).toBe(inputFillStatement('postgres'));
      expect(JSON.parse((raw[0][1] as string[])[0])).toMatchObject([
        { txseq: SEQ, inputindex: 0, spenttxhash: A, spentoutputindex: 0, utxodata_inlinedatum: 'd87980', address_address: null },
        { txseq: SEQ, inputindex: 1, spenttxhash: B, spentoutputindex: 1 },
      ]);
      expect(updates()).toEqual([]);
      expect(r.inputs).toBe(2);
    } finally {
      delete (cds as unknown as { db?: unknown }).db;
    }
  });

  it('keeps existing values in the bulk statement (COALESCE) and has none for other databases', () => {
    expect(inputFillStatement('postgres')).toContain('spentTxHash = COALESCE(t.spentTxHash, v.spentTxHash)');
    expect(inputFillStatement('sqlite')).toContain('FROM json_each(?)');
    expect(inputFillStatement('hana')).toBeNull();
  });
});
