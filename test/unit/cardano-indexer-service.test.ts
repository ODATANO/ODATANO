/**
 * CardanoIndexerService handlers: getStatus shape and progress math, pauseCrawler,
 * the resumeCrawler `enabled` gate and the two probes. Dependencies are mocked at
 * module boundaries; handleRequest passes a fake db straight to the callback.
 */

// vi.mock factories are hoisted above all statements — every mock object they
// capture must be created inside vi.hoisted.
const { fakeDb, crawlerMock, readCursorMock, serverMock, readinessMock, backfillMock, txBackfillMock, credentialBackfillMock, decimalsBackfillMock, registryBackfillMock, registryFilesMock, registryEntryFilesMock, datumBackfillMock, metadataBackfillMock, copyPruneMock, copyRestoreMock } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  readinessMock: vi.fn(),
  backfillMock: vi.fn(),
  txBackfillMock: vi.fn(),
  credentialBackfillMock: vi.fn(),
  decimalsBackfillMock: vi.fn(),
  registryBackfillMock: vi.fn(),
  registryFilesMock: vi.fn(),
  registryEntryFilesMock: vi.fn(),
  datumBackfillMock: vi.fn(),
  metadataBackfillMock: vi.fn(),
  copyPruneMock: vi.fn(),
  copyRestoreMock: vi.fn(),
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
    readinessParts: vi.fn(() => ({ context: true, hsm: null })),
  },
}));

