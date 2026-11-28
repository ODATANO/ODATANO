/**
 * Chain crawler — engine reorg handling, source semantics and intersection points.
 * Mocks the @sap/cds CQL + tx layer and drives CardanoCrawler.handleReorg directly:
 * slot-axis block cut, blockHash-join transaction delete, cursor reset, ReorgLog audit.
 */

type Q = { _op: string; entity: string; where?: unknown; set?: unknown; entries?: unknown };
// vi.mock factories are hoisted above all statements — anything they capture
// must be hoisted too.
const { dbRun, fakeDb, dropAccountSnapshotsAfter } = vi.hoisted(() => {
  const dbRun = vi.fn<(q: Q) => Promise<unknown>>();
  return { dbRun, fakeDb: { run: dbRun }, dropAccountSnapshotsAfter: vi.fn(async () => undefined) };
});

// its own suite runs it on a real database
vi.mock('../../srv/blockchain/crawler/account-snapshots', () => ({ snapshotAccounts: vi.fn(), dropAccountSnapshotsAfter }));

vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  utils: { uuid: () => 'reorg-uuid' },
  tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ql: {
    SELECT: {
      one: {
        from: (entity: string) => ({
          where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }),
          columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }) }),
        }),
      },
      from: (entity: string) => ({
        columns: () => ({
          where: (where: unknown) => {
            const q = { _op: 'SELECT.many', entity, where };
            return { ...q, limit: (limit: number) => ({ ...q, limit }) };
          },
        }),
        where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
      }),
      distinct: {
        from: (entity: string) => ({ columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.distinct', entity, where }) }) }),
      },
    },
    DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
    INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
    UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: () => ({ _op: 'UPDATE', entity, set }) }) }) },
  },
};
  return { default: cdsMock, ...cdsMock };
});

// The typed entity proxies need the real cds runtime — stub them with plain names.
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
  TransactionRedeemers: 'odatano.cardano.TransactionRedeemers',
  TransactionDatums: 'odatano.cardano.TransactionDatums',
  LedgerUTxOs: 'odatano.cardano.LedgerUTxOs', LedgerUTxOAssets: 'odatano.cardano.LedgerUTxOAssets',
  LedgerAddresses: 'odatano.cardano.LedgerAddresses', LedgerAddressAssets: 'odatano.cardano.LedgerAddressAssets',
  LedgerAccounts: 'odatano.cardano.LedgerAccounts',
}));

import { CardanoCrawler, type CrawlerConfig } from '../../srv/blockchain/crawler/crawler';

const CONFIG: CrawlerConfig = {
  enabled: true, startSlot: 0, startBlockHash: 'genesis', source: 'auto',
  batchSize: 20, confirmationDepth: 3, pollIntervalMs: 20000,
  assetHistory: true, assetCatalogue: 'bare', assetEnrichRate: 2, epochSnapshots: false, certificates: false, utxoSet: false,
};

// Only the methods the engine paths touch: teardown stops the asset-enrichment loop,
// start()/persist would need the rest.
const stubIndexer = () => ({
  indexBlockFull: vi.fn(), prefetchCrawlEpoch: vi.fn(),
  configureCrawlCoverage: vi.fn(), stopAssetEnrichment: vi.fn(), snapshotEpoch: vi.fn(),
  setUtxoAnchor: vi.fn(), getUtxoAnchor: vi.fn(() => null), takeLedgerInvalidation: vi.fn(() => null), confirmBlockCommit: vi.fn(),
  reconcileRolledBackAssets: vi.fn(async () => undefined), forgetCrawlEpochs: vi.fn(),
});

const makeCrawler = (config: CrawlerConfig = CONFIG, client: unknown = {}) =>
  new CardanoCrawler(client as never, stubIndexer() as never, 'preview', config);

const opsFor = (op: string) => dbRun.mock.calls.map(c => c[0]).filter(q => q._op === op);
const shortName = (entity: string) => entity.split('.').pop();

