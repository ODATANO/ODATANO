/**
 * CardanoIndexer.indexBlockFull + resolveInputs (crawler C3): bulk one-UPSERT-per-table
 * writes, the per-epoch memo (incl. negative caching), and the Ogmios bare-ref input
 * backfill (same-block, prior-block via DB, and skip of already-resolved inputs).
 * Mock style mirrors cardano-indexer.test.ts (string entity proxies, real mappers).
 */

type Q = { _op: string; entity: string; where?: unknown; entries?: unknown };
const runs: Q[] = [];
const mockTx = {
  run: jest.fn(async (q: Q) => {
    runs.push(q);
    if (q._op === 'SELECT.many' && q.entity === 'TransactionOutputs') {
      // prior-block output for input resolution: prevTx#0 belongs to addrPrev
      return [{ tx_hash: 'prev'.padEnd(64, '0'), outputIndex: 0, address_address: 'addrPrev' }];
    }
    if (q._op === 'SELECT.many' && q.entity === 'TransactionOutputAssets') {
      return [{ output_tx_hash: 'prev'.padEnd(64, '0'), output_outputIndex: 0, unit: 'lovelace', asset_quantity: '7000000' }];
    }
    return undefined;
  }),
};

jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  ql: {
    UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
    INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
    UPDATE: { entity: (entity: string) => ({ set: () => ({ where: () => ({ _op: 'UPDATE', entity }) }) }) },
    DELETE: { from: (entity: string) => ({ where: () => ({ _op: 'DELETE', entity }) }) },
    SELECT: {
      one: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }) }) },
      from: (entity: string) => ({
        where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
        columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }) }),
      }),
    },
  },
}));

jest.mock('#cds-models/CardanoODataService', () => ({
  Addresses: 'Addresses', Transaction: 'Transaction', AddressAssets: 'AddressAssets',
  AddressUTxOs: 'AddressUTxOs', Transactions: 'Transactions',
  TransactionInputs: 'TransactionInputs', TransactionInputAssets: 'TransactionInputAssets',
  TransactionOutputs: 'TransactionOutputs', TransactionOutputAssets: 'TransactionOutputAssets',
  TransactionMetadata: 'TransactionMetadata', NetworkInformation: 'NetworkInformation',
  UTxOAssets: 'UTxOAssets', Block: 'Block', Epoch: 'Epoch', Accounts: 'Accounts',
  Pools: 'Pools', Dreps: 'Dreps', Assets: 'Assets', AssetHistory: 'AssetHistory',
  Account: 'Account', Drep: 'Drep', Pool: 'Pool', Asset: 'Asset', Address: 'Address',
  LedgerProtocolParameter: 'LedgerProtocolParameter', AddressTransactions: 'AddressTransactions',
}), { virtual: true });

jest.mock('#cds-models/CardanoTransactionService', () => ({
  TransactionBuild: 'TransactionBuild', TransactionBuilds: 'TransactionBuilds',
  TransactionBuildInputs: 'TransactionBuildInputs', TransactionBuildOutputs: 'TransactionBuildOutputs',
  TransactionSubmission: 'TransactionSubmission', TransactionSubmissions: 'TransactionSubmissions',
  AddressTransactionBuilds: 'AddressTransactionBuilds',
}), { virtual: true });

jest.mock('#cds-models/CardanoSignService', () => ({
  SigningRequests: 'SigningRequests', SignatureVerifications: 'SignatureVerifications',
  AddressSigningRequests: 'AddressSigningRequests',
}), { virtual: true });

import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import type { BlockData, Transaction } from '../../srv/utils/types';

const blockData = (over: Partial<BlockData> = {}): BlockData => ({
  time: 1700000000, height: 50, hash: 'blk'.padEnd(64, '9'), slot: 5000, slotLeader: 'sl',
  epoch: 7, epochSlot: 100, size: 400, txCount: 2, fees: '340000', ...over,
});

