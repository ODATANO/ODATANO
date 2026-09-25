/**
 * CardanoIndexerService handlers: getStatus shape and progress math, pauseCrawler,
 * the resumeCrawler `enabled` gate and getLiveness. Dependencies are mocked at
 * module boundaries; handleRequest passes a fake db straight to the callback.
 */

// vi.mock factories are hoisted above all statements — every mock object they
// capture must be created inside vi.hoisted.
const { fakeDb, crawlerMock, readCursorMock, serverMock, backfillMock } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  backfillMock: vi.fn(),
  crawlerMock: {
    isCrawlerRunning: vi.fn(() => true),
    getCrawler: vi.fn<() => { getActiveSource: () => string | null } | null>(() => null),
    isCrawlerRunningInCluster: vi.fn(async () => true),
    startCrawler: vi.fn(async () => undefined),
    stopCrawler: vi.fn(async () => undefined),
  },
  readCursorMock: vi.fn(),
  serverMock: {
    getCardanoClient: vi.fn(() => ({ network: 'preview' })),
    getCardanoIndexer: vi.fn(() => ({ indexer: true })),
    loadCrawlerConfigFromEnv: vi.fn(),
  },
}));

vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
};
  return { default: cdsMock, ...cdsMock };
});

vi.mock('../../srv/utils/backend-request-handler', () => ({
  handleRequest: vi.fn((_req: unknown, cb: (db: unknown) => unknown) => cb(fakeDb)),
}));

vi.mock('../../srv/blockchain/crawler', () => crawlerMock);

vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  readCursor: (db: unknown) => readCursorMock(db),
  isCrawlerLeaseActive: (cursor: { desiredRunning?: boolean; leaseOwner?: string; leaseUntil?: string } | null) =>
    Boolean(cursor?.desiredRunning && cursor.leaseOwner && cursor.leaseUntil && Date.parse(cursor.leaseUntil) > Date.now()),
}));

vi.mock('../../srv/server', () => serverMock);
// the snapshot import pulls cds.ql + the DB models at load time; not under test here
vi.mock('../../srv/blockchain/crawler/utxo-set-import', () => ({ importUtxoSet: vi.fn() }));
vi.mock('../../srv/blockchain/crawler/certificate-backfill', () => ({ backfillCertificates: backfillMock }));

// The impl exports `module.exports = (srv) => {...}`; a dynamic import applies the
// mocks above and surfaces the CJS export as `.default`. beforeAll, not top-level
// await: the CommonJS build forbids TLA.
type Handler = (req: Record<string, unknown>) => Promise<unknown>;

let registerHandlers: (srv: unknown) => void;
beforeAll(async () => {
  const serviceModule: any = await import('../../srv/cardano-indexer-service');
  registerHandlers = serviceModule.default ?? serviceModule;
});

function boot(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const srv = { on: (event: string, handler: Handler) => { handlers[event] = handler; } };
  registerHandlers(srv);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  crawlerMock.isCrawlerRunning.mockReturnValue(true);
});

describe('CardanoIndexerService.getStatus', () => {
  it('returns run state and progress with numeric fields as strings (CAP-10 aligned)', async () => {
    readCursorMock.mockResolvedValue({
      lastSlot: 4000, lastHeight: 50, tipHeight: 200, syncStatus: 'syncing', consecutiveErrors: 2,
      desiredRunning: true, leaseOwner: 'leader', leaseUntil: '2999-01-01T00:00:00.000Z',
    });
    const handlers = boot();

    const status = await handlers.getStatus({});

    expect(status).toEqual({
      running: true,
      syncStatus: 'syncing',
      source: null, // no crawler in this process
      lastSlot: '4000',
      lastHeight: '50',
      tipHeight: '200',
      syncProgress: '25.00', // 50/200
      consecutiveErrors: 2,
      // crawler-fed UTxO set: not configured, nothing imported
      utxoSet: { enabled: false, status: 'none', anchorSlot: null, anchorHash: null, importedAt: null, error: null },
      certificateBackfill: {
        status: 'none', fromSlot: '0', toSlot: '0', atSlot: '0', blocks: 0, certificates: 0, withdrawals: 0,
        startedAt: null, finishedAt: null, error: null,
      },
    });
  });

  it('reports zero progress and stopped defaults when no cursor exists yet', async () => {
    readCursorMock.mockResolvedValue(null);
    crawlerMock.isCrawlerRunning.mockReturnValue(false);
    const handlers = boot();

    const status = await handlers.getStatus({});

    expect(status).toMatchObject({
      running: false, syncStatus: 'stopped', lastSlot: '0', lastHeight: '0', tipHeight: '0', syncProgress: '0.00',
    });
  });

  it('reports the source the local crawler ingests from, so a degraded crawl is visible', async () => {
    readCursorMock.mockResolvedValue({ ...{ lastSlot: 1, lastHeight: 50, tipHeight: 200, syncStatus: 'syncing', consecutiveErrors: 0 } });
    crawlerMock.getCrawler.mockReturnValue({ getActiveSource: () => 'pagination' });
    const handlers = boot();

    const status = await handlers.getStatus({});

    expect(status).toMatchObject({ source: 'pagination' });
  });

  it('caps progress at 100 when the cursor is ahead of the stale tip', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 250, tipHeight: 200, syncStatus: 'synced', consecutiveErrors: 0 });
    const handlers = boot();
    const status = await handlers.getStatus({}) as { syncProgress: string };
    expect(status.syncProgress).toBe('100.00');
  });
});