describe('CardanoCrawler.handleReorg', () => {
  beforeEach(() => { dbRun.mockReset(); });

  it('cuts blocks on the slot axis, deletes only their txs via blockHash join, resets the cursor and logs the reorg', async () => {
    dbRun.mockImplementation(async (q) => {
      // blocks after the fork (slot axis)
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [{ hash: 'b1' }, { hash: 'b2' }];
      // txs belonging to those blocks only
      if (q._op === 'SELECT.many' && q.entity.endsWith('Transactions')) return [{ hash: 't1', txSeq: '11' }, { hash: 't2', txSeq: '12' }];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'forkhash', height: 5 });

    // block selection ran on the absolute-slot axis (never a height fallback)
    const blockSelect = opsFor('SELECT.many').find(q => q.entity.endsWith('Blocks'));
    expect(blockSelect!.where).toEqual({ slot: { '>': 500 } });

    // tx selection is confined to the rolled-back blocks' hashes
    const txSelect = opsFor('SELECT.many').find(q => q.entity.endsWith('Transactions'));
    expect(txSelect!.where).toEqual({ blockHash: { in: ['b1', 'b2'] } });

    const deletes = opsFor('DELETE').map(q => shortName(q.entity));
    expect(deletes).toEqual(expect.arrayContaining([
      'TransactionInputAssetCopies', 'TransactionOutputAssets',
      'TransactionInputs', 'TransactionOutputs', 'TransactionMetadata',
      'AddressTransactions', 'AddressUTxOs', 'UTxOAssets', 'AssetHistory',
      'TransactionCertificates', 'TransactionWithdrawals',
      'Transactions', 'Blocks',
    ]));

    // input/output rows deleted by the resolved txSeq set, the rest by tx hash; blocks by hash
    const childDelete = opsFor('DELETE').find(q => q.entity.endsWith('TransactionInputs'));
    expect(childDelete!.where).toEqual({ txSeq: { in: ['11', '12'] } });
    const assetDelete = opsFor('DELETE').find(q => q.entity.endsWith('TransactionOutputAssets'));
    expect(assetDelete!.where).toEqual({ output_txSeq: { in: ['11', '12'] } });
    const metaDelete = opsFor('DELETE').find(q => q.entity.endsWith('TransactionMetadata'));
    expect(metaDelete!.where).toEqual({ tx_hash: { in: ['t1', 't2'] } });
    const txDelete = opsFor('DELETE').find(q => q.entity.endsWith('.Transactions'));
    expect(txDelete!.where).toEqual({ hash: { in: ['t1', 't2'] } });
    const blockDelete = opsFor('DELETE').find(q => q.entity.endsWith('Blocks'));
    expect(blockDelete!.where).toEqual({ hash: { in: ['b1', 'b2'] } });
    // snapshots taken at a rolled-back block go with it
    for (const name of ['PoolEpochSnapshots', 'DrepEpochSnapshots', 'EpochLedgerSnapshots']) {
      const snapDelete = opsFor('DELETE').find(q => q.entity.endsWith(name));
      expect(snapDelete!.where).toEqual({ snapshotSlot: { '>': 500 } });
    }
    expect(dropAccountSnapshotsAfter).toHaveBeenCalledWith(fakeDb, 500);

    // cursor rewound to the fork
    const update = opsFor('UPDATE')[0];
    expect((update.set as Record<string, unknown>).lastBlockHash).toBe('forkhash');

    // audit row counts BLOCKS (not txs)
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect(reorg!.entries).toMatchObject({
      forkSlot: 500, forkHeight: 5, newTipHash: 'forkhash',
      blocksRolledBack: 2, status: 'completed',
    });
  });

  it('rechecks the catalogue for the units of the rolled-back outputs and forgets the cached epochs', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [{ hash: 'b1' }];
      if (q._op === 'SELECT.many' && q.entity.endsWith('Transactions')) return [{ hash: 't1', txSeq: '11' }];
      if (q._op === 'SELECT.distinct' && q.entity.endsWith('TransactionOutputAssets')) return [{ unit: 'u1' }, { unit: 'u2' }];
      return undefined;
    });
    const indexer = stubIndexer();
    const crawler = new CardanoCrawler({} as never, indexer as never, 'preview', CONFIG);

    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> }).handleReorg({ slot: 500, hash: 'forkhash', height: 5 });

    expect(opsFor('SELECT.distinct')[0].where).toEqual({ output_txSeq: { in: ['11'] } });
    expect(indexer.reconcileRolledBackAssets).toHaveBeenCalledWith(fakeDb, ['u1', 'u2'], 500);
    expect(indexer.forgetCrawlEpochs).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing but still resets the cursor and logs when no blocks are after the fork', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'forkhash', height: 5 });

    expect(opsFor('DELETE')).toHaveLength(0);
    expect(opsFor('UPDATE')).toHaveLength(1);
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect((reorg!.entries as Record<string, unknown>).blocksRolledBack).toBe(0);
  });

  it('never widens the delete when the fork height is unresolvable (no height-0 fallback)', async () => {
    dbRun.mockImplementation(async (q) => {
      // fork block unknown locally → SELECT.one returns undefined
      if (q._op === 'SELECT.one') return undefined;
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [{ hash: 'b9' }];
      if (q._op === 'SELECT.many' && q.entity.endsWith('Transactions')) return [];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'unknownfork' }); // no height on the point

    // the cut stays on the slot axis and explicit hashes — no height-based delete exists
    const blockDelete = opsFor('DELETE').find(q => q.entity.endsWith('Blocks'));
    expect(blockDelete!.where).toEqual({ hash: { in: ['b9'] } });
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect((reorg!.entries as Record<string, unknown>).forkHeight).toBeNull();
  });
});

