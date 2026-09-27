/**
 * Stored blocks and transactions back in the provider shape: block rows, contiguous next blocks,
 * transactions with inputs/outputs/assets/metadata/certificates/withdrawals/mint.
 */

type Q = { _op: string; entity: string; where?: Record<string, unknown>; orderBy?: string; columns?: string };
let tables: Record<string, Array<Record<string, unknown>>> = {};

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).map(String).includes(String(row[k]));
    if (v && typeof v === 'object') {
      const c = v as Record<string, number>;
      const n = Number(row[k]);
      return (c['>'] == null || n > c['>']) && (c['<='] == null || n <= c['<=']);
    }
    return String(row[k]) === String(v);
  });
}

const db = {
  run: vi.fn(async ({ q }: { q: Q }) => {
    const rows = (tables[q.entity] ?? []).filter(r => matches(r, q.where));
    if (q.orderBy) {
      const [col, dir] = q.orderBy.split(' ');
      rows.sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === 'desc' ? -1 : 1));
    }
    return q._op === 'one' ? rows[0] : rows;
  }),
};

vi.mock('@sap/cds', () => {
  const build = (op: string) => (entity: string) => {
    // query state lives in `q`; the builder methods only record into it
    const q: Q = { _op: op, entity };
    const chain = {
      q,
      columns: () => chain,
      where: (where: Record<string, unknown>) => { q.where = where; return chain; },
      orderBy: (orderBy: string) => { q.orderBy = orderBy; return chain; },
    };
    return chain;
  };
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }), ql: { SELECT: { one: { from: build('one') }, from: build('many') } } };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  Blocks: 'Blocks', Transactions: 'Transactions', TransactionInputs: 'TransactionInputs',
  TransactionInputAssets: 'TransactionInputAssets', TransactionOutputs: 'TransactionOutputs',
  TransactionOutputAssets: 'TransactionOutputAssets', TransactionMetadata_: 'TransactionMetadata',
  TransactionCertificates: 'TransactionCertificates', TransactionWithdrawals: 'TransactionWithdrawals',
  AssetHistory_: 'AssetHistory',
}));

import { blockRowToData, readNextBlocks, readTransactionsByHash, readBlockTransactions, readTransactionMetadata } from '../../srv/blockchain/stored-chain';

const T1 = '1'.repeat(64);
const B1 = 'b'.repeat(64);
const UNIT = `${'p'.repeat(56)}746f6b`;

beforeEach(() => {
  tables = {
    Blocks: [10, 11, 13].map(h => ({ hash: `h${h}`, height: h, time: '2026-09-27T00:00:00.000Z', slot: h * 20, slotLeader: 'pool1x', epochNumber: 5, epochSlot: 1, size: 100, txCount: 1, fees: '170000' })),
    Transactions: [{ hash: T1, txSeq: '700', blockHash: B1, blockHeight: 12, slot: '240', txIndex: 0, fee: '170000', deposit: '0', size: 300, blockTime: '1790000000' }],
    TransactionInputs: [
      { txSeq: '700', inputIndex: 1, address_address: 'addr_in2', spentTxHash: '9'.repeat(64), spentOutputIndex: 3, isCollateral: true, isReference: false },
      { txSeq: '700', inputIndex: 0, address_address: 'addr_in1', spentTxHash: '8'.repeat(64), spentOutputIndex: 0, isCollateral: false, isReference: false, utxoData_inlineDatum: 'd87980' },
    ],
    TransactionInputAssets: [
      { input_txSeq: '700', input_inputIndex: 0, unit: UNIT, asset_quantity: '5' },
      { input_txSeq: '700', input_inputIndex: 0, unit: 'lovelace', asset_quantity: '2000000' },
    ],
    TransactionOutputs: [{ txSeq: '700', outputIndex: 0, address_address: 'addr_out', utxo_referenceScriptHash: 'ab'.repeat(28) }],
    TransactionOutputAssets: [{ output_txSeq: '700', output_outputIndex: 0, unit: 'lovelace', asset_quantity: '1830000' }],
    TransactionMetadata: [{ tx_hash: T1, label: '674', payload: '{"msg":["hi"],"n":18446744073709551615}' }],
    TransactionCertificates: [{ tx_hash: T1, certIndex: 0, kind: 'pool_delegation', stakeAddress: 'stake_test1x', poolId: 'pool1x' }],
    TransactionWithdrawals: [{ tx_hash: T1, stakeAddress: 'stake_test1x', lovelace: '42' }],
    AssetHistory: [{ unit: UNIT, txHash: T1, action: 'burn', quantity: '5' }],
  };
});