describe('CardanoIndexerService.pauseCrawler', () => {
  it('stops the crawler and returns true', async () => {
    const handlers = boot();
    const result = await handlers.pauseCrawler({});
    expect(crawlerMock.stopCrawler).toHaveBeenCalledWith(true);
    expect(result).toBe(true);
  });
});

describe('CardanoIndexerService.resumeCrawler', () => {
  it('rejects with 400 (rejectInvalid → BackendError) and does NOT start when the crawler is not enabled', async () => {
    serverMock.loadCrawlerConfigFromEnv.mockReturnValue({ enabled: false, source: 'auto' });
    const handlers = boot();

    await expect(handlers.resumeCrawler({})).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('not enabled'),
    });
    expect(crawlerMock.startCrawler).not.toHaveBeenCalled();
  });

  it('maps a ConfigError from the loader to a clean 400 instead of an escaping 500', async () => {
    serverMock.loadCrawlerConfigFromEnv.mockImplementation(() => {
      throw new Error('Crawler is enabled but no start block is configured — set crawler.startSlot + crawler.startBlockHash.');
    });
    const handlers = boot();

    await expect(handlers.resumeCrawler({})).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('no start block'),
    });
    expect(crawlerMock.startCrawler).not.toHaveBeenCalled();
  });

  it('starts the crawler with client/indexer/network/config when enabled', async () => {
    const config = { enabled: true, startSlot: 1, startBlockHash: 'h', source: 'auto' };
    serverMock.loadCrawlerConfigFromEnv.mockReturnValue(config);
    readCursorMock.mockResolvedValue({
      desiredRunning: true, leaseOwner: 'leader', leaseUntil: '2999-01-01T00:00:00.000Z',
    });
    const handlers = boot();

    const result = await handlers.resumeCrawler({ reject: vi.fn() });

    expect(crawlerMock.startCrawler).toHaveBeenCalledWith({
      client: { network: 'preview' },
      indexer: { indexer: true },
      network: 'preview',
      config,
    }, true);
    expect(result).toBe(true); // isCrawlerRunning
  });
});

describe('CardanoIndexerService.getLiveness', () => {
  it('answers process facts only — no cursor read, no app context, no handleRequest', async () => {
    const handlers = boot();
    const body = (await handlers.getLiveness({})) as { status: string; timestamp: string; uptime: number; version: string; network: string };

    expect(body.status).toBe('alive');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(Number.isInteger(body.uptime) && body.uptime >= 0).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(body.version).toBe((require('../../package.json') as { version: string }).version);
    expect(['preview', 'preprod', 'mainnet']).toContain(body.network);
    expect(Object.keys(body).sort()).toEqual(['network', 'status', 'timestamp', 'uptime', 'version']);

    expect(readCursorMock).not.toHaveBeenCalled();
    expect(serverMock.getCardanoClient).not.toHaveBeenCalled();
    expect(serverMock.getCardanoIndexer).not.toHaveBeenCalled();
  });
});

// Runs last: the backfill state is module-level and outlives each boot().
describe('CardanoIndexerService.backfillCertificates', () => {
  const cursor = { startSlot: 100, startBlockHash: 'start', lastSlot: 900 };
  const withChainSync = () => serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getChainSyncBackend: () => ({}) } as any);

  it('refuses without a chain-sync backend', async () => {
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getChainSyncBackend: () => null } as any);
    const handlers = boot();
    await expect(handlers.backfillCertificates({ data: {} })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('chain-sync') });
    expect(backfillMock).not.toHaveBeenCalled();
  });

  it('refuses a toSlot past the crawler cursor', async () => {
    withChainSync();
    readCursorMock.mockResolvedValue(cursor);
    const handlers = boot();
    await expect(handlers.backfillCertificates({ data: { toSlot: '901' } })).rejects.toThrow(/past the crawler cursor/);
    expect(backfillMock).not.toHaveBeenCalled();
  });

  it('starts one run only, even for two requests that arrive together', async () => {
    withChainSync();
    let releaseCursor!: (c: typeof cursor) => void;
    readCursorMock.mockReturnValueOnce(new Promise((r) => { releaseCursor = r; }));
    let finishRun!: (r: unknown) => void;
    backfillMock.mockReturnValue(new Promise((r) => { finishRun = r; }));
    const handlers = boot();

    const first = handlers.backfillCertificates({ data: {} });
    await expect(handlers.backfillCertificates({ data: {} })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('already running') });
    releaseCursor(cursor);
    expect(await first).toMatchObject({ accepted: true, fromSlot: '100', toSlot: '900' });
    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(backfillMock.mock.calls[0][0]).toMatchObject({ fromSlot: 100, toSlot: 900 });

    readCursorMock.mockResolvedValue(cursor);
    await expect(handlers.backfillCertificates({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ certificateBackfill: { status: 'running', fromSlot: '100', toSlot: '900' } });

    finishRun({ atSlot: 900, blocks: 3, transactions: 4, certificates: 2, withdrawals: 1, fromSlot: 100, toSlot: 900, intersection: 'origin' });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ certificateBackfill: { status: 'done', atSlot: '900', blocks: 3, certificates: 2, withdrawals: 1 } });
  });
});