describe('CardanoCrawler rollBackward: a node behind the cursor deletes nothing', () => {
  beforeEach(() => { dbRun.mockReset(); });

  type Callbacks = { rollBackward: (p: unknown, tip?: unknown) => Promise<void> };
  const CURSOR = { ID: 'SINGLETON', network: 'preview', lastSlot: 50_000, lastBlockHash: 'c'.repeat(64), lastHeight: 2_000, desiredRunning: true };

  // A crawler with an open stream; returns the stream's callbacks and its handle.
  async function openStream(blocksAfterPoint: number, pointStored = true, pointHeight: number | null = null) {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR };
      if (q._op === 'SELECT.one' && q.entity.endsWith('Blocks')) return pointStored ? { hash: 'f'.repeat(64), height: pointHeight } : undefined;
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) {
        const rows = Array.from({ length: blocksAfterPoint }, (_, i) => ({ hash: `b${i}`, height: 2_000 - i, slot: 50_000 - i }));
        return typeof (q as { limit?: number }).limit === 'number' ? rows.slice(0, (q as { limit?: number }).limit) : rows;
      }
      if ((q._op === 'SELECT.many' || q._op === 'SELECT.distinct') && q.entity.endsWith('Transactions')) return [];
      return undefined;
    });
    let callbacks: Callbacks | null = null;
    const handle = { close: vi.fn(async () => undefined) };
    const backend = { openChainSync: vi.fn(async (_points: unknown, cb: Callbacks) => { callbacks = cb; return handle; }) };
    const crawler = makeCrawler();
    (crawler as unknown as { running: boolean }).running = true;
    await (crawler as unknown as { runChainSync: (b: unknown) => Promise<void> }).runChainSync(backend);
    return { crawler, callbacks: callbacks!, handle };
  }
  const deletes = () => opsFor('DELETE');
  const nodeBehindWrite = () => opsFor('UPDATE').find(q => (q.set as Record<string, unknown>)?.nodeBehindSince !== undefined);
  const errorWrite = () => opsFor('UPDATE').find(q => (q.set as Record<string, unknown>)?.syncStatus === 'error');
  const refused = (crawler: unknown) => (crawler as { streamRefused: boolean }).streamRefused;

  it('refuses a rollback when the node tip is below the cursor', async () => {
    const { crawler, callbacks, handle } = await openStream(3);
    await callbacks.rollBackward({ slot: 49_000, hash: 'f'.repeat(64) }, { slot: 49_500, hash: 'e'.repeat(64), height: 1_990 });

    expect(deletes()).toHaveLength(0);
    expect(nodeBehindWrite()).toBeDefined();
    expect(String((nodeBehindWrite()!.set as Record<string, unknown>).lastError)).toContain('behind the cursor');
    expect(handle.close).toHaveBeenCalled();
    expect(refused(crawler)).toBe(true);
    // waiting for a node is no error
    expect(errorWrite()).toBeUndefined();
  });

  it('refuses a rollback deeper than k blocks (preview k = 432) as an error, not as a node behind', async () => {
    const { crawler, callbacks } = await openStream(500);
    await callbacks.rollBackward({ slot: 40_000, hash: 'f'.repeat(64) }, { slot: 51_000, hash: 'e'.repeat(64), height: 2_010 });

    expect(deletes()).toHaveLength(0);
    expect(nodeBehindWrite()).toBeUndefined();
    expect(String((errorWrite()!.set as Record<string, unknown>).lastError)).toContain('more than k=432');
    expect(refused(crawler)).toBe(true);
  });

  it('counts the depth from the cursor height, so a fork exactly k deep still rolls back', async () => {
    // 500 stored blocks after the point include lazily stored tip blocks; the crawled depth is 432
    const { callbacks } = await openStream(500, true, 2_000 - 432);
    await callbacks.rollBackward({ slot: 40_000, hash: 'f'.repeat(64) }, { slot: 51_000, hash: 'e'.repeat(64), height: 2_010 });

    expect(deletes().filter(q => q.entity.endsWith('Blocks'))).toHaveLength(1);
    expect(errorWrite()).toBeUndefined();
  });

  it('refuses a rollback to a point that is not a stored block, and one to genesis, as errors', async () => {
    const first = await openStream(2, false);
    await first.callbacks.rollBackward({ slot: 49_990, hash: 'f'.repeat(64) }, undefined);
    expect(deletes()).toHaveLength(0);
    expect(String((errorWrite()!.set as Record<string, unknown>).lastError)).toContain('not a stored block');

    const second = await openStream(2);
    await second.callbacks.rollBackward('origin', undefined);
    expect(deletes()).toHaveLength(0);
  });

  it('halts with an error after repeated contradicting rollbacks', async () => {
    const { crawler, callbacks } = await openStream(2, false);
    for (let i = 0; i < 5; i++) {
      (crawler as unknown as { running: boolean }).running = true;
      await callbacks.rollBackward({ slot: 49_990, hash: 'f'.repeat(64) }, undefined);
    }
    expect(deletes()).toHaveLength(0);
    expect((crawler as unknown as { running: boolean }).running).toBe(false);
    expect((crawler as unknown as { latchOnHalt: boolean }).latchOnHalt).toBe(true);
  });

  it('still rolls back a real fork of 3 blocks', async () => {
    const { crawler, callbacks } = await openStream(3);
    await callbacks.rollBackward({ slot: 49_997, hash: 'f'.repeat(64) }, { slot: 50_010, hash: 'e'.repeat(64), height: 2_001 });

    expect(deletes().filter(q => q.entity.endsWith('Blocks'))).toHaveLength(1);
    expect(nodeBehindWrite()).toBeUndefined();
    expect(refused(crawler)).toBe(false);
  });
});

