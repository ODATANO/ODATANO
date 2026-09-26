/**
 * CardanoIndexer: values answered from crawled data while a live crawler is at the tip —
 * pool block counts from Blocks, controlled amount from LedgerAccounts, circulating supply
 * from LedgerAddresses. String entity proxies, real mappers.
 */

type Q = { _op: string; entity: string; columns?: string; where?: Record<string, unknown>; entries?: unknown };
const runs: Q[] = [];
let blockCounts: { sinceEpochStart: number; total: number } = { sinceEpochStart: 0, total: 0 };
let ledgerControlled: unknown = undefined;
let ledgerTotal: unknown = undefined;
/** What the epoch aggregate over crawled Blocks returns (cds.db.run). */
let epochTotals: Record<string, unknown> | undefined;
const dbRuns: Q[] = [];

const mockTx = {
  run: vi.fn(async (q: Q) => {
    runs.push(q);
    if (q._op === 'SELECT.one' && q.entity === 'Blocks') {
      const slot = (q.where?.slot as { '>=': number })['>='];
      return { n: slot === 0 ? blockCounts.total : blockCounts.sinceEpochStart };
    }
    if (q._op === 'SELECT.one' && q.entity === 'LedgerAccounts') return ledgerControlled === undefined ? undefined : { controlledAmount: ledgerControlled };
    if (q._op === 'SELECT.one' && q.entity === 'LedgerAddresses') return { total: ledgerTotal };
    return undefined;
  }),
};

vi.mock('@sap/cds', () => {
  const one = (entity: string) => ({
    columns: (columns: string) => {
      const q: Q = { _op: 'SELECT.one', entity, columns };
      return Object.assign(q, { where: (where: Record<string, unknown>) => ({ ...q, where }) });
    },
    where: (where: Record<string, unknown>) => ({ _op: 'SELECT.one', entity, where }),
  });
  const cdsMock = {
    db: { run: vi.fn(async (q: Q) => { dbRuns.push(q); return q.entity === 'Blocks' ? epochTotals : undefined; }) },
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    ql: {
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
      UPDATE: { entity: (entity: string) => ({ set: () => ({ where: () => ({ _op: 'UPDATE', entity }) }) }) },
      DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
      SELECT: { one: { from: one }, from: one },
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
  UTxOAssets: 'UTxOAssets', Block: 'Block', Blocks: 'Blocks', Epoch: 'Epoch', Accounts: 'Accounts',
  Pools: 'Pools', Dreps: 'Dreps', Assets: 'Assets', AssetHistory: 'AssetHistory',
  PoolEpochSnapshots: 'PoolEpochSnapshots', DrepEpochSnapshots: 'DrepEpochSnapshots',
  Account: 'Account', Drep: 'Drep', Pool: 'Pool', Asset: 'Asset', Address: 'Address',
  LedgerProtocolParameter: 'LedgerProtocolParameter', AddressTransactions: 'AddressTransactions',
  TransactionCertificates: 'TransactionCertificates', TransactionWithdrawals: 'TransactionWithdrawals',
  LedgerAddresses: 'LedgerAddresses', LedgerAccounts: 'LedgerAccounts',
}));
vi.mock('#cds-models/odatano/cardano', () => ({ Assets: 'AssetsTable', Transactions: 'Transactions' }));
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

let cursor: Record<string, unknown> | null = null;
let leaseActive = true;
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  setUtxoSetState: vi.fn(async () => undefined),
  readCursor: vi.fn(async () => cursor),
  isCrawlerLeaseActive: vi.fn(() => leaseActive),
}));

import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';

const POOL = 'pool1p0mrcmu9qn0x6nk4eunj0p8qy3tryv370a96u9su2l6jwkytnru';
// preview: 86 400 slots per epoch, so slot 123 744 027 lies in epoch 1432 starting at 123 724 800
const TIP_SLOT = 123_744_027;
const EPOCH_START = 123_724_800;