vi.mock('@sap/cds', () => {
  // getStatus reads the newest EpochLedgerSnapshots row: a chainable query stub, fakeDb.run answers it
  const query: Record<string, unknown> = {};
  for (const k of ['from', 'columns', 'orderBy', 'where']) query[k] = () => query;
  const cdsMock = {
  log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  ql: { SELECT: { one: query } },
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
vi.mock('../../srv/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../srv/config')>()),
  loadCrawlerConfigFromEnv: serverMock.loadCrawlerConfigFromEnv,
}));
vi.mock('../../srv/utils/readiness', () => ({ buildReadiness: readinessMock }));
// the snapshot import pulls cds.ql + the DB models at load time; not under test here
vi.mock('../../srv/blockchain/crawler/utxo-set-import', () => ({ importUtxoSet: vi.fn(), rebuildUtxoSetAggregates: vi.fn(), refreshUtxoSetReferenceScripts: vi.fn() }));
vi.mock('../../srv/blockchain/crawler/certificate-backfill', () => ({ backfillCertificates: backfillMock }));
vi.mock('../../srv/blockchain/crawler/transaction-backfill', () => ({ backfillTransactions: txBackfillMock }));
vi.mock('../../srv/blockchain/crawler/credential-backfill', () => ({ backfillUtxoCredentials: credentialBackfillMock }));
vi.mock('../../srv/blockchain/crawler/asset-decimals-backfill', () => ({ backfillAssetDecimals: decimalsBackfillMock }));
vi.mock('../../srv/blockchain/crawler/asset-registry-backfill', () => ({
  backfillAssetRegistry: registryBackfillMock, backfillAssetRegistryFromFiles: registryFilesMock, registryEntryFiles: registryEntryFilesMock,
}));
vi.mock('../../srv/blockchain/crawler/output-datum-backfill', () => ({ backfillOutputDatums: datumBackfillMock }));
vi.mock('../../srv/blockchain/crawler/metadata-position-backfill', () => ({ backfillMetadataPositions: metadataBackfillMock }));
vi.mock('../../srv/blockchain/crawler/input-asset-copies', () => ({ pruneInputAssetCopies: copyPruneMock, restoreInputAssetCopies: copyRestoreMock }));

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
  const srv = { on: (event: string, handler: Handler) => { handlers[event] = handler; }, after: () => undefined };
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
      lastIndexedAt: null,
      stalled: false,
      // crawler-fed UTxO set: not configured, nothing imported
      utxoSet: { enabled: false, status: 'none', anchorSlot: null, anchorHash: null, importedAt: null, error: null },
      certificateBackfill: {
        status: 'none', fromSlot: '0', toSlot: '0', atSlot: '0', blocks: 0, certificates: 0, withdrawals: 0, removed: 0,
        startedAt: null, finishedAt: null, error: null,
      },
      transactionBackfill: {
        status: 'none', fromSlot: '0', toSlot: '0', atSlot: '0', blocks: 0, transactions: 0, inputs: 0, outputs: 0, redeemers: 0, datums: 0, rewritten: 0, skipped: 0,
        startedAt: null, finishedAt: null, error: null,
      },
      credentialBackfill: { status: 'none', table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, startedAt: null, finishedAt: null, error: null },
      decimalsBackfill: { status: 'none', scanned: 0, candidates: 0, filled: 0, startedAt: null, finishedAt: null, error: null },
      registryBackfill: { status: 'none', units: 0, processed: 0, filled: 0, failed: 0, absent: 0, skipped: 0, startedAt: null, finishedAt: null, error: null },
      datumBackfill: {
        status: 'none', scanned: 0, candidates: 0, transactions: 0, missing: 0, outputs: 0, inputs: 0, ledgerUtxos: 0,
        startedAt: null, finishedAt: null, error: null,
      },
      metadataBackfill: { status: 'none', atSlot: '0', toSlot: '0', rows: 0, startedAt: null, finishedAt: null, error: null },
      epochBackfill: { status: 'none', atEpoch: 0, toEpoch: 0, updated: 0, created: 0, startedAt: null, finishedAt: null, error: null },
      copyPrune: { status: 'none', atSlot: '0', toSlot: '0', referenced: 0, kept: 0, deleted: 0, startedAt: null, finishedAt: null, error: null },
      copyRestore: { status: 'none', atSlot: '0', toSlot: '0', restored: 0, rows: 0, startedAt: null, finishedAt: null, error: null },
      epochSnapshots: { enabled: false, source: null, lastEpoch: null, lastSource: null, lastSlot: null, accounts: false, lastAccountEpoch: null, lastAccountCount: null },
    });
  });

  it('reports a crawler that holds its lease but committed no block for 10 minutes as stalled', async () => {
    const lease = { desiredRunning: true, leaseOwner: 'leader', leaseUntil: '2999-01-01T00:00:00.000Z' };
    const base = { lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0, ...lease };
    const handlers = boot();

    readCursorMock.mockResolvedValue({ ...base, lastIndexedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    expect(await handlers.getStatus({})).toMatchObject({ running: true, stalled: true });

    readCursorMock.mockResolvedValue({ ...base, lastIndexedAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await handlers.getStatus({})).toMatchObject({ stalled: false });

    // paused: no lease, nothing to report
    readCursorMock.mockResolvedValue({ ...base, leaseUntil: '2000-01-01T00:00:00.000Z', lastIndexedAt: '2000-01-01T00:00:00.000Z' });
    expect(await handlers.getStatus({})).toMatchObject({ running: false, stalled: false });
  });

  it('reports the newest epoch snapshot and the source the next one would use', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 });
    serverMock.loadCrawlerConfigFromEnv.mockReturnValue({ epochSnapshots: true, accountSnapshots: true });
    serverMock.getCardanoClient.mockReturnValueOnce({
      network: 'preview', getEpochStateBackend: () => ({}), getEnumeratingBackend: () => ({}),
    } as never);
    fakeDb.run.mockResolvedValueOnce({ epoch: 1201, source: 'ogmios', snapshotSlot: 103_766_400 })
      .mockResolvedValueOnce({ epoch: 1200, accountCount: 345 });
    const handlers = boot();

    expect(await handlers.getStatus({})).toMatchObject({
      epochSnapshots: {
        enabled: true, source: 'ogmios', lastEpoch: 1201, lastSource: 'ogmios', lastSlot: '103766400',
        accounts: true, lastAccountEpoch: 1200, lastAccountCount: 345,
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

describe('CardanoIndexerService.getReadiness', () => {
  const READY = { status: 'ready', timestamp: '2026-11-16T12:00:00.000Z', context: true, database: true, hsm: null };
  const makeReq = () => ({ http: { res: { status: vi.fn() } } });

  it('answers the body with the default status when the instance is ready', async () => {
    readinessMock.mockResolvedValue(READY);
    const req = makeReq();

    await expect(boot().getReadiness(req)).resolves.toBe(READY);

    expect(readinessMock).toHaveBeenCalledWith({ context: true, hsm: null });
    expect(req.http.res.status).not.toHaveBeenCalled();
  });

  it('answers 503 with the same body while a part is missing', async () => {
    const notReady = { ...READY, status: 'not_ready', database: false };
    readinessMock.mockResolvedValue(notReady);
    const req = makeReq();

    await expect(boot().getReadiness(req)).resolves.toBe(notReady);

    expect(req.http.res.status).toHaveBeenCalledWith(503);
  });

  it('returns the body to an in-process caller that has no HTTP response', async () => {
    const notReady = { ...READY, status: 'not_ready', context: false };
    readinessMock.mockResolvedValue(notReady);

    await expect(boot().getReadiness({})).resolves.toBe(notReady);
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

describe('CardanoIndexerService.backfillTransactions', () => {
  const cursor = { startSlot: 100, startBlockHash: 'start', lastSlot: 900 };

  it('refuses without a chain-sync backend or past the cursor', async () => {
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getChainSyncBackend: () => null } as any);
    const handlers = boot();
    await expect(handlers.backfillTransactions({ data: {} })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('chain-sync') });
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getChainSyncBackend: () => ({}) } as any);
    readCursorMock.mockResolvedValue(cursor);
    await expect(handlers.backfillTransactions({ data: { toSlot: '901' } })).rejects.toThrow(/past the crawler cursor/);
    expect(txBackfillMock).not.toHaveBeenCalled();
  });

  it('runs detached with the indexer as resolver and reports progress in getStatus', async () => {
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getChainSyncBackend: () => ({}) } as any);
    readCursorMock.mockResolvedValue(cursor);
    let finishRun!: (r: unknown) => void;
    txBackfillMock.mockReturnValue(new Promise((r) => { finishRun = r; }));
    const handlers = boot();

    expect(await handlers.backfillTransactions({ data: { fromSlot: '200' } })).toMatchObject({ accepted: true, fromSlot: '200', toSlot: '900' });
    expect(txBackfillMock.mock.calls[0][0]).toMatchObject({ fromSlot: 200, toSlot: 900 });
    expect(txBackfillMock.mock.calls[0][0].indexer).toBeDefined();
    await expect(handlers.backfillTransactions({ data: {} })).rejects.toThrow(/already running/);

    finishRun({ atSlot: 900, blocks: 3, transactions: 4, inputs: 5, redeemers: 2, datums: 3, skipped: 1, fromSlot: 200, toSlot: 900, intersection: 'origin' });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ transactionBackfill: { status: 'done', atSlot: '900', inputs: 5, redeemers: 2, datums: 3, skipped: 1 } });
  });
});