describe('CardanoCrawler.persistBlock: the node-behind mark', () => {
  beforeEach(() => { dbRun.mockReset(); dbRun.mockResolvedValue(1); });
  const blk = { hash: 'h'.repeat(64), height: 10, slot: 100, time: 1, epoch: 0, txCount: 0 };
  const cursorWrite = () => opsFor('UPDATE').find(q => q.entity.endsWith('CardanoSyncState') && (q.set as Record<string, unknown>)?.lastBlockHash === blk.hash);

  it('is cleared by a block from chain-sync and kept by a block from pagination', async () => {
    const crawler = makeCrawler();
    (crawler as unknown as { running: boolean }).running = true;
    const persist = (crawler as unknown as { persistBlock: (b: unknown, t: unknown[], tip: unknown, fromChainSync?: boolean) => Promise<boolean> }).persistBlock.bind(crawler);

    await persist(blk, [], { slot: 100, hash: 'h'.repeat(64), height: 10 }, false);
    expect(cursorWrite()!.set).not.toHaveProperty('nodeBehindSince');

    dbRun.mockClear();
    await persist(blk, [], { slot: 100, hash: 'h'.repeat(64), height: 10 }, true);
    expect(cursorWrite()!.set).toMatchObject({ nodeBehindSince: null });
  });
});

describe('CardanoCrawler parent check across a Byron epoch boundary', () => {
  const follows = (network: string, slot: number, parentSlot: number) =>
    (new CardanoCrawler({} as never, stubIndexer() as never, network, CONFIG) as unknown as { followsByronBoundary: (b: unknown, p: number) => boolean })
      .followsByronBoundary({ slot, hash: 'x' }, parentSlot);

  it('lets the first block of a Byron epoch name the unstored boundary block as its parent', () => {
    // mainnet Byron epochs are 21600 slots long
    expect(follows('mainnet', 21_600, 21_599)).toBe(true);
    expect(follows('mainnet', 21_610, 21_590)).toBe(true);
  });

  it('checks every other parent, inside a Byron epoch and from Shelley on', () => {
    expect(follows('mainnet', 21_620, 21_610)).toBe(false);
    expect(follows('mainnet', 4_492_800 + 432_000, 4_492_799 + 432_000)).toBe(false);
    expect(follows('preview', 86_400, 86_399)).toBe(false);
  });
});

