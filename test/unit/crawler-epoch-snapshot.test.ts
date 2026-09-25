/**
 * Chain crawler — pool/DRep snapshots at epoch boundaries (analytics coverage).
 * Drives persistBlock through the chain-sync callback and asserts that the
 * snapshot runs ONCE per epoch, ONLY at the tip, outside the block transaction, never fails
 * the crawl, and respects a snapshot another run already recorded. cds + entity proxies
 * mocked in the repo's style (see crawler-lifecycle.test.ts).
 *
 * Network is 'preview' throughout: 86 400 slots per epoch anchored at slot 0, so epoch 3 is
 * slots 259 200..345 599 and epoch 4 starts at 345 600. Block and tip slots below are chosen
 * to be consistent with that geometry — the tip guard derives the tip's epoch from its slot.
 */

type Q = { _op: string; entity: string; where?: unknown; set?: unknown; entries?: unknown };
const { dbRun, fakeDb } = vi.hoisted(() => {
  const dbRun = vi.fn<(q: Q) => Promise<unknown>>();
  return { dbRun, fakeDb: { run: dbRun } };
});

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

vi.mock('#cds-models/odatano/cardano', () => ({
  Blocks: 'odatano.cardano.Blocks',
  Transactions: 'odatano.cardano.Transactions',
  TransactionInputs: 'odatano.cardano.TransactionInputs',
  TransactionInputAssets: 'odatano.cardano.TransactionInputAssets',
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
  TransactionCertificates: 'odatano.cardano.TransactionCertificates',
  TransactionWithdrawals: 'odatano.cardano.TransactionWithdrawals',
}));

import { CardanoCrawler, type CrawlerConfig } from '../../srv/blockchain/crawler/crawler';
import type { ChainPoint, ChainSyncCallbacks, ChainSyncHandle } from '../../srv/blockchain/backends/cardano-backend';
import type { BlockData } from '../../srv/utils/types';

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
      setUtxoAnchor: vi.fn(), getUtxoAnchor: vi.fn(() => null), takeLedgerInvalidation: vi.fn(() => null),
      prefetchCrawlEpoch: vi.fn(),
      configureCrawlCoverage: vi.fn(),
      stopAssetEnrichment: vi.fn(),
      snapshotEpoch,
    },
    snapshotEpoch,
  };
}

/** Chain-sync client whose callbacks the test drives by hand. */
function chainSyncClient() {
  let callbacks: ChainSyncCallbacks | undefined;
  const handle: ChainSyncHandle = { close: vi.fn().mockResolvedValue(undefined) };
  const openChainSync = vi.fn(async (_from: unknown, cbs: ChainSyncCallbacks) => {
    callbacks = cbs;
    return handle;
  });
  return {
    client: { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: () => null },
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
  recordedEpochs = [];
  vi.restoreAllMocks();
  CardanoCrawler.resetPoisonMemory();
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
    expect(snapshotEpoch).toHaveBeenCalledWith(3, { slot: 259_300, time: 1700000000 });
    await crawler.stop();
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
    expect(snapshotEpoch.mock.calls[0]).toHaveLength(2);
    await crawler.stop();
  });
});
