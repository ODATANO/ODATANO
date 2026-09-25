/**
 * CardanoIndexer.indexBlockFull + resolveInputs (crawler C3): bulk one-UPSERT-per-table
 * writes, the per-epoch memo (incl. negative caching), and the Ogmios bare-ref input
 * backfill (same-block, prior-block via DB, and skip of already-resolved inputs).
 * Mock style mirrors cardano-indexer.test.ts (string entity proxies, real mappers).
 */

type Q = { _op: string; entity: string; where?: unknown; entries?: unknown };
const runs: Q[] = [];
/** Units the `Assets` table already holds, as the catalogue's existence check sees them. */
let knownAssets: string[] = [];
/** The crawler cursor the ledger anchor verification reads (readCursor is mocked below). */
let cursorRow: { lastSlot: number; lastBlockHash: string | null; utxoSet: { appliedSlot: number | null } } | null =
  { lastSlot: 5000, lastBlockHash: 'h', utxoSet: { appliedSlot: null } };
const mockTx = {
  run: vi.fn(async (q: Q) => {
    runs.push(q);
    if (q._op === 'SELECT.many' && q.entity === 'TransactionOutputs') {
      // prior-block output for input resolution: prevTx#0 belongs to addrPrev
      return [{ tx_hash: 'prev'.padEnd(64, '0'), outputIndex: 0, address_address: 'addrPrev' }];
    }
    if (q._op === 'SELECT.many' && q.entity === 'TransactionOutputAssets') {
      return [{ output_tx_hash: 'prev'.padEnd(64, '0'), output_outputIndex: 0, unit: 'lovelace', asset_quantity: '7000000' }];
    }
    // asset catalogue: nothing known yet unless a test says otherwise (see knownAssets)
    if (q._op === 'SELECT.many' && q.entity === 'AssetsTable') {
      return knownAssets.map(unit => ({ unit }));
    }
    return undefined;
  }),
};

vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
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
};
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/CardanoODataService', () => ({
  Addresses: 'Addresses', Transaction: 'Transaction', AddressAssets: 'AddressAssets',
  AddressUTxOs: 'AddressUTxOs', Transactions: 'Transactions',
  TransactionInputs: 'TransactionInputs', TransactionInputAssets: 'TransactionInputAssets',
  TransactionOutputs: 'TransactionOutputs', TransactionOutputAssets: 'TransactionOutputAssets',
  TransactionMetadata: 'TransactionMetadata', NetworkInformation: 'NetworkInformation',
  UTxOAssets: 'UTxOAssets', Block: 'Block', Epoch: 'Epoch', Accounts: 'Accounts',
  Pools: 'Pools', Dreps: 'Dreps', Assets: 'Assets', AssetHistory: 'AssetHistory',
  PoolEpochSnapshots: 'PoolEpochSnapshots', DrepEpochSnapshots: 'DrepEpochSnapshots',
  Account: 'Account', Drep: 'Drep', Pool: 'Pool', Asset: 'Asset', Address: 'Address',
  LedgerProtocolParameter: 'LedgerProtocolParameter', AddressTransactions: 'AddressTransactions',
  TransactionCertificates: 'TransactionCertificates', TransactionWithdrawals: 'TransactionWithdrawals',
}));

// ledger-state reads the DB-level entities; the indexer only forwards to it
vi.mock('../../srv/blockchain/ledger-state', () => ({
  applyBlockToLedger: vi.fn(async () => ({ created: 1, spent: 0, missing: 0, addresses: 1 })),
}));
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  setUtxoSetState: vi.fn(async () => undefined),
  readCursor: vi.fn(async () => cursorRow),
}));

// DB-level entity: the asset catalogue's existence check reads past the temporal filter
vi.mock('#cds-models/odatano/cardano', () => ({
  Assets: 'AssetsTable',
}));

vi.mock('#cds-models/CardanoTransactionService', () => ({
  TransactionBuild: 'TransactionBuild', TransactionBuilds: 'TransactionBuilds',
  TransactionBuildInputs: 'TransactionBuildInputs', TransactionBuildOutputs: 'TransactionBuildOutputs',
  TransactionSubmission: 'TransactionSubmission', TransactionSubmissions: 'TransactionSubmissions',
  AddressTransactionBuilds: 'AddressTransactionBuilds',
}));