describe('CardanoCrawler source semantics', () => {
  beforeEach(() => { dbRun.mockReset(); });

  it("source 'ogmios' does NOT fall back to pagination when no chain-sync backend exists", async () => {
    dbRun.mockResolvedValue(undefined);
    const client = {
      getChainSyncBackend: () => null,
      getPaginatingBackend: vi.fn(() => { throw new Error('pagination must not be reached'); }),
    };
    const crawler = makeCrawler({ ...CONFIG, source: 'ogmios' }, client);
    // in the real flow start() flips this before launching the pipeline
    (crawler as unknown as { running: boolean }).running = true;

    await (crawler as unknown as { runIngestPipeline: () => Promise<void> }).runIngestPipeline();

    expect(client.getPaginatingBackend).not.toHaveBeenCalled();
    // stop('error') recorded the terminal status on the cursor
    const statusUpdate = opsFor('UPDATE').find(q => (q.set as Record<string, unknown>)?.syncStatus === 'error');
    expect(statusUpdate).toBeDefined();
  });
});

describe('CardanoCrawler intersection points (reorg across a restart)', () => {
  beforeEach(() => { dbRun.mockReset(); });

  const cursor = { lastSlot: 5_000, lastBlockHash: 'c'.repeat(64), lastHeight: 1_000 };
  /** Our own crawled ancestors, as the ladder query would find them. */
  const ancestors = [
    { height: 999, slot: 4_980, hash: 'a'.repeat(64) },
    { height: 998, slot: 4_960, hash: 'b'.repeat(64) },
    { height: 995, slot: 4_800, hash: 'd'.repeat(64) },
  ];

  const build = (config: CrawlerConfig = CONFIG) =>
    (makeCrawler(config) as unknown as {
      buildIntersectionPoints: (c: unknown) => Promise<Array<{ slot: number; hash: string; height?: number }>>;
    }).buildIntersectionPoints(cursor);

  it('offers the cursor first, then our own ancestors newest-first', async () => {
    dbRun.mockImplementation(async (q) => (q._op === 'SELECT.many' ? [...ancestors].reverse() : undefined));

    const points = await build();

    expect(points[0]).toEqual({ slot: 5_000, hash: 'c'.repeat(64), height: 1_000 });
    expect(points.slice(1, 4).map(p => p.height)).toEqual([999, 998, 995]);
    // A single point makes Ogmios answer "No intersection found" when the cursor
    // block was orphaned while the crawler was down.
    expect(points.length).toBeGreaterThan(1);
  });

  it('queries an exponentially spaced ladder rather than every height', async () => {
    dbRun.mockImplementation(async (q) => (q._op === 'SELECT.many' ? [] : undefined));

    await build();

    const query = opsFor('SELECT.many').find(q => shortName(q.entity) === 'Blocks');
    const heights = (query?.where as { height: { in: number[] } }).height.in;
    // Dense over the last 10 blocks so an ordinary shallow rollback intersects
    // EXACTLY, then doubling for reach.
    expect(heights.slice(0, 10)).toEqual([999, 998, 997, 996, 995, 994, 993, 992, 991, 990]);
    expect(heights.slice(10, 13)).toEqual([984, 968, 936]);          // -16,-32,-64
    // never deeper than k (preview: 432), so a point below that is never a rollback target
    expect(Math.min(...heights)).toBe(1_000 - 432);
    expect(Math.min(...heights)).toBeGreaterThan(0);                 // never below genesis
    expect(new Set(heights).size).toBe(heights.length);              // no duplicates
  });

  it('keeps the configured start block as the deepest anchor, without duplicates', async () => {
    dbRun.mockImplementation(async (q) => (q._op === 'SELECT.many' ? [ancestors[0]] : undefined));

    const points = await build({ ...CONFIG, startSlot: 100, startBlockHash: 'start-hash' });

    expect(points[points.length - 1]).toMatchObject({ slot: 100, hash: 'start-hash' });
    expect(new Set(points.map(p => p.hash)).size).toBe(points.length);
  });

  it('falls back to the configured start block when there is no cursor yet', async () => {
    dbRun.mockResolvedValue(undefined);
    const crawler = makeCrawler({ ...CONFIG, startSlot: 42, startBlockHash: 'start-hash' });

    const points = await (crawler as unknown as {
      buildIntersectionPoints: (c: unknown) => Promise<Array<{ slot: number; hash: string }>>;
    }).buildIntersectionPoints(null);

    expect(points).toEqual([{ slot: 42, hash: 'start-hash', height: undefined }]);
  });
});

describe('CardanoCrawler.isRunning', () => {
  it('is false before start', () => {
    expect(makeCrawler().isRunning()).toBe(false);
  });
});
