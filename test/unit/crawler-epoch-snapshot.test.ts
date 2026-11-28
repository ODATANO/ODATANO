/**
 * Chain crawler — pool/DRep snapshots at epoch boundaries: once per epoch, outside the block
 * transaction, never failing the crawl, honouring snapshots another run recorded. Koios: only in
 * the tip's epoch. Ogmios: at the block itself while it is inside the node's volatile window.
 * Preview geometry: 86 400 slots/epoch from slot 0, so epoch 3 = slots 259 200..345 599 and
 * epoch 4 starts at 345 600; the tip guard derives the tip's epoch from its slot.
 */

type Q = { _op: string; entity: string; where?: unknown; set?: unknown; entries?: unknown };
const { dbRun, fakeDb, snapshotAccounts } = vi.hoisted(() => {
  const dbRun = vi.fn<(q: Q) => Promise<unknown>>();
  return { dbRun, fakeDb: { run: dbRun }, snapshotAccounts: vi.fn() };
});

// its own suite runs it on a real database
vi.mock('../../srv/blockchain/crawler/account-snapshots', () => ({ snapshotAccounts, dropAccountSnapshotsAfter: vi.fn() }));

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: () => 'uuid' },
    tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
    ql: {
      SELECT: {
        one: {
          from: (entity: string) => ({
            columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }) }),
            where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }),
          }),
        },
        from: (entity: string) => ({
          columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }) }),
          where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
        }),
      },
      DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
      INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: () => ({ _op: 'UPDATE', entity, set }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('../../srv/blockchain/asset-supply', () => ({
  assetSupplyHeight: vi.fn(async () => 0),
  computeAssetSupply: vi.fn(async () => undefined),
  undoAssetSupply: vi.fn(async () => undefined),
  lowerAssetSupplyHeight: vi.fn(async () => undefined),
}));
vi.mock('#cds-models/odatano/cardano', () => ({
  Blocks: 'odatano.cardano.Blocks',
  Transactions: 'odatano.cardano.Transactions',
  TransactionInputs: 'odatano.cardano.TransactionInputs',
  TransactionInputAssets: 'odatano.cardano.TransactionInputAssets',
  TransactionInputAssetCopies: 'odatano.cardano.TransactionInputAssetCopies',
  TransactionOutputs: 'odatano.cardano.TransactionOutputs',
  TransactionOutputAssets: 'odatano.cardano.TransactionOutputAssets',
  AddressTransactions: 'odatano.cardano.AddressTransactions',
  AddressUTxOs: 'odatano.cardano.AddressUTxOs',
  UTxOAssets: 'odatano.cardano.UTxOAssets',
  AssetHistory_: 'odatano.cardano.AssetHistory',
  TransactionMetadata_: 'odatano.cardano.TransactionMetadata',
  CardanoReorgLog: 'odatano.cardano.CardanoReorgLog',
  CardanoSyncState: 'odatano.cardano.CardanoSyncState',
  PoolEpochSnapshots: 'odatano.cardano.PoolEpochSnapshots',
  DrepEpochSnapshots: 'odatano.cardano.DrepEpochSnapshots',
  EpochLedgerSnapshots: 'odatano.cardano.EpochLedgerSnapshots',
  TransactionCertificates: 'odatano.cardano.TransactionCertificates',
  TransactionWithdrawals: 'odatano.cardano.TransactionWithdrawals',
}));

import { CardanoCrawler, type CrawlerConfig } from '../../srv/blockchain/crawler/crawler';
import type { ChainPoint, ChainSyncCallbacks, ChainSyncHandle } from '../../srv/blockchain/backends/cardano-backend';
import type { BlockData } from '../../srv/utils/types';
import { callSignal } from '../../srv/blockchain/backends/call-signal';

const CONFIG: CrawlerConfig = {
  enabled: true, startSlot: 1000, startBlockHash: 'start'.padEnd(64, '0'), startHeight: 10,
  source: 'auto', batchSize: 5, confirmationDepth: 3, pollIntervalMs: 10,
  assetHistory: true, assetCatalogue: 'bare', assetEnrichRate: 2, epochSnapshots: true, certificates: false, utxoSet: false,
};

const CURSOR_ROW = {
  ID: 'SINGLETON', lastSlot: '259200', lastBlockHash: 'cursor'.padEnd(64, '0'), lastHeight: '40',
  network: 'preview', syncStatus: 'syncing', consecutiveErrors: '0', desiredRunning: true,
  leaseOwner: null, leaseUntil: null,
};

/** Epoch 3, slot 259 300 — the crawl position in almost every case below. */
const block = (over: Partial<BlockData> = {}): BlockData => ({
  time: 1700000000, height: 41, hash: 'blk'.padEnd(64, '1'), slot: 259_300, slotLeader: '',
  epoch: 3, epochSlot: 100, size: 100, txCount: 0, fees: '0', ...over,
});

/** A tip in the same epoch as `block()` — i.e. the crawler is live, not backfilling. */
const TIP_EPOCH_3: ChainPoint = { slot: 259_400, hash: 'tip'.padEnd(64, '2'), height: 42 };
/** A tip far ahead, in epoch 9 — i.e. the crawler is still backfilling. */
const TIP_EPOCH_9: ChainPoint = { slot: 800_000, hash: 'tip'.padEnd(64, '3'), height: 900 };

/** Cursor row exists; no snapshot recorded yet unless `recordedEpochs` says so. */
let recordedEpochs: number[] = [];
function defaultDb() {
  const state: Record<string, unknown> = { ...CURSOR_ROW };
  dbRun.mockImplementation(async (q) => {
    if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...state };
    if (q._op === 'UPDATE' && q.entity.endsWith('CardanoSyncState')) {
      Object.assign(state, q.set as Record<string, unknown>);
      return 1;
    }
    if (q._op === 'SELECT.one' && q.entity.endsWith('PoolEpochSnapshots')) {
      const { epoch } = (q.where ?? {}) as { epoch?: number };
      return recordedEpochs.includes(epoch as number) ? { epoch } : undefined;
    }
    return undefined;
  });
}