vi.mock('#cds-models/CardanoSignService', () => ({
  SigningRequests: 'SigningRequests', SignatureVerifications: 'SignatureVerifications',
  AddressSigningRequests: 'AddressSigningRequests',
}));

import type { Mock } from 'vitest';
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import { applyBlockToLedger } from '../../srv/blockchain/ledger-state';
import { setUtxoSetState, readCursor } from '../../srv/blockchain/crawler/sync-state';
import { BARE_ASSET_STAMP } from '../../srv/utils/mappers';
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

function makeIndexer(getEpoch: Mock = vi.fn().mockRejectedValue(new Error('no epoch backend'))) {
  const client = { getEpoch, max_age_ms: 60000, network: 'preview' };
  return { indexer: new CardanoIndexer(client as never, {} as never), getEpoch };
}

beforeEach(() => {
  runs.length = 0;
  knownAssets = [];
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the network snapshot but UPSERTs it in every block transaction', async () => {
    const getEpoch = vi.fn().mockResolvedValue({
      epoch: 7, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: 2,
      block_count: 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    });
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk2'.padEnd(64, '9') }), []);

    expect(getEpoch).toHaveBeenCalledTimes(1); // memoized — NOT one HTTP call per block
    expect(upsertsFor('Epoch')).toHaveLength(2); // rollback-safe: no uncommitted JS flag
  });

  it('final-refreshes the previous epoch when the epoch changes', async () => {
    const getEpoch = vi.fn(async (epoch: number) => ({
      epoch, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: epoch === 7 ? 99 : 2,
      block_count: epoch === 7 ? 99 : 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    }));
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 8 }), []);

    expect(getEpoch.mock.calls.map(([epoch]) => epoch)).toEqual([7, 7, 8]);
    const persisted = upsertsFor('Epoch').at(-1)!.entries as Array<Record<string, unknown>>;
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ epoch: 7, blockCount: 99, lastBlockTime: 99 }),
      expect.objectContaining({ epoch: 8 }),
    ]));
  });

  it('backs off a failing epoch fetch briefly, then retries it', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const getEpoch = vi.fn().mockRejectedValue(new Error('ogmios: only current epoch'));
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk2'.padEnd(64, '9') }), []);

    expect(getEpoch).toHaveBeenCalledTimes(1); // immediate retry is suppressed
    now += 30_001;
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk3'.padEnd(64, '9') }), []);
    expect(getEpoch).toHaveBeenCalledTimes(2);
    expect(upsertsFor('Block')).toHaveLength(3); // enrichment failure never blocks persist
  });

  it('refreshes a live epoch after the refresh interval', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const getEpoch = vi.fn().mockResolvedValue({
      epoch: 7, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: 2,
      block_count: 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    });
    const { indexer } = makeIndexer(getEpoch);

    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);
    now += 5 * 60 * 1000 + 1;
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7, hash: 'blk2'.padEnd(64, '9') }), []);

    expect(getEpoch).toHaveBeenCalledTimes(2);
  });

  it('retries the Epoch UPSERT after a later write rolls the transaction back', async () => {
    const getEpoch = vi.fn().mockResolvedValue({
      epoch: 7, start_time: 1, end_time: 2, first_block_time: 1, last_block_time: 2,
      block_count: 1, tx_count: 1, output: '0', fees: '0', active_stake: '0',
    });
    const { indexer } = makeIndexer(getEpoch);
    const failedWrites: Q[] = [];
    const failingTx = {
      run: vi.fn(async (q: Q) => {
        failedWrites.push(q);
        if (q._op === 'UPSERT' && q.entity === 'Block') throw new Error('rollback');
        return undefined;
      }),
    };

    await expect(indexer.indexBlockFull(failingTx as never, blockData({ epoch: 7 }), []))
      .rejects.toThrow('rollback');
    await indexer.indexBlockFull(mockTx as never, blockData({ epoch: 7 }), []);

    expect(failedWrites.filter(q => q._op === 'UPSERT' && q.entity === 'Epoch')).toHaveLength(1);
    expect(upsertsFor('Epoch')).toHaveLength(1);
    expect(upsertsFor('Block')).toHaveLength(1);
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

describe('CardanoIndexer.applyCollateralFees (via indexBlockFull)', () => {
  /** Collateral input resolvable from the DB mock: prev#0 = addrPrev holding 7 ADA. */
  const collateralIn = { address: '', amount: [], txHash: 'prev'.padEnd(64, '0'), outputIndex: 0, isCollateral: true };
  const collateralReturn = (quantity: string, hash: string) => ({
    address: 'addrReturn', amount: [{ unit: 'lovelace', quantity }],
    txHash: hash, outputIndex: 1, dataHash: null, inlineDatum: null, isCollateral: true,
  });
  const feeOf = (hash: string) =>
    (upsertsFor('Transactions')[0].entries as Array<Record<string, unknown>>).find(r => r.hash === hash)!.fee;
  const blockFees = () => (upsertsFor('Block')[0].entries as Record<string, unknown>).fees;

  it('charges collateral minus collateral return when the body declared no total_collateral', async () => {
    const { indexer } = makeIndexer();
    const hash = 'f1'.padEnd(64, '0');
    const failed = tx(hash, {
      spendsCollaterals: true, totalCollateral: null,
      inputs: [{ ...collateralIn }],
      outputs: [collateralReturn('2000000', hash)],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [failed]);

    expect(feeOf(hash)).toBe('5000000'); // 7 ADA collateral − 2 ADA returned, not the declared 170000
    expect(blockFees()).toBe('5000000'); // the block total follows the corrected fee
  });

  it('keeps the declared fee when a collateral input cannot be resolved', async () => {
    const { indexer } = makeIndexer();
    const hash = 'f2'.padEnd(64, '0');
    const failed = tx(hash, {
      spendsCollaterals: true, totalCollateral: null,
      // produced before the crawl start → no local output row, so the sum would be short
      inputs: [{ address: '', amount: [], txHash: 'unknown'.padEnd(64, '0'), outputIndex: 5, isCollateral: true }],
      outputs: [collateralReturn('2000000', hash)],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [failed]);

    expect(feeOf(hash)).toBe('170000');
    expect(blockFees()).toBe('340000'); // untouched — no correction happened
  });

  it('leaves a fee the mapper already settled from total_collateral alone', async () => {
    const { indexer } = makeIndexer();
    const hash = 'f3'.padEnd(64, '0');
    const failed = tx(hash, {
      fee: '3000000', spendsCollaterals: true, totalCollateral: '3000000',
      inputs: [{ ...collateralIn }],
      outputs: [collateralReturn('2000000', hash)],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [failed]);

    expect(feeOf(hash)).toBe('3000000'); // NOT re-derived as 5000000 from the resolved inputs
    expect(blockFees()).toBe('340000');
  });

  it('does not touch a successful transaction that merely declares collateral', async () => {
    const { indexer } = makeIndexer();
    const hash = 'f4'.padEnd(64, '0');
    const ok = tx(hash, {
      spendsCollaterals: false, totalCollateral: '3000000',
      inputs: [{ ...collateralIn }],
      outputs: [],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [ok]);

    expect(feeOf(hash)).toBe('170000');
    expect(blockFees()).toBe('340000');
  });

  it('leaves the Blockfrost/Koios path alone (no phase-2 information at all)', async () => {
    const { indexer } = makeIndexer();
    const hash = 'f5'.padEnd(64, '0');
    const lazy = tx(hash, { inputs: [{ address: 'addrKnown', amount: [{ unit: 'lovelace', quantity: '7000000' }], txHash: 'x'.padEnd(64, '0'), outputIndex: 0, isCollateral: true }] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [lazy]);

    expect(feeOf(hash)).toBe('170000');
    expect(blockFees()).toBe('340000');
  });
});

// ---------------------------------------------------------------------------
// Mint/burn history (analytics coverage)
// ---------------------------------------------------------------------------

const POLICY = 'a1'.repeat(28);
const UNIT_A = `${POLICY}${Buffer.from('TOKA').toString('hex')}`;
const UNIT_B = `${POLICY}${Buffer.from('TOKB').toString('hex')}`;

/** Output line carrying native assets. */
const out = (txHash: string, index: number, amount: Array<{ unit: string; quantity: string }>, isCollateral = false) => ({
  address: 'addrOut', amount, txHash, outputIndex: index, dataHash: null, inlineDatum: null, isCollateral,
});

const historyRows = () => (upsertsFor('AssetHistory')[0]?.entries ?? []) as Array<Record<string, unknown>>;

describe('CardanoIndexer.indexBlockFull — mint/burn history', () => {
  it("takes the ledger's own mint field when the backend reports one", async () => {
    const { indexer } = makeIndexer();
    const hash = 'm1'.padEnd(64, '0');
    const minted = tx(hash, {
      // the delta would say something else — the native field must win
      mint: [{ unit: UNIT_A, quantity: '1000' }, { unit: UNIT_B, quantity: '-25' }],
      outputs: [out(hash, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: UNIT_A, quantity: '999' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [minted]);

    expect(historyRows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: UNIT_A, txHash: hash, action: 'mint', quantity: '1000' }),
      expect.objectContaining({ unit: UNIT_B, txHash: hash, action: 'burn', quantity: '25' }),
    ]));
    // blockTime/blockHeight come from the block the crawler already holds
    expect(historyRows()[0]).toMatchObject({ blockTime: 1700000000, blockHeight: 50 });
  });

  it('derives the delta from outputs minus inputs when the backend has no mint field', async () => {
    const { indexer } = makeIndexer();
    const hash = 'm2'.padEnd(64, '0');
    const derived = tx(hash, {
      inputs: [{ address: 'addrIn', amount: [{ unit: UNIT_A, quantity: '400' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0 }],
      outputs: [out(hash, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: UNIT_A, quantity: '700' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [derived]);

    expect(historyRows()).toEqual([
      expect.objectContaining({ unit: UNIT_A, action: 'mint', quantity: '300' }),
    ]);
  });

  it('records a burn when the delta is negative, and nothing when assets only move', async () => {
    const { indexer } = makeIndexer();
    const burn = tx('m3'.padEnd(64, '0'), {
      inputs: [{ address: 'addrIn', amount: [{ unit: UNIT_A, quantity: '400' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0 }],
      outputs: [out('m3'.padEnd(64, '0'), 0, [{ unit: UNIT_A, quantity: '100' }])],
    });
    const move = tx('m4'.padEnd(64, '0'), {
      inputs: [{ address: 'addrIn', amount: [{ unit: UNIT_B, quantity: '5' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 1 }],
      outputs: [out('m4'.padEnd(64, '0'), 0, [{ unit: UNIT_B, quantity: '5' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [burn, move]);

    expect(historyRows()).toEqual([
      expect.objectContaining({ unit: UNIT_A, txHash: 'm3'.padEnd(64, '0'), action: 'burn', quantity: '300' }),
    ]);
  });

  // The two exclusions below only bite on the delta path, i.e. on Blockfrost — which since
  // rc.12 maps `collateral`/`reference` onto these TxInputLine names instead of dropping them.
  it('ignores collateral declared by a transaction whose script phase succeeded', async () => {
    const { indexer } = makeIndexer();
    const hash = 'm8'.padEnd(64, '0');
    const withCollateral = tx(hash, {
      inputs: [
        { address: 'addrIn', amount: [{ unit: UNIT_A, quantity: '100' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0 },
        { address: 'addrColl', amount: [{ unit: UNIT_A, quantity: '40' }], txHash: 'coll'.padEnd(64, '0'), outputIndex: 0, isCollateral: true },
      ],
      outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '100' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [withCollateral]);

    // the collateral was never consumed — counting it would report a phantom 40 burn
    expect(historyRows()).toHaveLength(0);
  });

  it('ignores reference inputs — they are read, never consumed', async () => {
    const { indexer } = makeIndexer();
    const hash = 'm5'.padEnd(64, '0');
    const withRef = tx(hash, {
      inputs: [
        { address: 'addrIn', amount: [{ unit: UNIT_A, quantity: '100' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0 },
        { address: 'addrRef', amount: [{ unit: UNIT_A, quantity: '900' }], txHash: 'ref'.padEnd(64, '0'), outputIndex: 0, isReference: true },
      ],
      outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '100' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [withRef]);

    // counting the reference input would have reported a 900 burn
    expect(historyRows()).toHaveLength(0);
  });

  it('records nothing for a phase-2 failure — the ledger applies no mint', async () => {
    const { indexer } = makeIndexer();
    const hash = 'm6'.padEnd(64, '0');
    const failed = tx(hash, {
      spendsCollaterals: true,
      inputs: [{ address: 'addrColl', amount: [{ unit: UNIT_A, quantity: '50' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0, isCollateral: true }],
      outputs: [out(hash, 1, [{ unit: 'lovelace', quantity: '1000000' }], true)],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [failed]);

    expect(historyRows()).toHaveLength(0);
  });

  it('skips a transaction whose consumed input could not be resolved', async () => {
    const { indexer } = makeIndexer();
    const hash = 'm7'.padEnd(64, '0');
    const unresolved = tx(hash, {
      // chain-sync bare reference to an output created before the crawl start:
      // resolveInputs() finds nothing locally, so address stays empty
      inputs: [{ address: '', amount: [], txHash: 'old'.padEnd(64, '0'), outputIndex: 3 }],
      outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '777' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [unresolved]);

    // a 777 "mint" here would be an artefact of the missing input, not a fact
    expect(historyRows()).toHaveLength(0);
  });

  it('writes no AssetHistory statement at all when the block mints nothing', async () => {
    const { indexer } = makeIndexer();
    await indexer.indexBlockFull(mockTx as never, blockData({ txCount: 0 }), []);
    expect(upsertsFor('AssetHistory')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Asset catalogue (bare rows)
// ---------------------------------------------------------------------------

const assetWrites = () => upsertsFor('AssetsTable');
const assetSelects = () => runs.filter(q => q._op === 'SELECT.many' && q.entity === 'AssetsTable');

describe('CardanoIndexer.indexBlockFull — asset catalogue', () => {
  it('writes a bare row for every unseen unit, with fingerprint and decoded name', async () => {
    const { indexer } = makeIndexer();
    const hash = 'c1'.padEnd(64, '0');
    const t = tx(hash, { outputs: [out(hash, 0, [{ unit: 'lovelace', quantity: '1' }, { unit: UNIT_A, quantity: '5' }])] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    const rows = assetWrites()[0].entries as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1); // lovelace is not a catalogue entry
    expect(rows[0]).toMatchObject({ unit: UNIT_A, policyId: POLICY, assetName: 'TOKA' });
    expect(rows[0].fingerprint).toMatch(/^asset1/);
    // born expired at the fixed sentinel, so the lazy path still treats the first keyed
    // read as a miss AND no mapAsset() slice can ever share the (validFrom, unit) key
    expect(rows[0].validFrom).toBe(BARE_ASSET_STAMP);
    expect(rows[0].validTo).toBe(BARE_ASSET_STAMP);
  });

  it('never rewrites a unit the table already holds — an enriched row must survive', async () => {
    const { indexer } = makeIndexer();
    knownAssets = [UNIT_A];
    const hash = 'c2'.padEnd(64, '0');
    const t = tx(hash, { outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '5' }])] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    expect(assetWrites()).toHaveLength(0);
  });

  it('memoizes a unit it has written, so the next block costs no SELECT', async () => {
    const { indexer } = makeIndexer();
    const t1 = tx('c3'.padEnd(64, '0'), { outputs: [out('c3'.padEnd(64, '0'), 0, [{ unit: UNIT_A, quantity: '5' }])] });
    const t2 = tx('c4'.padEnd(64, '0'), { outputs: [out('c4'.padEnd(64, '0'), 0, [{ unit: UNIT_A, quantity: '6' }])] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t1]);
    const selectsAfterFirst = assetSelects().length;
    await indexer.indexBlockFull(mockTx as never, blockData({ hash: 'blk2'.padEnd(64, '9') }), [t2]);

    expect(assetSelects()).toHaveLength(selectsAfterFirst);
    expect(assetWrites()).toHaveLength(1);
  });

  it('catalogues units seen on the input side too', async () => {
    const { indexer } = makeIndexer();
    const hash = 'c5'.padEnd(64, '0');
    const t = tx(hash, {
      inputs: [{ address: 'addrIn', amount: [{ unit: UNIT_B, quantity: '3' }], txHash: 'src'.padEnd(64, '0'), outputIndex: 0 }],
      outputs: [out(hash, 0, [{ unit: UNIT_B, quantity: '3' }])],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    const rows = assetWrites()[0].entries as Array<Record<string, unknown>>;
    expect(rows.map(r => r.unit)).toEqual([UNIT_B]);
  });

  it('writes nothing when the catalogue is switched off', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off' });
    const hash = 'c6'.padEnd(64, '0');
    const t = tx(hash, { outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '5' }])] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    expect(assetWrites()).toHaveLength(0);
    expect(assetSelects()).toHaveLength(0);
  });

  it('writes no mint rows when mint/burn coverage is switched off', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: false, assetCatalogue: 'bare' });
    const hash = 'c7'.padEnd(64, '0');
    const t = tx(hash, { mint: [{ unit: UNIT_A, quantity: '10' }], outputs: [out(hash, 0, [{ unit: UNIT_A, quantity: '10' }])] });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    expect(upsertsFor('AssetHistory')).toHaveLength(0);
    expect(assetWrites()).toHaveLength(1); // catalogue is independent of it
  });
});

// ---------------------------------------------------------------------------
// Crawler-fed ledger state: outpoint on inputs, certificates, withdrawals
// ---------------------------------------------------------------------------
describe('CardanoIndexer.indexBlockFull — outpoint, certificates, withdrawals', () => {
  const STAKE = 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn';
  const POOL = 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r';
  const withCerts = (hash: string): Transaction => tx(hash, {
    certificates: [
      { certIndex: 0, kind: 'stake_registration', stakeAddress: STAKE, deposit: '2000000' },
      { certIndex: 1, kind: 'pool_delegation', stakeAddress: STAKE, poolId: POOL },
      { certIndex: 1, kind: 'vote_delegation', stakeAddress: STAKE, drepId: 'drep_always_abstain' },
    ],
    withdrawals: [{ stakeAddress: STAKE, amount: '123456' }],
  });

  it('persists the consumed outpoint on every input row — no knob, no network', async () => {
    const { indexer } = makeIndexer();
    const t = tx('t9'.padEnd(64, '0'), {
      inputs: [{ address: 'addrA', amount: [], txHash: 'prev'.padEnd(64, '0'), outputIndex: 3 }],
    });

    await indexer.indexBlockFull(mockTx as never, blockData(), [t]);

    expect(upsertsFor('TransactionInputs')[0].entries).toEqual([
      expect.objectContaining({ tx_hash: 't9'.padEnd(64, '0'), inputIndex: 0, spentTxHash: 'prev'.padEnd(64, '0'), spentOutputIndex: 3 }),
    ]);
  });

  it('writes nothing for certificates/withdrawals by default (opt-in knob)', async () => {
    const { indexer } = makeIndexer();

    await indexer.indexBlockFull(mockTx as never, blockData(), [withCerts('c1'.padEnd(64, '0'))]);

    expect(upsertsFor('TransactionCertificates')).toHaveLength(0);
    expect(upsertsFor('TransactionWithdrawals')).toHaveLength(0);
  });

  it('writes one row per (tx, certIndex, kind) and one per withdrawal when enabled', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', certificates: true });
    const hash = 'c2'.padEnd(64, '0');

    await indexer.indexBlockFull(mockTx as never, blockData(), [withCerts(hash)]);

    expect(upsertsFor('TransactionCertificates')).toHaveLength(1);
    expect(upsertsFor('TransactionCertificates')[0].entries).toEqual([
      { tx_hash: hash, certIndex: 0, kind: 'stake_registration', stakeAddress: STAKE, poolId: null, drepId: null, deposit: '2000000', epoch: null },
      { tx_hash: hash, certIndex: 1, kind: 'pool_delegation', stakeAddress: STAKE, poolId: POOL, drepId: null, deposit: null, epoch: null },
      { tx_hash: hash, certIndex: 1, kind: 'vote_delegation', stakeAddress: STAKE, poolId: null, drepId: 'drep_always_abstain', deposit: null, epoch: null },
    ]);
    expect(upsertsFor('TransactionWithdrawals')[0].entries).toEqual([
      { tx_hash: hash, stakeAddress: STAKE, lovelace: '123456' },
    ]);
  });

  it('issues no statement for a block whose transactions carry none ([] = known empty)', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', certificates: true });

    await indexer.indexBlockFull(mockTx as never, blockData(), [tx('c3'.padEnd(64, '0'), { certificates: [], withdrawals: [] })]);

    expect(upsertsFor('TransactionCertificates')).toHaveLength(0);
    expect(upsertsFor('TransactionWithdrawals')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Crawler-fed UTxO set: the indexer applies a block only past the anchor
// ---------------------------------------------------------------------------
describe('CardanoIndexer.indexBlockFull — ledger state gating', () => {
  const ledger = () => (applyBlockToLedger as unknown as Mock);
  beforeEach(() => {
    ledger().mockClear(); (setUtxoSetState as unknown as Mock).mockClear(); (readCursor as unknown as Mock).mockClear();
    cursorRow = { lastSlot: 5000, lastBlockHash: 'h', utxoSet: { appliedSlot: null } };
  });

  it('does nothing when the mode is off, even with an anchor', async () => {
    const { indexer } = makeIndexer();
    indexer.setUtxoAnchor({ slot: 100, hash: 'h' });
    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5000 }), [tx('l1'.padEnd(64, '0'))]);
    expect(ledger()).not.toHaveBeenCalled();
    expect(indexer.getUtxoAnchor()).toBeNull(); // no anchor reported while the mode is off
  });

  it('does nothing when the mode is on but no snapshot anchor exists', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', utxoSet: true });
    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5000 }), [tx('l2'.padEnd(64, '0'))]);
    expect(ledger()).not.toHaveBeenCalled();
  });

  it('applies blocks strictly after the anchor, in the same transaction', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', utxoSet: true });
    indexer.setUtxoAnchor({ slot: 5000, hash: 'h' });
    expect(indexer.getUtxoAnchor()).toEqual({ slot: 5000, hash: 'h' });

    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5000 }), [tx('l3'.padEnd(64, '0'))]);
    expect(ledger()).not.toHaveBeenCalled(); // the anchor block itself is already in the snapshot

    const txs = [tx('l4'.padEnd(64, '0'))];
    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5001 }), txs);
    expect(ledger()).toHaveBeenCalledTimes(1);
    expect(ledger().mock.calls[0][0]).toBe(mockTx);
    expect(ledger().mock.calls[0][1]).toMatchObject({ slot: 5001 });
    expect(ledger().mock.calls[0][2]).toBe(txs);
    // the cursor was the anchor when the first block past it arrived — verified, no invalidation
    expect(setUtxoSetState).not.toHaveBeenCalled();
    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5002 }), txs);
    expect(readCursor).toHaveBeenCalledTimes(1); // verified once per anchor
  });

  it('accepts the anchor at the configured start block (bootstrap: cursor set, no Blocks row yet)', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', utxoSet: true });
    indexer.setUtxoAnchor({ slot: 5000, hash: 'H' }); // hash case must not matter
    cursorRow = { lastSlot: 5000, lastBlockHash: 'h', utxoSet: { appliedSlot: null } };

    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5001 }), [tx('l7'.padEnd(64, '0'))]);

    expect(ledger()).toHaveBeenCalledTimes(1);
    expect(setUtxoSetState).not.toHaveBeenCalled();
  });

  it('invalidates the set instead of applying when the cursor is not the anchor (snapshot on a dropped fork)', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', utxoSet: true });
    indexer.setUtxoAnchor({ slot: 5000, hash: 'h' });
    cursorRow = { lastSlot: 5000, lastBlockHash: 'other', utxoSet: { appliedSlot: null } };

    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5001 }), [tx('l5'.padEnd(64, '0'))]);

    expect(ledger()).not.toHaveBeenCalled();
    expect(setUtxoSetState).toHaveBeenCalledWith(mockTx, expect.objectContaining({ status: 'invalid', error: expect.stringContaining('not the block the crawler followed') }));
    // pending until the crawler confirms the commit: no anchor reported (no progress marker),
    // a retry of the block re-writes the verdict instead of re-verifying or applying
    expect(indexer.getUtxoAnchor()).toBeNull();
    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 5001 }), [tx('l5'.padEnd(64, '0'))]);
    expect(ledger()).not.toHaveBeenCalled();
    expect(setUtxoSetState).toHaveBeenCalledTimes(2);
    expect(readCursor).toHaveBeenCalledTimes(1);
    expect(indexer.takeLedgerInvalidation()).toMatch(/not the block the crawler followed/);
    expect(indexer.takeLedgerInvalidation()).toBeNull(); // handed out once
  });

  it('skips the check after a restart once a block has been applied (utxoAppliedSlot set)', async () => {
    const { indexer } = makeIndexer();
    indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'off', utxoSet: true });
    indexer.setUtxoAnchor({ slot: 5000, hash: 'h' });
    cursorRow = { lastSlot: 7000, lastBlockHash: 'far-ahead', utxoSet: { appliedSlot: 7000 } };

    await indexer.indexBlockFull(mockTx as never, blockData({ slot: 7001 }), [tx('l6'.padEnd(64, '0'))]);

    expect(ledger()).toHaveBeenCalledTimes(1);
    expect(setUtxoSetState).not.toHaveBeenCalled();
  });
});
