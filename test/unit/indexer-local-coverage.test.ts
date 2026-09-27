/**
 * CardanoIndexer: values answered from crawled data while a live crawler is at the tip —
 * pool block counts from Blocks, controlled amount from LedgerAccounts, circulating supply
 * from LedgerAddresses — and the epoch snapshot writes. String entity proxies, real mappers.
 */

type Q = { _op: string; entity: string; columns?: string; where?: Record<string, unknown>; entries?: unknown };
const runs: Q[] = [];
let blockCounts: { sinceEpochStart: number; total: number } = { sinceEpochStart: 0, total: 0 };
let ledgerControlled: unknown = undefined;
let ledgerTotal: unknown = undefined;
/** What the epoch aggregate over crawled Blocks returns (cds.db.run). */
let epochTotals: Record<string, unknown> | undefined;
const dbRuns: Q[] = [];
/** Crawled blocks per pool for the snapshot's grouped count (cds.db.run with groupBy). */
let blocksByPool: Array<{ slotLeader: string; n: number | string }> = [];
/** Pool rows of the previous epoch's Ogmios snapshot (cds.db.run on PoolEpochSnapshots). */
let previousLive: Array<{ poolId: string; liveStake: string }> = [];

/** Per-test answers for queries the default dispatch does not cover (undefined = fall through). */
let answer: ((q: Q) => unknown) | null = null;