function makeIndexer(snapshotEpoch = vi.fn().mockResolvedValue({ pools: 2, dreps: 1 })) {
  return {
    indexer: {
      indexBlockFull: vi.fn(),
      setUtxoAnchor: vi.fn(), getUtxoAnchor: vi.fn(() => null), takeLedgerInvalidation: vi.fn(() => null), confirmBlockCommit: vi.fn(),
      prefetchCrawlEpoch: vi.fn(),
      configureCrawlCoverage: vi.fn(),
      stopAssetEnrichment: vi.fn(),
      snapshotEpoch,
    },
    snapshotEpoch,
  };
}

const ACCOUNT_BACKEND = { rewardAccountsAt: vi.fn() };

/** Chain-sync client whose callbacks the test drives by hand; `ledger` = an Ogmios epoch-state backend exists. */
function chainSyncClient(ledger = false) {
  let callbacks: ChainSyncCallbacks | undefined;
  const handle: ChainSyncHandle = { close: vi.fn().mockResolvedValue(undefined) };
  const openChainSync = vi.fn(async (_from: unknown, cbs: ChainSyncCallbacks) => {
    callbacks = cbs;
    return handle;
  });
  return {
    client: {
      getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: () => null,
      getEpochStateBackend: () => (ledger ? { epochStateAt: vi.fn() } : null),
      getRewardAccountStateBackend: () => (ledger ? ACCOUNT_BACKEND : null),
    },
    openChainSync,
    cbs: () => callbacks!,
  };
}

async function settle(pred: () => boolean, max = 200) {
  for (let i = 0; i < max && !pred(); i++) await Promise.resolve();
}

function makeCrawler(client: unknown, indexer: unknown, config: CrawlerConfig = CONFIG) {
  const crawler = new CardanoCrawler(client as never, indexer as never, 'preview', config);
  vi.spyOn(crawler as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);
  return crawler;
}

