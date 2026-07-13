/**
 * CardanoCrawler lifecycle (C4/C7): start refusal, chain-sync wiring (persist, tip →
 * synced, stop race, onError), pagination loop (synced detection, batch persist,
 * error streak), persistBlock bounded retries, tryReorgRecovery fork search, and the
 * crawler/index.ts singleton. cds + entity proxies mocked in the repo's style.
 */

type Q = { _op: string; entity: string; where?: unknown; set?: unknown; entries?: unknown };
const dbRun = jest.fn<Promise<unknown>, [Q]>();
const fakeDb = { run: dbRun };

jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  utils: { uuid: () => 'uuid' },
  tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ql: {
    SELECT: {
      one: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }) }) },
      from: (entity: string) => ({
        columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }) }),
        where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
      }),
    },
    DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
    INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
    UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: () => ({ _op: 'UPDATE', entity, set }) }) }) },
  },
}));

jest.mock('#cds-models/odatano/cardano', () => ({
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
}));

import { CardanoCrawler, type CrawlerConfig } from '../../srv/blockchain/crawler/crawler';
import { startCrawler, stopCrawler, isCrawlerRunning, getCrawler } from '../../srv/blockchain/crawler';
import type { ChainSyncCallbacks, ChainSyncHandle } from '../../srv/blockchain/backends/cardano-backend';
import type { BlockData } from '../../srv/utils/types';

const CONFIG: CrawlerConfig = {
  enabled: true, startSlot: 1000, startBlockHash: 'start'.padEnd(64, '0'), startHeight: 10,
  source: 'auto', batchSize: 5, confirmationDepth: 3, pollIntervalMs: 10,
};

const CURSOR_ROW = {
  ID: 'SINGLETON', lastSlot: '4000', lastBlockHash: 'cursor'.padEnd(64, '0'), lastHeight: '40',
  network: 'preview', syncStatus: 'syncing', consecutiveErrors: '0', desiredRunning: true,
  leaseOwner: null, leaseUntil: null,
};

const block = (over: Partial<BlockData> = {}): BlockData => ({
  time: 1700000000, height: 41, hash: 'blk'.padEnd(64, '1'), slot: 4100, slotLeader: '',
  epoch: 3, epochSlot: 100, size: 100, txCount: 0, fees: '0', ...over,
});

const opsFor = (op: string) => dbRun.mock.calls.map(c => c[0]).filter(q => q._op === op);
const updatesWith = (pred: (set: Record<string, unknown>) => boolean) =>
  opsFor('UPDATE').filter(q => pred(q.set as Record<string, unknown>));

/** Default db behavior: the cursor row exists. */
function cursorExists() {
  const state: Record<string, unknown> = { ...CURSOR_ROW };
  dbRun.mockImplementation(async (q) => {
    if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...state };
    if (q._op === 'UPDATE' && q.entity.endsWith('CardanoSyncState')) {
      Object.assign(state, q.set as Record<string, unknown>);
      return 1;
    }
    return undefined;
  });
}

function makeCrawler(client: unknown, config: CrawlerConfig = CONFIG, indexer: unknown = { indexBlockFull: jest.fn(), prefetchCrawlEpoch: jest.fn() }) {
  const crawler = new CardanoCrawler(client as never, indexer as never, 'preview', config);
  // collapse retry/poll sleeps so loops run instantly
  jest.spyOn(crawler as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);
  return crawler;
}

/** Await until the fire-and-forget pipeline settles (bounded spin). */
async function settle(pred: () => boolean, max = 200) {
  for (let i = 0; i < max && !pred(); i++) await Promise.resolve();
}

