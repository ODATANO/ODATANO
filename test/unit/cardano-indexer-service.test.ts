/**
 * CardanoIndexerService handlers (crawler C5 control surface): getStatus shape +
 * progress math, pauseCrawler, and the resumeCrawler `enabled` gate (400 instead of
 * an implicit genesis crawl). Dependencies are mocked at module boundaries; the
 * handleRequest wrapper is passed through to the callback with a fake db.
 */

// vi.mock factories are hoisted above all statements — every mock object they
// capture must be created inside vi.hoisted.
const { fakeDb, crawlerMock, readCursorMock, serverMock } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  crawlerMock: {
    isCrawlerRunning: vi.fn(() => true),
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

// the impl registers handlers via module.exports = (srv) => {...}; the dynamic
// import goes through vitest's module graph so the mocks above apply, and the
// CJS export surfaces as `.default`. (beforeAll instead of top-level await —
// tsconfig compiles CommonJS, which forbids TLA.)
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
      lastSlot: '4000',
      lastHeight: '50',
      tipHeight: '200',
      syncProgress: '25.00', // 50/200
      consecutiveErrors: 2,
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