const synced = (over: Record<string, unknown> = {}) => ({
  syncStatus: 'synced', startSlot: 0, lastSlot: TIP_SLOT, utxoSet: { status: 'active' }, ...over,
});

function makeIndexer() {
  const client = {
    network: 'preview',
    max_age_ms: 60_000,
    getPool: vi.fn(async () => ({
      poolId: POOL, vrfKeyHash: 'v', blocksMinted: 5, blocksEpoch: null, liveStake: '1', liveSize: 0,
      liveSaturation: 0, liveDelegators: 0, activeStake: '0', activeSize: 0, pledge: '0', margin: 0,
      fixedCost: '0', rewardAccount: '',
    })),
    getAccount: vi.fn(async () => ({
      stakeaddress: 'stake_test1x', active: true, activeEpoch: 0, controlledAmount: '0', rewardsSum: '300',
      withdrawalsSum: '0', reservesSum: '0', treasurySum: '0', withdrawableAmount: '300',
      poolId: POOL, drepId: 'drep_always_abstain', addresses: [],
    })),
    getNetworkInformation: vi.fn(async () => ({
      supply: { max: '45000000000000000', total: '37446719827876210', circulating: '0', locked: '0', treasury: '7', reserves: '8' },
      stake: { live: '0', active: '0' },
    })),
  };
  return { client, indexer: new CardanoIndexer(client as never, {} as never) };
}

const upserted = (entity: string) => runs.find(q => q._op === 'UPSERT' && q.entity === entity)?.entries as Record<string, unknown>;

beforeEach(() => {
  runs.length = 0;
  dbRuns.length = 0;
  epochTotals = { blockCount: 4, txCount: '9', fees: '1700000', firstBlockTime: '1790380806', lastBlockTime: '1790467100' };
  mockTx.run.mockClear();
  cursor = synced();
  leaseActive = true;
  blockCounts = { sinceEpochStart: 3, total: 812 };
  ledgerControlled = '5000000';
  ledgerTotal = '29984126226016860';
});

describe('pool block counts from crawled blocks', () => {
  it('counts the current epoch and the lifetime when the crawl covers the chain from genesis', async () => {
    const { indexer } = makeIndexer();
    await indexer.indexPool(mockTx as never, POOL);

    const counts = runs.filter(q => q._op === 'SELECT.one' && q.entity === 'Blocks');
    expect(counts.map(q => q.where)).toEqual([
      { slotLeader: POOL, slot: { '>=': EPOCH_START } },
      { slotLeader: POOL, slot: { '>=': 0 } },
    ]);
    expect(upserted('Pools')).toMatchObject({ blocksEpoch: 3, blocksMinted: 812 });
  });

  it('counts only the epoch when the crawl started after Shelley', async () => {
    cursor = synced({ startSlot: 111_542_419 });
    const { indexer } = makeIndexer();
    await indexer.indexPool(mockTx as never, POOL);

    expect(upserted('Pools')).toMatchObject({ blocksEpoch: 3, blocksMinted: 5 });
  });

  it('keeps the backend values while the crawler is behind the tip or not running', async () => {
    for (const state of [synced({ syncStatus: 'syncing' }), null]) {
      runs.length = 0;
      cursor = state;
      const { indexer } = makeIndexer();
      await indexer.indexPool(mockTx as never, POOL);
      expect(upserted('Pools')).toMatchObject({ blocksEpoch: null, blocksMinted: 5 });
    }
    runs.length = 0;
    cursor = synced();
    leaseActive = false;
    const { indexer } = makeIndexer();
    await indexer.indexPool(mockTx as never, POOL);
    expect(upserted('Pools')).toMatchObject({ blocksEpoch: null, blocksMinted: 5 });
  });
});