const tx = (hash: string, over: Partial<Transaction> = {}): Transaction => ({
  hash, blockHash: 'blk'.padEnd(64, '9'), blockHeight: 50, slot: 5000, index: 0,
  fee: '170000', deposit: '0', size: 0, blockTime: 1700000000,
  inputs: [], outputs: [], ...over,
});

const upsertsFor = (entity: string) => runs.filter(q => q._op === 'UPSERT' && q.entity === entity);

function makeIndexer(getEpoch: jest.Mock = jest.fn().mockRejectedValue(new Error('no epoch backend'))) {
  const client = { getEpoch, max_age_ms: 60000, network: 'preview' };
  return { indexer: new CardanoIndexer(client as never, {} as never), getEpoch };
}

beforeEach(() => {
  runs.length = 0;
  mockTx.run.mockClear();
});

describe('CardanoIndexer.indexBlockFull — bulk persistence', () => {
  it('accumulates rows across the block and issues ONE UPSERT per table', async () => {
    const { indexer } = makeIndexer();
    const txs = [
      tx('t1'.padEnd(64, '0'), {
        outputs: [{ address: 'addrA', amount: [{ unit: 'lovelace', quantity: '1000000' }], txHash: 't1'.padEnd(64, '0'), outputIndex: 0, dataHash: null, inlineDatum: null, isCollateral: false }],
        metadata: [{ txHash: 't1'.padEnd(64, '0'), label: '721', json: '{}' }],
      }),
      tx('t2'.padEnd(64, '0'), {
        inputs: [{ address: 'addrA', amount: [], txHash: 't1'.padEnd(64, '0'), outputIndex: 0 }],
        outputs: [{ address: 'addrB', amount: [{ unit: 'lovelace', quantity: '900000' }], txHash: 't2'.padEnd(64, '0'), outputIndex: 0, dataHash: null, inlineDatum: null, isCollateral: false }],
      }),
    ];

    await indexer.indexBlockFull(mockTx as never, blockData(), txs);

    // one bulk UPSERT per table
    expect(upsertsFor('Transactions')).toHaveLength(1);
    expect((upsertsFor('Transactions')[0].entries as unknown[]).length).toBe(2);
    expect(upsertsFor('TransactionInputs')).toHaveLength(1);
    expect(upsertsFor('TransactionOutputs')).toHaveLength(1);
    expect((upsertsFor('TransactionOutputs')[0].entries as unknown[]).length).toBe(2);
    expect(upsertsFor('TransactionOutputAssets')).toHaveLength(1);
    expect(upsertsFor('TransactionMetadata')).toHaveLength(1);
    expect(upsertsFor('Block')).toHaveLength(1);
    // block row carries the absolute slot (the crawler's reorg cut axis)
    expect(upsertsFor('Block')[0].entries).toMatchObject({ hash: 'blk'.padEnd(64, '9'), slot: 5000, height: 50 });
  });

  it('skips empty tables (no UPSERT with zero rows)', async () => {
    const { indexer } = makeIndexer();
    await indexer.indexBlockFull(mockTx as never, blockData({ txCount: 0 }), []);
    expect(upsertsFor('Transactions')).toHaveLength(0);
    expect(upsertsFor('TransactionInputs')).toHaveLength(0);
    expect(upsertsFor('Block')).toHaveLength(1); // block row is always written
  });
});

describe('CardanoIndexer.indexBlockFull — epoch memo', () => {
  it('fetches an epoch once and reuses it for subsequent blocks of the same epoch', async () => {
    const getEpoch = jest.fn().mockResolvedValue({
      epoch: 7, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: 2,
      block_count: 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    });
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk2'.padEnd(64, '9') }), []);

    expect(getEpoch).toHaveBeenCalledTimes(1); // memoized — NOT one HTTP call per block
  });

  it('re-fetches when the epoch changes', async () => {
    const getEpoch = jest.fn().mockResolvedValue({
      epoch: 7, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: 2,
      block_count: 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    });
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 8 }), []);

    expect(getEpoch).toHaveBeenCalledTimes(2);
  });

  it('negative-caches a failing epoch fetch (no retry per block, block still persisted)', async () => {
    const getEpoch = jest.fn().mockRejectedValue(new Error('ogmios: only current epoch'));
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk2'.padEnd(64, '9') }), []);

    expect(getEpoch).toHaveBeenCalledTimes(1); // miss cached too
    expect(upsertsFor('Block')).toHaveLength(2); // enrichment failure never blocks persist
  });
});