beforeEach(() => {
  dbRun.mockReset();
  snapshotAccounts.mockReset().mockResolvedValue({ taken: true, asked: 2, accounts: 1 });
  recordedEpochs = [];
  vi.restoreAllMocks();
  CardanoCrawler.resetPoisonMemory();
});

describe('CardanoCrawler — sums computed at the first start', () => {
  it('returns from start() before the sums are computed, and crawls once they are', async () => {
    defaultDb();
    const supply = await import('../../srv/blockchain/asset-supply');
    vi.mocked(supply.assetSupplyHeight).mockResolvedValueOnce(null);
    let finish: () => void = () => undefined;
    vi.mocked(supply.computeAssetSupply).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { indexer } = makeIndexer();
    const { client, openChainSync } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);

    await crawler.start(); // the served hook awaits this; it must not wait for the sums
    await settle(() => false, 50);
    expect(supply.computeAssetSupply).toHaveBeenCalledTimes(1);
    expect(openChainSync).not.toHaveBeenCalled();

    finish();
    await settle(() => openChainSync.mock.calls.length > 0);
    expect(openChainSync).toHaveBeenCalled();
    await crawler.stop();
  });
});

describe('CardanoCrawler — epoch snapshots', () => {
  it('snapshots once for the epoch and not again for its following blocks', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotEpoch.mock.calls.length > 0);
    await cbs().rollForward(block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 259_350 }), [], TIP_EPOCH_3);
    await settle(() => true);

    expect(snapshotEpoch).toHaveBeenCalledTimes(1);
    expect(snapshotEpoch).toHaveBeenCalledWith(3, { slot: 259_300, time: 1700000000, hash: null }, expect.any(Function));
    await crawler.stop();
  });

  it('a timed-out snapshot is told to stop, and no second one starts while it still runs', async () => {
    defaultDb();
    let finish: () => void = () => undefined;
    const snapshotEpoch = vi.fn(() => new Promise<{ pools: number; dreps: number }>((resolve) => { finish = () => resolve({ pools: 0, dreps: 0 }); }));
    const { indexer } = makeIndexer(snapshotEpoch as never);
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    const timeouts = CardanoCrawler as unknown as { SNAPSHOT_TIMEOUT_MS: number };
    const original = timeouts.SNAPSHOT_TIMEOUT_MS;
    Object.defineProperty(CardanoCrawler, 'SNAPSHOT_TIMEOUT_MS', { value: 20, configurable: true });
    try {
      await crawler.start();
      await settle(() => openChainSync.mock.calls.length > 0);
      await cbs().rollForward(block(), [], TIP_EPOCH_3);
      await settle(() => snapshotEpoch.mock.calls.length > 0);
      const shouldStop = (snapshotEpoch.mock.calls[0] as unknown as [number, unknown, () => boolean])[2];
      expect(shouldStop()).toBe(false);

      await new Promise((r) => setTimeout(r, 60));
      expect(shouldStop()).toBe(true);
      // the retry backoff is over, but the first attempt has not ended
      (crawler as unknown as { snapshotRetryAfter: number }).snapshotRetryAfter = 0;
      await cbs().rollForward(block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 259_350 }), [], TIP_EPOCH_3);
      await settle(() => true);
      expect(snapshotEpoch).toHaveBeenCalledTimes(1);
      finish();
    } finally {
      Object.defineProperty(CardanoCrawler, 'SNAPSHOT_TIMEOUT_MS', { value: original, configurable: true });
      await crawler.stop();
    }
  });

  it('a timed-out snapshot has its call signal aborted, and a work that never ends blocks only for the grace period', async () => {
    defaultDb();
    let signal: AbortSignal | undefined;
    const snapshotEpoch = vi.fn(() => { signal = callSignal(); return new Promise<{ pools: number; dreps: number }>(() => undefined); });
    const { indexer } = makeIndexer(snapshotEpoch as never);
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    const limits = CardanoCrawler as unknown as { SNAPSHOT_TIMEOUT_MS: number; SNAPSHOT_ABORT_GRACE_MS: number };
    const original = { timeout: limits.SNAPSHOT_TIMEOUT_MS, grace: limits.SNAPSHOT_ABORT_GRACE_MS };
    Object.defineProperty(CardanoCrawler, 'SNAPSHOT_TIMEOUT_MS', { value: 20, configurable: true });
    Object.defineProperty(CardanoCrawler, 'SNAPSHOT_ABORT_GRACE_MS', { value: 40, configurable: true });
    try {
      await crawler.start();
      await settle(() => openChainSync.mock.calls.length > 0);
      await cbs().rollForward(block(), [], TIP_EPOCH_3);
      await settle(() => snapshotEpoch.mock.calls.length > 0);
      expect(signal?.aborted).toBe(false);

      await new Promise((r) => setTimeout(r, 30));
      // the backend closes its ledger connection on this signal
      expect(signal?.aborted).toBe(true);

      await new Promise((r) => setTimeout(r, 60));
      (crawler as unknown as { snapshotRetryAfter: number }).snapshotRetryAfter = 0;
      await cbs().rollForward(block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 259_350 }), [], TIP_EPOCH_3);
      await settle(() => snapshotEpoch.mock.calls.length > 1);
      expect(snapshotEpoch).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(CardanoCrawler, 'SNAPSHOT_TIMEOUT_MS', { value: original.timeout, configurable: true });
      Object.defineProperty(CardanoCrawler, 'SNAPSHOT_ABORT_GRACE_MS', { value: original.grace, configurable: true });
      await crawler.stop();
    }
  });

  it('snapshots the next epoch when the boundary is crossed', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotEpoch.mock.calls.length > 0);
    const tipEpoch4: ChainPoint = { slot: 345_700, hash: 'tip4'.padEnd(64, '2'), height: 60 };
    await cbs().rollForward(
      block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 345_650, epoch: 4 }), [], tipEpoch4,
    );
    await settle(() => snapshotEpoch.mock.calls.length > 1);

    expect(snapshotEpoch.mock.calls.map(([epoch]) => epoch)).toEqual([3, 4]);
    await crawler.stop();
  });

  it('skips an epoch another run already recorded (restart mid-epoch)', async () => {
    recordedEpochs = [3];
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => true);

    expect(snapshotEpoch).not.toHaveBeenCalled();
    await crawler.stop();
  });

  it('does not run at all when epochSnapshots is off', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer, { ...CONFIG, epochSnapshots: false });
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => true);

    expect(snapshotEpoch).not.toHaveBeenCalled();
    // not even the "was it already recorded?" read
    expect(dbRun.mock.calls.some(([q]) => q.entity.endsWith('PoolEpochSnapshots'))).toBe(false);
    await crawler.stop();
  });

  it('keeps crawling when the snapshot fails, and retries it after the backoff', async () => {
    defaultDb();
    const snapshotEpoch = vi.fn()
      .mockRejectedValueOnce(new Error('koios down'))
      .mockResolvedValue({ pools: 2, dreps: 1 });
    const { indexer } = makeIndexer(snapshotEpoch);
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotEpoch.mock.calls.length > 0);
    // the block itself was persisted and the crawler is still alive
    expect(indexer.indexBlockFull).toHaveBeenCalledTimes(1);
    expect(crawler.isRunning()).toBe(true);

    // the very next block must NOT re-enumerate: an outage would otherwise cost a full
    // pool/DRep enumeration per block for the rest of the epoch
    await cbs().rollForward(block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 259_350 }), [], TIP_EPOCH_3);
    await settle(() => true);
    expect(snapshotEpoch).toHaveBeenCalledTimes(1);

    // once the backoff has elapsed the epoch is retried — the marker stays unset on failure
    const afterBackoff = Date.now() + 120_000;
    vi.spyOn(Date, 'now').mockReturnValue(afterBackoff);
    await cbs().rollForward(block({ hash: 'blk3'.padEnd(64, '1'), height: 43, slot: 259_400 }), [], TIP_EPOCH_3);
    await settle(() => snapshotEpoch.mock.calls.length > 1);

    expect(snapshotEpoch).toHaveBeenCalledTimes(2);
    await crawler.stop();
  });

  it('does not snapshot while the crawl is still backfilling — only at the tip', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    // block in epoch 3, tip already in epoch 9: Koios would answer with TODAY's pool set,
    // which stamped onto epoch 3 is a time series that is really a constant
    await cbs().rollForward(block(), [], TIP_EPOCH_9);
    await settle(() => true);

    expect(snapshotEpoch).not.toHaveBeenCalled();
    // not even the "was it already recorded?" read — the decision is made before the DB
    expect(dbRun.mock.calls.some(([q]) => q.entity.endsWith('PoolEpochSnapshots'))).toBe(false);

    // ...and once the crawl has caught up, the epoch at the tip is snapshotted
    await cbs().rollForward(
      block({ hash: 'blk9'.padEnd(64, '1'), height: 900, slot: 800_050, epoch: 9 }), [], TIP_EPOCH_9,
    );
    await settle(() => snapshotEpoch.mock.calls.length > 0);
    expect(snapshotEpoch.mock.calls.map(([epoch]) => epoch)).toEqual([9]);
    await crawler.stop();
  });

  it('does not snapshot when the block came without a reported tip', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], undefined);
    await settle(() => true);

    expect(snapshotEpoch).not.toHaveBeenCalled();
    await crawler.stop();
  });

  it('runs the snapshot outside the block transaction', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotEpoch.mock.calls.length > 0);

    // indexBlockFull got the block's transaction object; snapshotEpoch got no tx at all —
    // it opens its own, so a few thousand rows never inflate the atomic block write
    expect(indexer.indexBlockFull.mock.calls[0][0]).toBeDefined();
    // epoch, block and the stop check; no transaction
    expect(snapshotEpoch.mock.calls[0]).toHaveLength(3);
    expect(typeof snapshotEpoch.mock.calls[0][2]).toBe('function');
    await crawler.stop();
  });

  it('with Ogmios, snapshots a past epoch at the block while it is inside the volatile window', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient(true);
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    // block in epoch 3, tip in epoch 4 but only 100 blocks ahead (preview k = 432)
    const tip: ChainPoint = { slot: 345_700, hash: 'tip4'.padEnd(64, '2'), height: 141 };
    await cbs().rollForward(block(), [], tip);
    await settle(() => snapshotEpoch.mock.calls.length > 0);

    expect(snapshotEpoch).toHaveBeenCalledWith(3, { slot: 259_300, time: 1700000000, hash: 'blk'.padEnd(64, '1') }, expect.any(Function));
    await crawler.stop();
  });

  it('with Ogmios, skips a block that is too far behind the tip to acquire', async () => {
    defaultDb();
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient(true);
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    // 425 blocks behind: inside k = 432, but not by the safety margin
    await cbs().rollForward(block(), [], { slot: 345_700, hash: 'tip'.padEnd(64, '2'), height: 466 });
    await settle(() => true);
    expect(snapshotEpoch).not.toHaveBeenCalled();

    // a later block of the same epoch closer to the tip still gets the snapshot
    await cbs().rollForward(
      block({ hash: 'blk2'.padEnd(64, '1'), height: 400, slot: 300_000 }), [], { slot: 345_700, hash: 'tip'.padEnd(64, '2'), height: 466 },
    );
    await settle(() => snapshotEpoch.mock.calls.length > 0);
    expect(snapshotEpoch).toHaveBeenCalledWith(3, { slot: 300_000, time: 1700000000, hash: 'blk2'.padEnd(64, '1') }, expect.any(Function));
    await crawler.stop();
  });

  it('skips an epoch that already has its marker row', async () => {
    defaultDb();
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR_ROW };
      if (q._op === 'SELECT.one' && q.entity.endsWith('EpochLedgerSnapshots')) return { epoch: 3 };
      return undefined;
    });
    const { indexer, snapshotEpoch } = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient(true);
    const crawler = makeCrawler(client, indexer);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => true);

    expect(snapshotEpoch).not.toHaveBeenCalled();
    await crawler.stop();
  });
});