describe('CardanoIndexerService.backfillPaymentCredentials', () => {
  it('runs detached without a backend, refuses a second start and reports progress in getStatus', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 });
    let finishRun!: (r: unknown) => void;
    credentialBackfillMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ table: 'TransactionInputs', outputs: 7, inputs: 2, ledgerUtxos: 0 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.backfillPaymentCredentials({ data: {} })).toMatchObject({ accepted: true });
    await expect(handlers.backfillPaymentCredentials({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ credentialBackfill: { status: 'running', table: 'TransactionInputs', outputs: 7, inputs: 2 } });

    finishRun({ table: null, outputs: 7, inputs: 9, ledgerUtxos: 4 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ credentialBackfill: { status: 'done', table: null, outputs: 7, inputs: 9, ledgerUtxos: 4, error: null } });
    expect(await handlers.backfillPaymentCredentials({ data: {} })).toMatchObject({ accepted: true });
  });
});

describe('CardanoIndexerService.backfillAssetDecimals', () => {
  it('runs detached without a backend, refuses a second start and reports progress in getStatus', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 });
    let finishRun!: (r: unknown) => void;
    decimalsBackfillMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ scanned: 5000, candidates: 3, filled: 2 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.backfillAssetDecimals({ data: {} })).toMatchObject({ accepted: true });
    await expect(handlers.backfillAssetDecimals({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ decimalsBackfill: { status: 'running', scanned: 5000, candidates: 3, filled: 2 } });

    finishRun({ scanned: 9000, candidates: 4, filled: 4 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ decimalsBackfill: { status: 'done', scanned: 9000, candidates: 4, filled: 4, error: null } });
    expect(await handlers.backfillAssetDecimals({ data: {} })).toMatchObject({ accepted: true });
  });
});