const mockTx = {
  run: vi.fn(async (q: Q) => {
    runs.push(q);
    const custom = answer?.(q);
    if (custom !== undefined) return custom;
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
      return Object.assign(q, {
        where: (where: Record<string, unknown>) => ({ ...q, where, groupBy: (by: string) => ({ ...q, where, groupBy: by }) }),
      });
    },
    where: (where: Record<string, unknown>) => ({ _op: 'SELECT.one', entity, where }),
  });
  // SELECT.many: tagged so the dispatch can tell it from SELECT.one; orderBy/limit are recorded
  const many = (entity: string) => {
    const finish = (q: Record<string, unknown>) => ({
      ...q,
      orderBy: (orderBy: string) => ({ ...q, orderBy, limit: (limit: number) => ({ ...q, orderBy, limit }) }),
      groupBy: (groupBy: string) => ({ ...q, groupBy }),
    });
    return {
      columns: (...columns: string[]) => ({
        where: (where: Record<string, unknown>) => finish({ _op: 'SELECT.many', entity, columns: columns.join(','), where }),
      }),
      where: (where: Record<string, unknown>) => finish({ _op: 'SELECT.many', entity, where }),
    };
  };
  const cdsMock = {
    db: {
      run: vi.fn(async (q: Q & { groupBy?: string }) => {
        dbRuns.push(q);
        if (typeof q.groupBy === 'string') return blocksByPool;
        if (q.entity === 'PoolEpochSnapshots') return previousLive;
        return q.entity === 'Blocks' ? epochTotals : undefined;
      }),
    },
    tx: async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    ql: {
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
      UPDATE: { entity: (entity: string) => ({ set: () => ({ where: () => ({ _op: 'UPDATE', entity }) }) }) },
      DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
      SELECT: { one: { from: one }, from: many },
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
  EpochLedgerSnapshots: 'EpochLedgerSnapshots',
  Account: 'Account', Drep: 'Drep', Pool: 'Pool', Asset: 'Asset', Address: 'Address',
  LedgerProtocolParameter: 'LedgerProtocolParameter', AddressTransactions: 'AddressTransactions',
  TransactionCertificates: 'TransactionCertificates', TransactionWithdrawals: 'TransactionWithdrawals',
  LedgerAddresses: 'LedgerAddresses', LedgerAccounts: 'LedgerAccounts',
}));
vi.mock('#cds-models/odatano/cardano', () => ({
  Assets: 'AssetsTable', Transactions: 'Transactions', LedgerUTxOs: 'LedgerUTxOs', LedgerUTxOAssets: 'LedgerUTxOAssets',
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
    // a provider is configured unless a test says otherwise
    hasBackendFor: vi.fn((_method: string) => true),
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
  blocksByPool = [];
  previousLive = [];
  answer = null;
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

describe('epoch snapshots', () => {
  const AT = { slot: 103_766_400, time: 1_770_000_000, hash: 'ab'.repeat(32) };
  const ledgerState = {
    epoch: 1201,
    pools: [{
      poolId: POOL, vrfKeyHash: 'v', blocksMinted: 0, blocksEpoch: null, liveStake: '300', liveSize: 0.75,
      liveSaturation: 0.1, liveDelegators: null, activeStake: '250', activeSize: 0.5, pledge: '10', margin: 0.02,
      fixedCost: '340000000', rewardAccount: 'stake_test1x',
    }],
    dreps: [{
      drepId: 'drep1x', hex: 'aa', amount: '40', hasScript: false, lastActiveEpoch: 0, retired: false, expired: false,
      deposit: '500000000', expiresEpoch: 1220, delegatorCount: 3,
    }],
    treasury: '1700000000000000', reserves: '7000000000000000',
    drepAbstainStake: '9', drepNoConfidenceStake: null,
  };
  const withLedger = () => {
    const { client, indexer } = makeIndexer();
    const epochStateAt = vi.fn(async () => ledgerState);
    Object.assign(client, { getEpochStateBackend: () => ({ epochStateAt }), getEnumeratingBackend: () => null });
    return { indexer, epochStateAt };
  };

  it('reads the node ledger at the block and writes dated rows plus the epoch marker', async () => {
    blocksByPool = [{ slotLeader: POOL, n: '812' }];
    // the previous epoch's Ogmios snapshot recorded the stake that is active now
    previousLive = [{ poolId: POOL, liveStake: '250' }, { poolId: 'pool1other', liveStake: '250' }];
    const { indexer, epochStateAt } = withLedger();

    expect(await indexer.snapshotEpoch(1201, AT)).toEqual({ pools: 1, dreps: 1, source: 'ogmios' });

    expect(epochStateAt).toHaveBeenCalledWith({ slot: AT.slot, hash: AT.hash });
    expect((upserted('PoolEpochSnapshots') as unknown as Record<string, unknown>[])[0]).toMatchObject({
      poolId: POOL, epoch: 1201, snapshotSlot: AT.slot, snapshotHash: AT.hash, source: 'ogmios',
      liveStake: '300', activeStake: '250', activeSize: 0.5, liveDelegators: null, blocksMinted: 812,
    });
    expect(dbRuns.find(q => q.entity === 'PoolEpochSnapshots')?.where).toEqual({ epoch: 1200, source: 'ogmios' });
    expect((upserted('DrepEpochSnapshots') as unknown as Record<string, unknown>[])[0]).toMatchObject({
      drepId: 'drep1x', source: 'ogmios', deposit: '500000000', expiresEpoch: 1220, delegatorCount: 3,
    });
    expect(upserted('EpochLedgerSnapshots')).toMatchObject({
      epoch: 1201, source: 'ogmios', snapshotHash: AT.hash, treasury: '1700000000000000',
      reserves: '7000000000000000', totalSupply: '38000000000000000', liveStake: '300', activeStake: '500',
      poolCount: 1, drepCount: 1, drepAbstainStake: '9', drepNoConfidenceStake: null,
    });
    // the acquired state may be hours old: the live rows are not touched
    expect(upserted('Pools')).toBeUndefined();
    expect(upserted('Dreps')).toBeUndefined();
  });

  it('leaves active stake empty without a snapshot of the previous epoch', async () => {
    const { indexer } = withLedger();
    await indexer.snapshotEpoch(1201, AT);
    expect((upserted('PoolEpochSnapshots') as unknown as Record<string, unknown>[])[0]).toMatchObject({ activeStake: null, activeSize: null });
    expect(upserted('EpochLedgerSnapshots')).toMatchObject({ activeStake: null });
  });

  it('leaves blocksMinted empty when the crawl started after Shelley', async () => {
    cursor = synced({ startSlot: 50_000_000 });
    const { indexer } = withLedger();
    await indexer.snapshotEpoch(1201, AT);
    expect((upserted('PoolEpochSnapshots') as unknown as Record<string, unknown>[])[0].blocksMinted).toBeNull();
    expect(dbRuns.some(q => typeof (q as { groupBy?: unknown }).groupBy === 'string')).toBe(false);
  });

  it('uses Koios (current state) without a block hash and marks the epoch as a koios snapshot', async () => {
    const { client, indexer } = makeIndexer();
    const koios = {
      getPoolIds: vi.fn(async () => [POOL]), getPools: vi.fn(async () => [{ ...ledgerState.pools[0], liveDelegators: 7 }]),
      getDrepIds: vi.fn(async () => []), getDreps: vi.fn(async () => []),
    };
    Object.assign(client, { getEpochStateBackend: () => ({ epochStateAt: vi.fn() }), getEnumeratingBackend: () => koios });

    expect(await indexer.snapshotEpoch(1201, { slot: AT.slot, time: AT.time, hash: null })).toEqual({ pools: 1, dreps: 0, source: 'koios' });
    expect((upserted('PoolEpochSnapshots') as unknown as Record<string, unknown>[])[0]).toMatchObject({ source: 'koios', snapshotHash: null, liveDelegators: 7 });
    expect(upserted('EpochLedgerSnapshots')).toMatchObject({ epoch: 1201, source: 'koios', poolCount: 1, drepCount: 0 });
    expect(upserted('Pools')).toBeDefined();
  });

  it('skips without any backend that can read pools', async () => {
    const { client, indexer } = makeIndexer();
    Object.assign(client, { getEpochStateBackend: () => null, getEnumeratingBackend: () => null });
    expect(await indexer.snapshotEpoch(1201, AT)).toEqual({ pools: 0, dreps: 0, source: null });
    expect(runs.filter(q => q._op === 'UPSERT')).toHaveLength(0);
  });
});

describe('addresses from the crawled UTxO set', () => {
  const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
  const T1 = '1'.repeat(64);
  const T2 = '2'.repeat(64);
  const UNIT = `${'p'.repeat(56)}746f6b`;
  const w = (q: Q) => q.where ?? {};

  it('lists received and spent transactions with net amounts, newest first', async () => {
    answer = (q) => {
      if (q.entity === 'LedgerAddresses' && q._op === 'SELECT.one') return { firstSeenSlot: 100 };
      if (q.entity !== 'LedgerUTxOs') return undefined;
      if ('createdSlot' in w(q)) return [{ txHash: T1, createdSlot: 200 }];
      if ('spentSlot' in w(q)) return [{ spentTxHash: T2, spentSlot: 300 }];
      if ('txHash' in w(q)) return [{ txHash: T1, outputIndex: 0, lovelace: '5000000', hasAssets: false }];
      if ('spentTxHash' in w(q)) return [{ txHash: T1, outputIndex: 0, lovelace: '5000000', hasAssets: false, spentTxHash: T2 }];
      return undefined;
    };
    const { indexer } = makeIndexer();
    const rows = await indexer.indexAddressTransactions(mockTx as never, ADDR, 10) as unknown as Array<Record<string, unknown>>;

    expect(rows.map(r => [r.tx_hash, String(r.netAmount)])).toEqual([[T2, '-5000000'], [T1, '5000000']]);
    expect(Number(rows[0].blockTime)).toBeGreaterThan(Number(rows[1].blockTime));
    expect(upserted('AddressTransactions')).toBeDefined();
  });

  it('asks the provider when the address predates the anchor and the crawled history is short', async () => {
    answer = (q) => {
      if (q.entity === 'LedgerAddresses' && q._op === 'SELECT.one') return { firstSeenSlot: null };
      if (q.entity === 'LedgerUTxOs') return [];
      return undefined;
    };
    const { client, indexer } = makeIndexer();
    const getAddressTransactionHashes = vi.fn(async () => []);
    Object.assign(client, { getAddressTransactionHashes });
    await indexer.indexAddressTransactions(mockTx as never, ADDR, 10);
    expect(getAddressTransactionHashes).toHaveBeenCalledWith(ADDR, 10);
  });

  it('keeps the crawled history when no backend has address history', async () => {
    answer = (q) => {
      if (q.entity === 'LedgerAddresses' && q._op === 'SELECT.one') return { firstSeenSlot: null };
      if (q.entity !== 'LedgerUTxOs') return undefined;
      if ('createdSlot' in w(q)) return [{ txHash: T1, createdSlot: 200 }];
      if ('spentSlot' in w(q)) return [];
      if ('txHash' in w(q)) return [{ txHash: T1, outputIndex: 0, lovelace: '5000000', hasAssets: false }];
      return [];
    };
    const { client, indexer } = makeIndexer();
    const { ProviderUnavailableError } = await import('../../srv/utils/errors');
    Object.assign(client, { getAddressTransactionHashes: vi.fn(async () => { throw new ProviderUnavailableError('no history backend', 'ogmios'); }) });
    const rows = await indexer.indexAddressTransactions(mockTx as never, ADDR, 10) as unknown as Array<Record<string, unknown>>;
    expect(rows.map(r => r.tx_hash)).toEqual([T1]);
  });

  it('builds the address from its UTxOs at the node tip, balance summed, type decoded', async () => {
    const { client, indexer } = makeIndexer();
    const getAddress = vi.fn();
    Object.assign(client, {
      getAddress,
      getAddressTransactionHashes: vi.fn(async () => []),
      getUtxosByAddresses: vi.fn(async () => [
        { txHash: T1, outputIndex: 0, address: ADDR, amount: [{ unit: 'lovelace', quantity: '2000000' }] },
        { txHash: T2, outputIndex: 1, address: ADDR, amount: [{ unit: 'lovelace', quantity: '3000000' }, { unit: UNIT, quantity: '4' }] },
      ]),
    });
    answer = (q) => (q.entity === 'LedgerAddresses' && q._op === 'SELECT.one' ? { firstSeenSlot: 1 } : q.entity === 'LedgerUTxOs' ? [] : undefined);

    const address = await indexer.indexAddress(mockTx as never, ADDR) as unknown as Record<string, unknown>;

    expect(getAddress).not.toHaveBeenCalled();
    expect(address).toMatchObject({ address: ADDR, type: 'base', totalLovelace: '5000000', utxoCount: 2, hasAssets: true,
      stakeAddress: 'stake_test1uzkwsx05zawfcpyj8x53e8q8an3qhal8fpwhe4q5uus6tlq5k9vsh' });
  });

  it('fills a zero active stake from the Ogmios snapshot of the running epoch', async () => {
    answer = (q) => (q.entity === 'PoolEpochSnapshots' ? { activeStake: '777', activeSize: 0.01 } : undefined);
    const { client, indexer } = makeIndexer();
    const base = await client.getPool();
    client.getPool.mockResolvedValueOnce({ ...base, activeStake: '0' });
    await indexer.indexPool(mockTx as never, POOL);
    const snap = runs.find(q => q.entity === 'PoolEpochSnapshots')!;
    expect(snap.where).toEqual({ poolId: POOL, epoch: 1432, source: 'ogmios' });
    expect(upserted('Pools')).toMatchObject({ activeStake: '777' });
  });

  it('sums crawled withdrawals only when certificates are crawled since Shelley', async () => {
    answer = (q) => (q.entity === 'TransactionWithdrawals' ? { total: '1200' } : undefined);
    const { indexer } = makeIndexer();
    await indexer.indexAccount(mockTx as never, 'stake_test1x');
    expect(upserted('Accounts')).toMatchObject({ withdrawalsSum: '0' }); // certificates off

    indexer.configureCrawlCoverage({ certificates: true } as never);
    await indexer.indexAccount(mockTx as never, 'stake_test1x');
    const last = runs.filter(q => q._op === 'UPSERT' && q.entity === 'Accounts').pop()!;
    expect((last.entries as Record<string, unknown>).withdrawalsSum).toBe('1200');
  });
});

describe('crawled chain as the authority (crawler.authoritative)', () => {
  const TX = 'a'.repeat(64);
  const UNIT = `${'b'.repeat(56)}746f6b656e`;
  const authoritative = () => {
    const made = makeIndexer();
    made.indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'bare', authoritative: true });
    return made;
  };

  it('answers a transaction the crawl does not hold with 404, without asking a provider', async () => {
    const { client, indexer } = authoritative();
    const getTransaction = vi.fn();
    Object.assign(client, { getTransaction });
    await expect(indexer.indexTransaction(mockTx as never, TX)).rejects.toMatchObject({ statusCode: 404 });
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('also answers 404 without the knob when no configured backend can look the block up', async () => {
    const { client, indexer } = makeIndexer();
    client.hasBackendFor.mockReturnValue(false); // Ogmios only
    const getBlock = vi.fn();
    Object.assign(client, { getBlock });
    await expect(indexer.indexBlock(mockTx as never, 'c'.repeat(64))).rejects.toMatchObject({ statusCode: 404 });
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('still asks the provider when the crawl started after Shelley', async () => {
    cursor = synced({ startSlot: 50_000_000 });
    const { client, indexer } = authoritative();
    const getTransaction = vi.fn(async () => { throw new Error('provider asked'); });
    Object.assign(client, { getTransaction });
    await expect(indexer.indexTransaction(mockTx as never, TX)).rejects.toThrow('provider asked');
  });

  it('reports no metadata for a crawled transaction without metadata rows', async () => {
    answer = (q) => (q.entity === 'Transactions' && q._op === 'SELECT.one' ? { hash: TX } : undefined);
    const { client, indexer } = authoritative();
    const getTransactionMetadata = vi.fn();
    Object.assign(client, { getTransactionMetadata });
    expect(await indexer.indexTransactionMetadata(mockTx as never, TX)).toEqual([]);
    expect(getTransactionMetadata).not.toHaveBeenCalled();
  });

  it('builds the asset from crawled mint/burn rows and the CIP-25 payload of the latest mint', async () => {
    const cip25 = { [('b').repeat(56)]: { token: { name: 'Token', image: 'ipfs://x' } } };
    answer = (q) => {
      if (q.entity === 'AssetHistory') return [
        { txHash: 'm1', action: 'mint', quantity: '100', blockTime: 1_700_000_000, blockHeight: 10 },
        { txHash: 'b1', action: 'burn', quantity: '30', blockTime: 1_700_000_100, blockHeight: 20 },
        { txHash: 'm2', action: 'mint', quantity: '5', blockTime: 1_700_000_200, blockHeight: 30 },
      ];
      if (q.entity === 'TransactionMetadata') return (q.where as Record<string, unknown>).tx_hash === 'm2' ? { payload: JSON.stringify(cip25) } : undefined;
      return undefined;
    };
    const { client, indexer } = authoritative();
    const getAssetInfo = vi.fn();
    Object.assign(client, { getAssetInfo });

    const asset = await indexer.indexAsset(mockTx as never, UNIT) as unknown as Record<string, unknown>;

    expect(getAssetInfo).not.toHaveBeenCalled();
    expect(asset).toMatchObject({
      unit: UNIT, policyId: 'b'.repeat(56), assetNameHex: '746f6b656e', assetName: 'token',
      totalSupply: '75', mintOrBurnCount: 3, initialMintTxHash: 'm1', initialMintTime: 1_700_000_000,
    });
    expect(String(asset.fingerprint)).toMatch(/^asset1/);
    expect(JSON.stringify(asset)).toContain('ipfs://x');
  });

  it('answers 404 for an asset the crawled chain never minted', async () => {
    answer = (q) => (q.entity === 'AssetHistory' ? [] : undefined);
    const { indexer } = authoritative();
    await expect(indexer.indexAsset(mockTx as never, UNIT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves the asset history from the crawled rows', async () => {
    const rows = [{ unit: UNIT, txHash: 'm1', action: 'mint', quantity: '100', blockTime: 1, blockHeight: 10 }];
    answer = (q) => (q.entity === 'AssetHistory' ? rows : undefined);
    const { client, indexer } = authoritative();
    const getAssetHistory = vi.fn();
    Object.assign(client, { getAssetHistory });
    expect(await indexer.indexAssetHistory(mockTx as never, UNIT, 5)).toEqual(rows);
    expect(getAssetHistory).not.toHaveBeenCalled();
    const q = runs.find(r => r.entity === 'AssetHistory') as Q & { orderBy?: string; limit?: number };
    expect(q).toMatchObject({ orderBy: 'blockHeight desc', limit: 5 });
  });
});