describe('stored chain in the provider shape', () => {
  it('maps a block row back to BlockData (ISO time -> unix seconds)', () => {
    expect(blockRowToData(tables.Blocks[0])).toEqual({
      time: Date.parse('2026-09-27T00:00:00.000Z') / 1000, height: 10, hash: 'h10', slot: 200, slotLeader: 'pool1x',
      epoch: 5, epochSlot: 1, size: 100, txCount: 1, fees: '170000',
    });
  });

  it('returns next blocks only as long as the heights are contiguous', async () => {
    const next = await readNextBlocks(db as never, 9, 5);
    expect(next.map(b => b.height)).toEqual([10, 11]); // 12 is missing, 13 is not reached
  });

  it('assembles a transaction with its children in order, lovelace first, burn as negative mint', async () => {
    const tx = (await readTransactionsByHash(db as never, [T1])).get(T1)!;
    expect(tx).toMatchObject({ hash: T1, blockHash: B1, blockHeight: 12, slot: 240, index: 0, fee: '170000', blockTime: 1790000000, size: 300 });
    expect(tx.inputs.map(i => i.outputIndex)).toEqual([0, 3]);
    expect(tx.inputs[0]).toMatchObject({ address: 'addr_in1', inlineDatum: 'd87980', amount: [{ unit: 'lovelace', quantity: '2000000' }, { unit: UNIT, quantity: '5' }] });
    expect(tx.inputs[1]).toMatchObject({ isCollateral: true, amount: [] });
    expect(tx.outputs).toEqual([{ address: 'addr_out', amount: [{ unit: 'lovelace', quantity: '1830000' }], txHash: T1, outputIndex: 0, dataHash: null, inlineDatum: null, isCollateral: false, referenceScriptHash: 'ab'.repeat(28) }]);
    expect(tx.mint).toEqual([{ unit: UNIT, quantity: '-5' }]);
    expect(tx.certificates).toEqual([{ certIndex: 0, kind: 'pool_delegation', stakeAddress: 'stake_test1x', poolId: 'pool1x', drepId: null, deposit: null, epoch: null }]);
    expect(tx.withdrawals).toEqual([{ stakeAddress: 'stake_test1x', amount: '42' }]);
    // metadata numbers above 2^53 survive (safeJSON)
    expect(String((tx.metadata![0].json as { n: unknown }).n)).toBe('18446744073709551615');
  });

  it('leaves unknown hashes out of the batch', async () => {
    const found = await readTransactionsByHash(db as never, [T1, '2'.repeat(64)]);
    expect([...found.keys()]).toEqual([T1]);
  });

  it('answers block transactions only when the block is stored with all of them', async () => {
    tables.Blocks.push({ hash: B1, height: 12, time: '2026-09-27T00:00:00.000Z', txCount: 1 });
    expect((await readBlockTransactions(db as never, B1))?.map(t => t.hash)).toEqual([T1]);
    tables.Blocks[tables.Blocks.length - 1].txCount = 2;
    expect(await readBlockTransactions(db as never, B1)).toBeNull();
    expect(await readBlockTransactions(db as never, 'c'.repeat(64))).toBeNull();
  });

  it('reads metadata of a stored transaction, null for an unknown one', async () => {
    expect((await readTransactionMetadata(db as never, T1))?.map(m => m.label)).toEqual(['674']);
    expect(await readTransactionMetadata(db as never, '2'.repeat(64))).toBeNull();
  });
});