describe('CardanoIndexerService.backfillOutputDatums', () => {
  const cursor = { lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 };
  const clientThat = (serves: boolean) => ({ network: 'preview', supports: vi.fn(() => serves) }) as any;

  it('refuses without a backend that serves transactions and names the other way', async () => {
    const client = clientThat(false);
    serverMock.getCardanoClient.mockReturnValue(client);
    const handlers = boot();

    await expect(handlers.backfillOutputDatums({ data: {} })).rejects.toThrow(/run backfillTransactions/);
    expect(client.supports).toHaveBeenCalledWith('getTransaction');
    expect(datumBackfillMock).not.toHaveBeenCalled();
  });

  it('runs detached, refuses a second start and reports progress in getStatus', async () => {
    readCursorMock.mockResolvedValue(cursor);
    const client = clientThat(true);
    serverMock.getCardanoClient.mockReturnValue(client);
    let finishRun!: (r: unknown) => void;
    datumBackfillMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ scanned: 5000, candidates: 40, transactions: 30, missing: 1, outputs: 12, inputs: 9, ledgerUtxos: 3 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.backfillOutputDatums({ data: {} })).toMatchObject({ accepted: true });
    expect(datumBackfillMock).toHaveBeenCalledWith(expect.objectContaining({ client }));
    await expect(handlers.backfillOutputDatums({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ datumBackfill: { status: 'running', scanned: 5000, candidates: 40, outputs: 12 } });

    finishRun({ scanned: 9000, candidates: 70, transactions: 55, missing: 1, outputs: 20, inputs: 15, ledgerUtxos: 5 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ datumBackfill: { status: 'done', scanned: 9000, outputs: 20, inputs: 15, ledgerUtxos: 5, error: null } });
  });

  it('keeps the error of a failed run', async () => {
    readCursorMock.mockResolvedValue(cursor);
    serverMock.getCardanoClient.mockReturnValue(clientThat(true));
    datumBackfillMock.mockRejectedValue(new Error('provider down'));
    const handlers = boot();

    await handlers.backfillOutputDatums({ data: {} });
    await new Promise((r) => setImmediate(r));

    expect(await handlers.getStatus({})).toMatchObject({ datumBackfill: { status: 'failed', error: 'provider down' } });
  });
});

describe('CardanoIndexerService.backfillMetadataPositions', () => {
  it('runs detached without a backend, refuses a second start and reports slots as strings', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 });
    let finishRun!: (r: unknown) => void;
    metadataBackfillMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ atSlot: 40_000, toSlot: 90_000, rows: 12 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.backfillMetadataPositions({ data: {} })).toMatchObject({ accepted: true });
    await expect(handlers.backfillMetadataPositions({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ metadataBackfill: { status: 'running', atSlot: '40000', toSlot: '90000', rows: 12 } });
    expect(metadataBackfillMock).toHaveBeenCalledWith({ onProgress: expect.any(Function) });

    finishRun({ atSlot: 90_000, toSlot: 90_000, rows: 30 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ metadataBackfill: { status: 'done', atSlot: '90000', rows: 30, error: null } });
  });
});