describe('account controlled amount from the crawled UTxO set', () => {
  it('adds the UTxOs under the stake key to the reward balance and keeps the delegation', async () => {
    const { indexer } = makeIndexer();
    await indexer.indexAccount(mockTx as never, 'stake_test1x');

    expect(upserted('Accounts')).toMatchObject({
      controlledAmount: '5000300', poolId_poolId: POOL, drepId_drepId: 'drep_always_abstain',
    });
  });

  it('counts only the rewards for a stake key without UTxOs', async () => {
    ledgerControlled = undefined;
    const { indexer } = makeIndexer();
    await indexer.indexAccount(mockTx as never, 'stake_test1x');
    expect(upserted('Accounts')).toMatchObject({ controlledAmount: '300' });
  });

  it('keeps the backend value when the UTxO set is not active', async () => {
    cursor = synced({ utxoSet: { status: 'none' } });
    const { indexer } = makeIndexer();
    await indexer.indexAccount(mockTx as never, 'stake_test1x');
    expect(upserted('Accounts')).toMatchObject({ controlledAmount: '0' });
    expect(runs.some(q => q.entity === 'LedgerAccounts')).toBe(false);
  });
});

describe('circulating supply from the crawled UTxO set', () => {
  it('replaces circulating with the UTxO total', async () => {
    const { indexer } = makeIndexer();
    await indexer.indexNetworkInformation(mockTx as never);
    expect(upserted('NetworkInformation')).toMatchObject({ circulatingSupply: '29984126226016860', treasurySupply: '7' });
  });

  it('keeps the backend figure without an active UTxO set', async () => {
    cursor = synced({ utxoSet: { status: 'invalid' } });
    const { indexer } = makeIndexer();
    await indexer.indexNetworkInformation(mockTx as never);
    expect(upserted('NetworkInformation')).toMatchObject({ circulatingSupply: '0' });
  });
});

describe('crawl epoch rows from crawled blocks', () => {
  const EPOCH = 1431;
  const epochRow = (indexer: CardanoIndexer) => (indexer as any).crawlEpochCache.get(EPOCH)?.row;
  const providerEpoch = {
    epoch: EPOCH, start_time: 1, end_time: 2, first_block_time: 3, last_block_time: 4,
    block_count: 0, tx_count: 0, output: '555', fees: '0', active_stake: '777',
  };

  it('overlays block, transaction and fee totals on the backend row', async () => {
    const { client, indexer } = makeIndexer();
    (client as any).getEpoch = vi.fn(async () => providerEpoch);
    await indexer.prefetchCrawlEpoch(EPOCH);

    expect(dbRuns[0].where).toEqual({ epochNumber: EPOCH });
    expect(epochRow(indexer)).toEqual({
      epoch: EPOCH, startTime: 1, endTime: 2, firstBlockTime: 1790380806, lastBlockTime: 1790467100,
      blockCount: 4, txCount: 9, output: '555', fees: '1700000', activeStake: '777',
    });
  });

  it('builds the row from crawled blocks alone when the backend has no such epoch', async () => {
    const { client, indexer } = makeIndexer();
    (client as any).getEpoch = vi.fn(async () => { throw new Error('historic epoch not served'); });
    await indexer.prefetchCrawlEpoch(EPOCH);

    // preview: epoch 1431 spans slots 123 638 400 – 123 724 800
    expect(epochRow(indexer)).toEqual({
      epoch: EPOCH, startTime: 1666656000 + 123_638_400, endTime: 1666656000 + 123_724_800,
      output: null, activeStake: null,
      blockCount: 4, txCount: 9, fees: '1700000', firstBlockTime: 1790380806, lastBlockTime: 1790467100,
    });
  });

  it('leaves the backend row alone when the crawl started inside the epoch', async () => {
    cursor = synced({ startSlot: 123_700_000 });
    const { client, indexer } = makeIndexer();
    (client as any).getEpoch = vi.fn(async () => providerEpoch);
    await indexer.prefetchCrawlEpoch(EPOCH);

    expect(dbRuns).toHaveLength(0);
    expect(epochRow(indexer)).toMatchObject({ blockCount: 0, txCount: 0, fees: '0' });
  });
});