beforeEach(() => {
  dbRun.mockReset();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// start() guardrails
// ---------------------------------------------------------------------------

describe('CardanoCrawler.start', () => {
  it('keeps running=false when the initial cursor read fails', async () => {
    dbRun.mockRejectedValueOnce(new Error('database unavailable'));
    const crawler = makeCrawler({ getChainSyncBackend: jest.fn(), getPaginatingBackend: jest.fn() });

    await expect(crawler.start()).rejects.toThrow('database unavailable');
    expect(crawler.isRunning()).toBe(false);
  });

  it('rejects a persisted cursor from another Cardano network', async () => {
    dbRun.mockResolvedValueOnce({ ...CURSOR_ROW, network: 'mainnet' });
    const crawler = makeCrawler({ getChainSyncBackend: jest.fn(), getPaginatingBackend: jest.fn() });

    await expect(crawler.start()).rejects.toThrow(/network mismatch/i);
    expect(crawler.isRunning()).toBe(false);
  });

  it('refuses to start without a configured start block AND without an existing cursor', async () => {
    dbRun.mockImplementation(async (q) => {
      // fresh DB: ensureSyncStateSingleton finds nothing, INSERTs a row without lastBlockHash
      if (q._op === 'SELECT.one') return undefined;
      return undefined;
    });
    const client = { getChainSyncBackend: jest.fn(), getPaginatingBackend: jest.fn() };
    const crawler = makeCrawler(client, { ...CONFIG, startSlot: undefined, startBlockHash: undefined });

    await crawler.start();

    expect(crawler.isRunning()).toBe(false);
    expect(client.getChainSyncBackend).not.toHaveBeenCalled(); // pipeline never launched
  });

  it('is idempotent while running', async () => {
    cursorExists();
    const openChainSync = jest.fn(async (): Promise<ChainSyncHandle> => ({ close: jest.fn() }));
    const client = { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() };
    const crawler = makeCrawler(client);

    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);
    await crawler.start(); // no second pipeline

    expect(openChainSync).toHaveBeenCalledTimes(1);
    await crawler.stop();
  });
});

// ---------------------------------------------------------------------------
// chain-sync path
// ---------------------------------------------------------------------------

describe('CardanoCrawler chain-sync path', () => {
  function chainSyncClient() {
    let callbacks: ChainSyncCallbacks | undefined;
    const close = jest.fn();
    const openChainSync = jest.fn(async (_from: unknown, cbs: ChainSyncCallbacks): Promise<ChainSyncHandle> => {
      callbacks = cbs;
      return { close };
    });
    return { client: { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() }, openChainSync, close, cbs: () => callbacks! };
  }

  it('resumes from the persisted cursor (not the configured start block)', async () => {
    cursorExists();
    const { client, openChainSync } = chainSyncClient();
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    expect(openChainSync.mock.calls[0][0]).toEqual({ slot: 4000, hash: CURSOR_ROW.lastBlockHash, height: 40 });
    await crawler.stop();
  });

  it('rollForward persists the block via indexBlockFull and advances the cursor with the tip', async () => {
    cursorExists();
    const indexBlockFull = jest.fn();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block(), [], { slot: 9000, hash: 'tip'.padEnd(64, '2'), height: 90 });

    expect(indexBlockFull).toHaveBeenCalledTimes(1);
    const advance = updatesWith(s => s.lastBlockHash === 'blk'.padEnd(64, '1'));
    expect(advance).toHaveLength(1);
    expect(advance[0].set).toMatchObject({ lastSlot: 4100, tipSlot: 9000, tipHeight: 90, syncStatus: 'syncing' });
    await crawler.stop();
  });

  it("marks the cursor 'synced' when the persisted block reaches the reported tip", async () => {
    cursorExists();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollForward(block({ slot: 9000 }), [], { slot: 9000, hash: 't', height: 90 });

    expect(updatesWith(s => s.syncStatus === 'synced')).toHaveLength(1);
    await crawler.stop();
  });

  it('acknowledges the initial intersection rollBackward WITHOUT logging a reorg', async () => {
    cursorExists();
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    // Ogmios protocol handshake: rollBackward to exactly our cursor point
    await cbs().rollBackward({ slot: 4000, hash: CURSOR_ROW.lastBlockHash });

    expect(opsFor('INSERT')).toHaveLength(0); // no spurious CardanoReorgLog row
    expect(opsFor('DELETE')).toHaveLength(0);
    await crawler.stop();
  });

  it('treats a rollBackward to a DIFFERENT point as a real reorg', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR_ROW };
      if (q._op === 'SELECT.many') return [];
      return undefined;
    });
    const { client, openChainSync, cbs } = chainSyncClient();
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().rollBackward({ slot: 3000, hash: 'fork'.padEnd(64, '9') });

    const reorgLog = opsFor('INSERT').filter(q => q.entity.endsWith('CardanoReorgLog'));
    expect(reorgLog).toHaveLength(1);
    await crawler.stop();
  });

  it("records and halts with 'error' when the stream cannot resume (pipeline crash is not silent)", async () => {
    cursorExists();
    const openChainSync = jest.fn(async (): Promise<ChainSyncHandle> => { throw new Error('IntersectionNotFound'); });
    const client = { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() };
    const crawler = makeCrawler(client);

    await crawler.start();
    await settle(() => !crawler.isRunning());
    await settle(() => updatesWith(s => s.syncStatus === 'error').length > 0);

    expect(crawler.isRunning()).toBe(false); // NOT a healthy-looking zombie
    expect(updatesWith(s => s.syncStatus === 'error').length).toBeGreaterThan(0);
    expect(updatesWith(s => typeof s.lastError === 'string' && (s.lastError as string).includes('IntersectionNotFound')).length).toBe(1);
  });

  it("onError records the failure and stops with status 'error'", async () => {
    cursorExists();
    const { client, openChainSync, cbs, close } = chainSyncClient();
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    await cbs().onError!(new Error('stream died'));
    await settle(() => updatesWith(s => s.syncStatus === 'error').length > 0);

    expect(crawler.isRunning()).toBe(false);
    expect(close).toHaveBeenCalled(); // stream closed on stop
    expect(updatesWith(s => s.syncStatus === 'error').length).toBeGreaterThan(0);
    expect(updatesWith(s => typeof s.lastError === 'string' && (s.lastError as string).includes('stream died')).length).toBe(1);
  });

  it('closes a socket that finished opening after stop() (no leak on the start/stop race)', async () => {
    cursorExists();
    const close = jest.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const openChainSync = jest.fn(async (): Promise<ChainSyncHandle> => { await gate; return { close }; });
    const client = { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() };
    const crawler = makeCrawler(client);

    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);
    const stopP = crawler.stop(); // races the pending open (stop awaits the pipeline)
    release();                    // open resolves AFTER stop halted the crawler
    await stopP;                  // stop returns only after the pipeline closed the socket

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight chain-sync DB persist before stop resolves', async () => {
    cursorExists();
    const { client, openChainSync, cbs } = chainSyncClient();
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    const indexBlockFull = jest.fn(async () => persistGate);
    const crawler = makeCrawler(client, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    await crawler.start();
    await settle(() => openChainSync.mock.calls.length > 0);

    const callback = cbs().rollForward(block(), []);
    await settle(() => indexBlockFull.mock.calls.length > 0);
    let stopped = false;
    const stopping = crawler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releasePersist();
    await callback;
    await stopping;
    expect(stopped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pagination path
// ---------------------------------------------------------------------------

describe('CardanoCrawler pagination path', () => {
  function paginationSetup(over: Partial<Record<string, jest.Mock>> = {}) {
    const backend = {
      getBlockByHeight: jest.fn(),
      getNextBlocks: jest.fn().mockResolvedValue([]),
      getBlockTransactions: jest.fn().mockResolvedValue([]),
      ...over,
    };
    const client = {
      getChainSyncBackend: () => null,
      getPaginatingBackend: () => backend,
      getLatestBlock: jest.fn().mockResolvedValue(block({ height: 100, slot: 10000, hash: 'tip'.padEnd(64, '3') })),
    };
    return { backend, client };
  }

  it("stops with 'error' when neither chain-sync nor pagination backends exist", async () => {
    cursorExists();
    const client = { getChainSyncBackend: () => null, getPaginatingBackend: () => null };
    const crawler = makeCrawler(client);
    await crawler.start();
    await settle(() => !crawler.isRunning());
    await settle(() => updatesWith(s => s.syncStatus === 'error').length > 0);

    expect(crawler.isRunning()).toBe(false);
    expect(updatesWith(s => s.syncStatus === 'error').length).toBeGreaterThan(0);
  });

  it("marks 'synced' and idles when the cursor is within confirmationDepth of the tip", async () => {
    // cursor at 98, tip 100, depth 3 → target 97 → synced
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR_ROW, lastHeight: '98' };
      return undefined;
    });
    const { client, backend } = paginationSetup();
    const crawler = makeCrawler(client);
    // stop after the first idle sleep so the loop exits
    (crawler as unknown as { sleep: jest.Mock }).sleep = jest.fn(async () => { void crawler.stop(); }); // fire-and-forget: stop() awaits the pipeline, awaiting it from inside the pipeline's sleep would deadlock

    await crawler.start();
    await settle(() => !crawler.isRunning());

    expect(updatesWith(s => s.syncStatus === 'synced').length).toBeGreaterThan(0);
    expect(backend.getNextBlocks).not.toHaveBeenCalled();
  });

  it('persists each fetched block within the confirmation window and stays behind it', async () => {
    // stateful cursor: SELECT reflects the lastHeight written by advanceCursor
    let lastHeight = 40;
    let lastHash = CURSOR_ROW.lastBlockHash;
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) {
        return { ...CURSOR_ROW, lastHeight: String(lastHeight), lastBlockHash: lastHash };
      }
      if (q._op === 'UPDATE') {
        const set = q.set as Record<string, unknown>;
        if (set.lastHeight != null) { lastHeight = Number(set.lastHeight); lastHash = String(set.lastBlockHash); }
      }
      return undefined;
    });
    const indexBlockFull = jest.fn();
    const { client, backend } = paginationSetup({
      getNextBlocks: jest.fn()
        .mockResolvedValueOnce([
          block({ height: 41, hash: 'b41'.padEnd(64, '0'), slot: 4100 }),
          block({ height: 42, hash: 'b42'.padEnd(64, '0'), slot: 4200 }),
          block({ height: 98, hash: 'b98'.padEnd(64, '0'), slot: 9800 }), // beyond target 97 → skipped
        ])
        .mockResolvedValue([]), // subsequent rounds: nothing new → idle sleep
    });
    const crawler = makeCrawler(client, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    (crawler as unknown as { sleep: jest.Mock }).sleep = jest.fn(async () => { void crawler.stop(); }); // fire-and-forget: stop() awaits the pipeline, awaiting it from inside the pipeline's sleep would deadlock

    await crawler.start();
    await settle(() => !crawler.isRunning(), 1000);

    expect(backend.getNextBlocks).toHaveBeenCalledWith(CURSOR_ROW.lastBlockHash, CONFIG.batchSize, 40); // cursor height passed as anchor hint
    expect(backend.getBlockTransactions).toHaveBeenCalledTimes(2); // 41 + 42, NOT 98
    expect(indexBlockFull).toHaveBeenCalledTimes(2);
    expect(client.getLatestBlock).toHaveBeenCalledTimes(1); // tip cached while behind the target
  });

  it('records an error streak on repeated round failures and stops at the breaker threshold', async () => {
    let streak = 0;
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) {
        return { ...CURSOR_ROW, lastHeight: '40', consecutiveErrors: String(streak) };
      }
      if (q._op === 'UPDATE') {
        const set = (q as Q).set as Record<string, unknown>;
        if (typeof set.consecutiveErrors === 'number') streak = set.consecutiveErrors as number;
      }
      return undefined;
    });
    const { client, backend } = paginationSetup();
    (client.getLatestBlock as jest.Mock).mockRejectedValue(new Error('backend down'));
    const crawler = makeCrawler(client);

    await crawler.start();
    await settle(() => !crawler.isRunning(), 3000);

    expect(crawler.isRunning()).toBe(false);
    expect(streak).toBeGreaterThanOrEqual(10); // MAX_CONSECUTIVE_ERRORS
    expect(backend.getBlockByHeight).not.toHaveBeenCalled(); // provider outage is not a reorg signal
    expect(updatesWith(s => s.syncStatus === 'error').length).toBeGreaterThan(0);
  });

  it('runs fork recovery only for the explicit chain-point mismatch marker', async () => {
    cursorExists();
    const { client } = paginationSetup({
      getNextBlocks: jest.fn().mockRejectedValue(new Error('CHAIN_POINT_MISMATCH: orphaned cursor')),
    });
    const crawler = makeCrawler(client);
    const recovery = jest.spyOn(
      crawler as unknown as { tryReorgRecovery: (backend: unknown) => Promise<boolean> },
      'tryReorgRecovery',
    ).mockResolvedValue(false);
    (crawler as unknown as { sleep: jest.Mock }).sleep.mockImplementation(async () => { void crawler.stop(); });

    await crawler.start();
    await settle(() => !crawler.isRunning(), 1000);

    expect(recovery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// persistBlock retries
// ---------------------------------------------------------------------------

describe('CardanoCrawler.persistBlock', () => {
  it('rejects a partial backend transaction list without advancing the cursor', async () => {
    cursorExists();
    const indexBlockFull = jest.fn();
    const crawler = makeCrawler({}, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    (crawler as unknown as { running: boolean }).running = true;

    await expect((crawler as unknown as { persistBlock: (b: BlockData, t: unknown[]) => Promise<boolean> })
      .persistBlock(block({ txCount: 2 }), [{}])).rejects.toThrow('returned 1/2 transactions');

    expect(indexBlockFull).not.toHaveBeenCalled();
    expect(updatesWith(s => s.lastBlockHash != null)).toHaveLength(0);
  });
  it('retries a transient failure and succeeds without stopping', async () => {
    cursorExists();
    const indexBlockFull = jest.fn()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
      .mockResolvedValueOnce(undefined);
    const crawler = makeCrawler({ getChainSyncBackend: () => null, getPaginatingBackend: () => null }, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    (crawler as unknown as { running: boolean }).running = true;

    const ok = await (crawler as unknown as { persistBlock: (b: BlockData, t: unknown[]) => Promise<boolean> })
      .persistBlock(block(), []);

    expect(ok).toBe(true);
    expect(indexBlockFull).toHaveBeenCalledTimes(2);
    expect(crawler.isRunning()).toBe(true); // breaker NOT tripped by one transient error
  });

  it("stops with 'error' only after exhausting the bounded retries", async () => {
    cursorExists();
    const indexBlockFull = jest.fn().mockRejectedValue(new Error('disk full'));
    const crawler = makeCrawler({ getChainSyncBackend: () => null, getPaginatingBackend: () => null }, CONFIG, { indexBlockFull, prefetchCrawlEpoch: jest.fn() });
    (crawler as unknown as { running: boolean }).running = true;

    const ok = await (crawler as unknown as { persistBlock: (b: BlockData, t: unknown[]) => Promise<boolean> })
      .persistBlock(block(), []);

    expect(ok).toBe(false);
    expect(indexBlockFull).toHaveBeenCalledTimes(3); // PERSIST_RETRIES
    expect(crawler.isRunning()).toBe(false);
    expect(updatesWith(s => s.syncStatus === 'error').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pagination reorg recovery
// ---------------------------------------------------------------------------

describe('CardanoCrawler.tryReorgRecovery', () => {
  it('aborts the fork scan after the first unavailable height', async () => {
    cursorExists();
    const backend = { getBlockByHeight: jest.fn().mockRejectedValue(new Error('provider down')) };
    const crawler = makeCrawler({});
    (crawler as unknown as { running: boolean }).running = true;

    const recovered = await (crawler as unknown as { tryReorgRecovery: (b: unknown) => Promise<boolean> })
      .tryReorgRecovery(backend);

    expect(recovered).toBe(false);
    expect(backend.getBlockByHeight).toHaveBeenCalledTimes(1);
  });

  it('cancels a hanging fork-scan request when stopped', async () => {
    cursorExists();
    const backend = { getBlockByHeight: jest.fn(() => new Promise<BlockData>(() => undefined)) };
    const crawler = makeCrawler({});
    (crawler as unknown as { running: boolean }).running = true;

    const recovery = (crawler as unknown as { tryReorgRecovery: (b: unknown) => Promise<boolean> })
      .tryReorgRecovery(backend);
    await settle(() => backend.getBlockByHeight.mock.calls.length > 0);
    await crawler.stop();

    await expect(recovery).resolves.toBe(false);
  });

  it('returns false (transient) when the stored tip still matches on-chain', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR_ROW, lastHeight: '40' };
      if (q._op === 'SELECT.one' && q.entity.endsWith('Blocks')) return { hash: 'match'.padEnd(64, '4') };
      return undefined;
    });
    const backend = { getBlockByHeight: jest.fn().mockResolvedValue(block({ height: 40, hash: 'match'.padEnd(64, '4') })) };
    const crawler = makeCrawler({});
    (crawler as unknown as { running: boolean }).running = true;

    const recovered = await (crawler as unknown as { tryReorgRecovery: (b: unknown) => Promise<boolean> })
      .tryReorgRecovery(backend);

    expect(recovered).toBe(false);
  });

  it('walks back to the fork point and hands it to handleReorg', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.one' && q.entity.endsWith('CardanoSyncState')) return { ...CURSOR_ROW, lastHeight: '40' };
      if (q._op === 'SELECT.one' && q.entity.endsWith('Blocks')) {
        const h = (q.where as { height: number }).height;
        // heights 40 (orphaned) mismatches; 39 matches on-chain
        return { hash: h === 39 ? 'agree'.padEnd(64, '5') : 'orphan'.padEnd(64, '6') };
      }
      return undefined;
    });
    const backend = {
      getBlockByHeight: jest.fn(async (h: number) =>
        block({ height: h, hash: h === 39 ? 'agree'.padEnd(64, '5') : 'chain'.padEnd(64, '7'), slot: h * 100 })),
    };
    const crawler = makeCrawler({});
    (crawler as unknown as { running: boolean }).running = true;
    const handleReorg = jest.spyOn(crawler as unknown as { handleReorg: (p: unknown) => Promise<void> }, 'handleReorg')
      .mockResolvedValue(undefined);

    const recovered = await (crawler as unknown as { tryReorgRecovery: (b: unknown) => Promise<boolean> })
      .tryReorgRecovery(backend);

    expect(recovered).toBe(true);
    expect(handleReorg).toHaveBeenCalledWith({ slot: 3900, hash: 'agree'.padEnd(64, '5'), height: 39 });
  });
});

// ---------------------------------------------------------------------------
// module singleton (crawler/index.ts)
// ---------------------------------------------------------------------------

describe('crawler singleton lifecycle', () => {
  it('startCrawler is idempotent while running; stopCrawler clears the instance', async () => {
    cursorExists();
    const openChainSync = jest.fn(async (): Promise<ChainSyncHandle> => ({ close: jest.fn() }));
    const deps = {
      client: { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() },
      indexer: { indexBlockFull: jest.fn() },
      network: 'preview',
      config: CONFIG,
    };

    await startCrawler(deps as never);
    await settle(() => openChainSync.mock.calls.length > 0);
    expect(isCrawlerRunning()).toBe(true);
    const first = getCrawler();

    await startCrawler(deps as never); // no-op while running
    expect(getCrawler()).toBe(first);
    expect(openChainSync).toHaveBeenCalledTimes(1);

    await stopCrawler();
    expect(isCrawlerRunning()).toBe(false);
    expect(getCrawler()).toBeNull();
  });

  it('does not restart from a standby timer callback invalidated by stopCrawler', async () => {
    jest.useFakeTimers();
    try {
      cursorExists();
      const openChainSync = jest.fn(async (): Promise<ChainSyncHandle> => ({ close: jest.fn() }));
      const deps = {
        client: { getChainSyncBackend: () => ({ openChainSync }), getPaginatingBackend: jest.fn() },
        indexer: { indexBlockFull: jest.fn() },
        network: 'preview',
        config: CONFIG,
      };
      await startCrawler(deps as never);
      await settle(() => openChainSync.mock.calls.length > 0);

      jest.advanceTimersByTime(5_000); // callback has queued an acquire attempt
      await stopCrawler();            // invalidates it before the queued operation runs
      await Promise.resolve();
      await Promise.resolve();

      expect(openChainSync).toHaveBeenCalledTimes(1);
      expect(getCrawler()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