describe('CardanoIndexerService.backfillEpochs', () => {
  it('runs detached on the indexer and reports the epochs it wrote', async () => {
    readCursorMock.mockResolvedValue({ lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 });
    const backfillEpochs = vi.fn(async (onProgress: (p: unknown) => void) => {
      onProgress({ atEpoch: 5, toEpoch: 9, updated: 2, created: 1 });
      return { atEpoch: 9, toEpoch: 9, updated: 4, created: 3 };
    });
    serverMock.getCardanoIndexer.mockReturnValueOnce({ backfillEpochs } as never);
    const handlers = boot();

    expect(await handlers.backfillEpochs({ data: {} })).toMatchObject({ accepted: true });
    await new Promise((r) => setImmediate(r));
    expect(backfillEpochs).toHaveBeenCalledTimes(1);
    expect(await handlers.getStatus({})).toMatchObject({ epochBackfill: { status: 'done', atEpoch: 9, toEpoch: 9, updated: 4, created: 3, error: null } });
  });
});

describe('CardanoIndexerService input asset copies', () => {
  const cursor = { lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 };

  it('prunes the named slots detached, refuses a second walk and reports the counts', async () => {
    readCursorMock.mockResolvedValue(cursor);
    let finishRun!: (r: unknown) => void;
    copyPruneMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ atSlot: 119, toSlot: 500, referenced: 40, kept: 3, deleted: 95 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.pruneInputAssetCopies({ data: { fromSlot: 100, toSlot: '500' } })).toMatchObject({ accepted: true });
    await expect(handlers.pruneInputAssetCopies({ data: { fromSlot: 1, toSlot: 2 } })).rejects.toThrow(/already running/);
    await expect(handlers.restoreInputAssetCopies({ data: { fromSlot: 1, toSlot: 2 } })).rejects.toThrow(/already running/);
    expect(copyPruneMock).toHaveBeenCalledWith({ fromSlot: 100, toSlot: 500, onProgress: expect.any(Function) });
    expect(await handlers.getStatus({})).toMatchObject({ copyPrune: { status: 'running', atSlot: '119', toSlot: '500', referenced: 40, kept: 3, deleted: 95 } });

    finishRun({ atSlot: 500, toSlot: 500, referenced: 90, kept: 7, deleted: 210 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ copyPrune: { status: 'done', atSlot: '500', referenced: 90, deleted: 210, error: null } });
  });

  it.each(['pruneInputAssetCopies', 'restoreInputAssetCopies'])('%s moves only a slot range the caller names', async (action) => {
    readCursorMock.mockResolvedValue(cursor);
    const handlers = boot();

    await expect(handlers[action]({ data: { toSlot: 200 } })).rejects.toThrow(/fromSlot/);
    await expect(handlers[action]({ data: { fromSlot: 100 } })).rejects.toThrow(/toSlot/);
    await expect(handlers[action]({ data: { fromSlot: 300, toSlot: 200 } })).rejects.toThrow(/must not be after/);
    expect(copyPruneMock).not.toHaveBeenCalled();
    expect(copyRestoreMock).not.toHaveBeenCalled();
  });

  it('restores a slot range and reports a failed walk', async () => {
    readCursorMock.mockResolvedValue(cursor);
    copyRestoreMock.mockResolvedValueOnce({ atSlot: 200, toSlot: 200, restored: 12, rows: 30 }).mockRejectedValueOnce(new Error('disk full'));
    const handlers = boot();

    expect(await handlers.restoreInputAssetCopies({ data: { fromSlot: 100, toSlot: 200, slotWindow: 5000 } })).toMatchObject({ accepted: true });
    expect(copyRestoreMock).toHaveBeenCalledWith({ fromSlot: 100, toSlot: 200, slotWindow: 5000, onProgress: expect.any(Function) });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ copyRestore: { status: 'done', restored: 12, rows: 30 } });

    await handlers.restoreInputAssetCopies({ data: { fromSlot: 1, toSlot: 2 } });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ copyRestore: { status: 'failed', error: 'disk full' } });
  });
});