describe('CardanoIndexer.resolveInputs (via indexBlockFull)', () => {
  it('backfills a bare-ref input from an output of the SAME block without touching the DB', async () => {
    const { indexer } = makeIndexer();
    const producer = tx('t1'.padEnd(64, '0'), {
      outputs: [{ address: 'addrSame', amount: [{ unit: 'lovelace', quantity: '5000000' }], txHash: 't1'.padEnd(64, '0'), outputIndex: 0, dataHash: null, inlineDatum: null, isCollateral: false }],
    });
    const spender = tx('t2'.padEnd(64, '0'), {
      inputs: [{ address: '', amount: [], txHash: 't1'.padEnd(64, '0'), outputIndex: 0 }], // ogmios bare ref
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [producer, spender]);

    const inputRows = upsertsFor('TransactionInputs')[0].entries as Array<Record<string, unknown>>;
    const resolved = inputRows.find(r => r.tx_hash === 't2'.padEnd(64, '0'));
    expect(resolved!.address_address).toBe('addrSame');
    expect(resolved!.hasAddresses).toBe(true);
    // same-block resolution → no DB read for outputs
    expect(runs.filter(q => q._op === 'SELECT.many' && q.entity === 'TransactionOutputs')).toHaveLength(0);
  });

  it('backfills a bare-ref input from previously indexed outputs via a batched DB read', async () => {
    const { indexer } = makeIndexer();
    const spender = tx('t3'.padEnd(64, '0'), {
      inputs: [{ address: '', amount: [], txHash: 'prev'.padEnd(64, '0'), outputIndex: 0 }],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [spender]);

    const outputsRead = runs.filter(q => q._op === 'SELECT.many' && q.entity === 'TransactionOutputs');
    expect(outputsRead).toHaveLength(1);
    expect(outputsRead[0].where).toEqual({ tx_hash: { in: ['prev'.padEnd(64, '0')] } });

    const inputRows = upsertsFor('TransactionInputs')[0].entries as Array<Record<string, unknown>>;
    expect(inputRows[0].address_address).toBe('addrPrev');
    const assetRows = upsertsFor('TransactionInputAssets')[0].entries as Array<Record<string, unknown>>;
    expect(assetRows[0]).toMatchObject({ unit: 'lovelace', asset_quantity: '7000000' });
  });

  it('leaves an unresolvable pre-start-point input with a NULL address FK (not empty string)', async () => {
    const { indexer } = makeIndexer();
    const spender = tx('t4'.padEnd(64, '0'), {
      inputs: [{ address: '', amount: [], txHash: 'unknown'.padEnd(64, '0'), outputIndex: 5 }],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [spender]);

    const inputRows = upsertsFor('TransactionInputs')[0].entries as Array<Record<string, unknown>>;
    expect(inputRows[0].address_address).toBeNull(); // '' would be a dangling Addresses FK
    expect(inputRows[0].hasAddresses).toBe(false);
  });

  it('skips inputs that already carry an address (Blockfrost/Koios path — zero overhead)', async () => {
    const { indexer } = makeIndexer();
    const resolved = tx('t5'.padEnd(64, '0'), {
      inputs: [{ address: 'addrKnown', amount: [{ unit: 'lovelace', quantity: '1' }], txHash: 'x'.padEnd(64, '0'), outputIndex: 0 }],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [resolved]);

    expect(runs.filter(q => q._op === 'SELECT.many')).toHaveLength(0); // no resolution reads at all
    const inputRows = upsertsFor('TransactionInputs')[0].entries as Array<Record<string, unknown>>;
    expect(inputRows[0].address_address).toBe('addrKnown');
  });
});
