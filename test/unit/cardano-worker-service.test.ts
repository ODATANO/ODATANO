/**
 * CardanoWorkerService.SubmitWalletJob authorization: HSM-backed wallets inherit the
 * sign service's hsm.requiresRole gate, so an ordinary authenticated-user cannot queue
 * a job that spends the server-held HSM key. Dependencies are mocked at module
 * boundaries; handleRequest passes through to the callback with a fake db.
 */

// No static imports here, so mark the file as a module — otherwise its top-level
// names collide with the identically-shaped harness in cardano-indexer-service.test.ts.
export {};

const { fakeDb, workerMock, jobStoreMock, serverMock } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  workerMock: {
    getWalletWorker: vi.fn(() => undefined),
    isWalletWorkerRunning: vi.fn(() => true),
    startWalletWorker: vi.fn(async () => undefined),
    stopWalletWorker: vi.fn(async () => undefined),
  },
  jobStoreMock: {
    WALLET_JOB_KINDS: ['simpleAda', 'metadata', 'multiAsset', 'mint', 'plutusSpend', 'submitSigned'],
    findDueJobs: vi.fn(async () => []),
    getJobById: vi.fn(async () => null),
    insertJob: vi.fn(async () => ({ jobId: 'job-1', status: 'pending', deduplicated: false })),
    markCancelled: vi.fn(async () => true),
    readWallet: vi.fn(),
  },
  serverMock: {
    getCardanoClient: vi.fn(() => ({ network: 'preview' })),
    getCardanoIndexer: vi.fn(() => ({ indexer: true })),
    getHsmConfig: vi.fn(),
    loadWalletWorkerConfigFromEnv: vi.fn(),
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

vi.mock('../../srv/blockchain/wallet-worker', () => workerMock);
vi.mock('../../srv/blockchain/wallet-worker/job-store', () => jobStoreMock);
vi.mock('../../srv/server', () => serverMock);

type Handler = (req: Record<string, unknown>) => Promise<unknown>;

let registerHandlers: (srv: unknown) => void;
beforeAll(async () => {
  const serviceModule: any = await import('../../srv/cardano-worker-service');
  registerHandlers = serviceModule.default ?? serviceModule;
});

function boot(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const srv = { on: (event: string, handler: Handler) => { handlers[event] = handler; } };
  registerHandlers(srv);
  return handlers;
}

/** CAP's req.reject throws — mirror that so the handler stops at the gate. */
function makeReq(roles: string[], data: Record<string, unknown>) {
  const reject = vi.fn((code: number, message: string) => {
    throw Object.assign(new Error(message), { code });
  });
  return {
    data,
    user: { id: 'alice', is: (role: string) => roles.includes(role) },
    reject,
  };
}

const JOB_DATA = {
  walletId: 'treasury',
  kind: 'simpleAda',
  requestJson: '{"recipientAddress":"addr_test1abc","lovelaceAmount":"2000000"}',
};

beforeEach(() => {
  vi.clearAllMocks();
  serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue({
    enabled: true,
    wallets: [{ walletId: 'treasury', signerType: 'hsm' }],
    defaultMaxAttempts: 3,
  });
  serverMock.getHsmConfig.mockReturnValue({ requiresRole: 'HsmSigner' });
  jobStoreMock.readWallet.mockResolvedValue({ walletId: 'treasury', signerType: 'hsm', enabled: true });
});

describe('CardanoWorkerService.SubmitWalletJob HSM role gate', () => {
  it('rejects with 403 and queues nothing when the caller lacks hsm.requiresRole', async () => {
    const req = makeReq([], JOB_DATA);
    const handlers = boot();

    await expect(handlers.SubmitWalletJob(req)).rejects.toThrow(/requires role 'HsmSigner'/);
    expect(req.reject).toHaveBeenCalledWith(403, expect.stringContaining("requires role 'HsmSigner'"));
    expect(jobStoreMock.insertJob).not.toHaveBeenCalled();
  });

  it('rejects a wallet registered as HSM-backed even when this instance has no config entry for it', async () => {
    serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue({
      enabled: true,
      wallets: [{ walletId: 'other', signerType: 'software' }],
      defaultMaxAttempts: 3,
    });
    const handlers = boot();

    await expect(handlers.SubmitWalletJob(makeReq([], JOB_DATA))).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('HSM-backed'),
    });
    expect(jobStoreMock.insertJob).not.toHaveBeenCalled();
  });

  it('queues the job when the caller holds the configured role', async () => {
    const handlers = boot();

    const result = await handlers.SubmitWalletJob(makeReq(['HsmSigner'], JOB_DATA));

    expect(result).toEqual({ jobId: 'job-1', status: 'pending', deduplicated: false });
    expect(jobStoreMock.insertJob).toHaveBeenCalledTimes(1);
  });

  it('leaves software wallets on the authenticated-user gate', async () => {
    serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue({
      enabled: true,
      wallets: [{ walletId: 'treasury', signerType: 'software' }],
      defaultMaxAttempts: 3,
    });
    jobStoreMock.readWallet.mockResolvedValue({ walletId: 'treasury', signerType: 'software', enabled: true });
    const handlers = boot();

    await handlers.SubmitWalletJob(makeReq([], JOB_DATA));

    expect(jobStoreMock.insertJob).toHaveBeenCalledTimes(1);
  });

  it('does not gate HSM wallets when no requiresRole is configured (HSM disabled)', async () => {
    serverMock.getHsmConfig.mockReturnValue(undefined);
    const handlers = boot();

    await handlers.SubmitWalletJob(makeReq([], JOB_DATA));

    expect(jobStoreMock.insertJob).toHaveBeenCalledTimes(1);
  });
});