describe('CardanoIndexerService.backfillAssetRegistry', () => {
  const cursor = { lastSlot: 1, lastHeight: 1, tipHeight: 1, syncStatus: 'synced', consecutiveErrors: 0 };

  it('refuses without a backend that lists the registry', async () => {
    readCursorMock.mockResolvedValue(cursor);
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getTokenRegistryBackend: () => null } as any);
    const handlers = boot();

    await expect(handlers.backfillAssetRegistry({ data: {} })).rejects.toThrow(/needs Koios/);
    expect(registryBackfillMock).not.toHaveBeenCalled();
  });

  it('runs detached, refuses a second start and reports progress in getStatus', async () => {
    readCursorMock.mockResolvedValue(cursor);
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getTokenRegistryBackend: () => ({}) } as any);
    let finishRun!: (r: unknown) => void;
    registryBackfillMock.mockImplementation((opts: { onProgress: (p: unknown) => void }) => new Promise((r) => {
      opts.onProgress({ units: 7984, processed: 100, filled: 98, failed: 2 });
      finishRun = r;
    }));
    const handlers = boot();

    expect(await handlers.backfillAssetRegistry({ data: {} })).toMatchObject({ accepted: true });
    expect(registryBackfillMock).toHaveBeenCalledWith(expect.objectContaining({ indexer: { indexer: true } }));
    await expect(handlers.backfillAssetRegistry({ data: {} })).rejects.toThrow(/already running/);
    expect(await handlers.getStatus({})).toMatchObject({ registryBackfill: { status: 'running', units: 7984, processed: 100, filled: 98, failed: 2 } });

    finishRun({ units: 7984, processed: 7984, filled: 7980, failed: 4 });
    await new Promise((r) => setImmediate(r));
    expect(await handlers.getStatus({})).toMatchObject({ registryBackfill: { status: 'done', processed: 7984, filled: 7980, failed: 4, error: null } });
    expect(await handlers.backfillAssetRegistry({ data: {} })).toMatchObject({ accepted: true });
    // end the second run, so the next case starts idle
    finishRun({ units: 0, processed: 0, filled: 0, failed: 0 });
    await new Promise((r) => setImmediate(r));
  });

  it('reads the entry files of a folder without any backend', async () => {
    readCursorMock.mockResolvedValue(cursor);
    serverMock.getCardanoClient.mockReturnValue({ network: 'preview', getTokenRegistryBackend: () => null } as any);
    registryBackfillMock.mockReset();
    registryEntryFilesMock.mockResolvedValue(['a.json']);
    registryFilesMock.mockResolvedValue({ units: 9000, processed: 9000, filled: 8700, failed: 1, absent: 250, skipped: 49 });
    const handlers = boot();

    expect(await handlers.backfillAssetRegistry({ data: { source: 'file', path: '/data/registry/mappings' } })).toMatchObject({ accepted: true });
    await new Promise((r) => setImmediate(r));

    expect(registryEntryFilesMock).toHaveBeenCalledWith('/data/registry/mappings');
    expect(registryFilesMock).toHaveBeenCalledWith({ directory: '/data/registry/mappings', onProgress: expect.any(Function) });
    expect(registryBackfillMock).not.toHaveBeenCalled();
    expect(await handlers.getStatus({})).toMatchObject({
      registryBackfill: { status: 'done', units: 9000, filled: 8700, failed: 1, absent: 250, skipped: 49 },
    });
  });

  it('refuses the file source without a path, and a path that holds no entries', async () => {
    readCursorMock.mockResolvedValue(cursor);
    registryFilesMock.mockReset();
    const handlers = boot();

    await expect(handlers.backfillAssetRegistry({ data: { source: 'file' } })).rejects.toThrow(/path/);
    registryEntryFilesMock.mockRejectedValue(new Error('path holds no entry files (*.json).'));
    await expect(handlers.backfillAssetRegistry({ data: { source: 'file', path: '/empty' } })).rejects.toThrow(/holds no entry files/);
    expect(registryFilesMock).not.toHaveBeenCalled();
  });
});