describe('CardanoCrawler — account snapshots', () => {
  const WITH_ACCOUNTS: CrawlerConfig = { ...CONFIG, accountSnapshots: true, certificates: true };

  async function crossEpoch(config: CrawlerConfig, ledger: boolean) {
    const made = makeIndexer();
    const { client, openChainSync, cbs } = chainSyncClient(ledger);
    const crawler = makeCrawler(client, made.indexer, config);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);
    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotAccounts.mock.calls.length > 0);
    return { crawler, snapshotEpoch: made.snapshotEpoch };
  }

  it('follows the pool snapshot, at the same block, with the node as source', async () => {
    defaultDb();
    const { crawler, snapshotEpoch } = await crossEpoch(WITH_ACCOUNTS, true);

    expect(snapshotEpoch).toHaveBeenCalledTimes(1);
    expect(snapshotAccounts).toHaveBeenCalledTimes(1);
    expect(snapshotAccounts.mock.calls[0][0]).toMatchObject({
      backend: ACCOUNT_BACKEND, epoch: 3, at: { slot: 259_300, hash: 'blk'.padEnd(64, '1') }, withdrawals: true,
    });
    // the walk ends with the crawler
    const { shouldStop } = snapshotAccounts.mock.calls[0][0] as { shouldStop: () => boolean };
    expect(shouldStop()).toBe(false);
    await crawler.stop();
    expect(shouldStop()).toBe(true);
  });

  it('tells the walk that withdrawals are not crawled', async () => {
    defaultDb();
    const { crawler } = await crossEpoch({ ...WITH_ACCOUNTS, certificates: false }, true);
    expect(snapshotAccounts.mock.calls[0][0]).toMatchObject({ withdrawals: false });
    await crawler.stop();
  });

  it('is taken for an epoch whose pool snapshot another run recorded', async () => {
    defaultDb();
    recordedEpochs = [3];
    const { crawler, snapshotEpoch } = await crossEpoch(WITH_ACCOUNTS, true);
    expect(snapshotEpoch).not.toHaveBeenCalled();
    expect(snapshotAccounts).toHaveBeenCalledTimes(1);
    await crawler.stop();
  });

  it('is off unless configured, and skipped without a backend that reads the ledger at a block', async () => {
    defaultDb();
    const off = await crossEpoch(CONFIG, true);
    await off.crawler.stop();
    const provider = await crossEpoch(WITH_ACCOUNTS, false);
    await provider.crawler.stop();
    expect(snapshotAccounts).not.toHaveBeenCalled();
  });

  it('is tried again after a failure, without repeating the pool snapshot', async () => {
    defaultDb();
    snapshotAccounts.mockReset().mockRejectedValueOnce(new Error('node gone')).mockResolvedValue({ taken: true, asked: 1, accounts: 1 });
    const { indexer, snapshotEpoch } = makeIndexer();
    // the pool snapshot of the first attempt is on record for the second
    snapshotEpoch.mockImplementation(async () => { recordedEpochs = [3]; return { pools: 2, dreps: 1 }; });
    const { client, openChainSync, cbs } = chainSyncClient(true);
    const crawler = makeCrawler(client, indexer, WITH_ACCOUNTS);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], TIP_EPOCH_3);
    await settle(() => snapshotAccounts.mock.calls.length > 0);
    // let the failed attempt end and set its backoff, then step past it
    await settle(() => false, 20);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    await cbs().rollForward(block({ hash: 'blk2'.padEnd(64, '1'), height: 42, slot: 259_350 }), [], TIP_EPOCH_3);
    await settle(() => snapshotAccounts.mock.calls.length > 1);

    expect(snapshotEpoch).toHaveBeenCalledTimes(1);
    expect(snapshotAccounts).toHaveBeenCalledTimes(2);
    expect(snapshotAccounts.mock.calls[1][0]).toMatchObject({ at: { slot: 259_350 } });
    await crawler.stop();
  });
});
