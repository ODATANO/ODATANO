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
  // Return types are widened on purpose: the per-test mockResolvedValue calls
  // supply richer shapes than the defaults would infer.
  workerMock: {
    getWalletWorker: vi.fn((): unknown => undefined),
    isWalletWorkerRunning: vi.fn(() => true),
    startWalletWorker: vi.fn(async () => undefined),
    stopWalletWorker: vi.fn(async () => undefined),
  },
  jobStoreMock: {
    WALLET_JOB_KINDS: ['simpleAda', 'metadata', 'multiAsset', 'mint', 'plutusSpend', 'submitSigned'],
    findDueJobs: vi.fn(async (): Promise<unknown[]> => []),
    getJobById: vi.fn(async (): Promise<unknown> => null),
    insertJob: vi.fn(async (): Promise<unknown> => ({ jobId: 'job-1', status: 'pending', deduplicated: false })),
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

describe('CardanoWorkerService.SubmitWalletJob validation', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['walletId is missing', { ...JOB_DATA, walletId: '  ' }, 'walletId is required'],
    ['kind is unknown', { ...JOB_DATA, kind: 'teleport' }, 'Invalid kind'],
    ['requestJson is missing', { ...JOB_DATA, requestJson: '' }, 'requestJson is required'],
    ['requestJson is not JSON', { ...JOB_DATA, requestJson: 'not-json' }, 'requestJson'],
    ['priority is out of range', { ...JOB_DATA, priority: 99_999 }, 'priority must be an integer'],
    ['notBefore is unparseable', { ...JOB_DATA, notBefore: 'whenever' }, 'notBefore must be a valid timestamp'],
    ['idempotencyKey is oversized', { ...JOB_DATA, idempotencyKey: 'x'.repeat(101) }, 'idempotencyKey exceeds'],
  ];

  it.each(cases)('rejects with 400 when %s', async (_label, data, message) => {
    const handlers = boot();
    await expect(handlers.SubmitWalletJob(makeReq(['HsmSigner'], data))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
    expect(jobStoreMock.insertJob).not.toHaveBeenCalled();
  });

  it('rejects when the worker is disabled or its config does not load', async () => {
    const handlers = boot();

    serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue({ enabled: false, wallets: [] });
    await expect(handlers.SubmitWalletJob(makeReq(['HsmSigner'], JOB_DATA))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('not enabled'),
    });

    serverMock.loadWalletWorkerConfigFromEnv.mockImplementation(() => { throw new Error('WALLET_WORKER_WALLETS is malformed'); });
    await expect(handlers.SubmitWalletJob(makeReq(['HsmSigner'], JOB_DATA))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('malformed'),
    });
    expect(jobStoreMock.insertJob).not.toHaveBeenCalled();
  });

  it('rejects unknown and disabled wallets', async () => {
    const handlers = boot();

    jobStoreMock.readWallet.mockResolvedValue(null);
    await expect(handlers.SubmitWalletJob(makeReq(['HsmSigner'], JOB_DATA))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('Unknown wallet'),
    });

    jobStoreMock.readWallet.mockResolvedValue({ walletId: 'treasury', signerType: 'hsm', enabled: false });
    await expect(handlers.SubmitWalletJob(makeReq(['HsmSigner'], JOB_DATA))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('is disabled'),
    });
    expect(jobStoreMock.insertJob).not.toHaveBeenCalled();
  });

  it('passes idempotency key, priority and notBefore through to the store', async () => {
    const handlers = boot();
    const notBefore = '2026-08-09T10:00:00.000Z';

    await handlers.SubmitWalletJob(makeReq(['HsmSigner'], {
      ...JOB_DATA, idempotencyKey: 'invoice-4711', priority: 10, notBefore,
    }));

    expect(jobStoreMock.insertJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      walletId: 'treasury',
      kind: 'simpleAda',
      idempotencyKey: 'invoice-4711',
      priority: 10,
      notBefore,
      maxAttempts: 3,
      createdBy: 'alice',
    }));
  });
});

describe('CardanoWorkerService job access control', () => {
  const OWN_JOB = {
    ID: 'job-1', walletId: 'treasury', kind: 'simpleAda', status: 'submitted', attempt: 1,
    txHash: 'a'.repeat(64), fee: 170000, errorCode: null, errorMessage: null,
    submittedAt: '2026-08-09T10:00:00.000Z', confirmedAt: null, finishedAt: null,
    createdBy: 'alice',
  };

  it('GetJobStatus returns the job of its creator with numeric fee as a string', async () => {
    jobStoreMock.getJobById.mockResolvedValue(OWN_JOB);
    const handlers = boot();

    const status = await handlers.GetJobStatus(makeReq([], { jobId: 'job-1' }));

    expect(status).toEqual({
      jobId: 'job-1', walletId: 'treasury', kind: 'simpleAda', status: 'submitted', attempt: 1,
      txHash: 'a'.repeat(64), fee: '170000', errorCode: null, errorMessage: null,
      submittedAt: '2026-08-09T10:00:00.000Z', confirmedAt: null, finishedAt: null,
    });
  });

  it('GetJobStatus hides a foreign job behind the same 404 as a missing one', async () => {
    const handlers = boot();

    // Assert the STATUS, not the mechanism: these run inside handleRequest, whose
    // catch remaps anything that is not a BackendError to 500 — which is exactly
    // how the real 404 was broken before the integration test caught it.
    jobStoreMock.getJobById.mockResolvedValue({ ...OWN_JOB, createdBy: 'bob' });
    await expect(handlers.GetJobStatus(makeReq([], { jobId: 'job-1' }))).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('job-1'),
    });

    jobStoreMock.getJobById.mockResolvedValue(null);
    await expect(handlers.GetJobStatus(makeReq([], { jobId: 'job-1' }))).rejects.toThrow(/not found/);
  });

  it('GetJobStatus lets an Admin read foreign jobs', async () => {
    jobStoreMock.getJobById.mockResolvedValue({ ...OWN_JOB, createdBy: 'bob' });
    const handlers = boot();

    const status = await handlers.GetJobStatus(makeReq(['Admin'], { jobId: 'job-1' })) as { jobId: string };
    expect(status.jobId).toBe('job-1');
  });

  it('GetJobStatus and CancelJob require a jobId', async () => {
    const handlers = boot();
    for (const action of ['GetJobStatus', 'CancelJob']) {
      await expect(handlers[action](makeReq([], {}))).rejects.toMatchObject({
        statusCode: 400, message: expect.stringContaining('jobId is required'),
      });
    }
  });

  it('CancelJob cancels a pending job of its creator', async () => {
    jobStoreMock.getJobById.mockResolvedValue({ ...OWN_JOB, status: 'pending' });
    jobStoreMock.markCancelled.mockResolvedValue(true);
    const handlers = boot();

    await expect(handlers.CancelJob(makeReq([], { jobId: 'job-1' }))).resolves.toBe(true);
    expect(jobStoreMock.markCancelled).toHaveBeenCalledWith(expect.anything(), 'job-1');
  });

  it('CancelJob refuses a job that already left pending', async () => {
    jobStoreMock.getJobById.mockResolvedValue(OWN_JOB); // submitted
    jobStoreMock.markCancelled.mockResolvedValue(false);
    const handlers = boot();

    await expect(handlers.CancelJob(makeReq([], { jobId: 'job-1' }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('only pending jobs can be cancelled'),
    });
  });

  it('CancelJob 404s on a foreign job instead of cancelling it', async () => {
    jobStoreMock.getJobById.mockResolvedValue({ ...OWN_JOB, status: 'pending', createdBy: 'bob' });
    const handlers = boot();

    await expect(handlers.CancelJob(makeReq([], { jobId: 'job-1' }))).rejects.toThrow(/not found/);
    expect(jobStoreMock.markCancelled).not.toHaveBeenCalled();
  });
});

describe('CardanoWorkerService worker control', () => {
  it('GetWorkerStatus reports the live worker plus the queue depth', async () => {
    workerMock.getWalletWorker.mockReturnValue({
      getStatusSummary: () => ({ running: true, wallets: ['treasury'], executing: ['treasury'], awaitingConfirmation: 2 }),
    });
    jobStoreMock.findDueJobs.mockResolvedValue([{ ID: 'a' }, { ID: 'b' }, { ID: 'c' }]);
    const handlers = boot();

    await expect(handlers.GetWorkerStatus(makeReq([], {}))).resolves.toEqual({
      running: true, wallets: ['treasury'], executing: ['treasury'], awaitingConfirmation: 2, pendingJobs: 3,
    });
  });

  it('GetWorkerStatus falls back to a stopped summary when no worker runs here', async () => {
    workerMock.getWalletWorker.mockReturnValue(undefined);
    // clearAllMocks() clears calls but keeps implementations — be explicit.
    jobStoreMock.findDueJobs.mockResolvedValue([]);
    const handlers = boot();

    await expect(handlers.GetWorkerStatus(makeReq([], {}))).resolves.toEqual({
      running: false, wallets: [], executing: [], awaitingConfirmation: 0, pendingJobs: 0,
    });
  });

  it('PauseWorker stops the local instance', async () => {
    const handlers = boot();

    await expect(handlers.PauseWorker(makeReq(['Admin'], {}))).resolves.toBe(true);
    expect(workerMock.stopWalletWorker).toHaveBeenCalledTimes(1);
  });

  it('ResumeWorker starts the worker from the current config', async () => {
    const config = { enabled: true, wallets: [{ walletId: 'treasury', signerType: 'hsm' }], defaultMaxAttempts: 3 };
    serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue(config);
    const handlers = boot();

    await expect(handlers.ResumeWorker(makeReq(['Admin'], {}))).resolves.toBe(true);
    expect(workerMock.startWalletWorker).toHaveBeenCalledWith({
      client: { network: 'preview' },
      indexer: { indexer: true },
      network: 'preview',
      config,
    });
  });

  it('ResumeWorker refuses while the worker is disabled or misconfigured', async () => {
    const handlers = boot();

    serverMock.loadWalletWorkerConfigFromEnv.mockReturnValue({ enabled: false, wallets: [] });
    await expect(handlers.ResumeWorker(makeReq(['Admin'], {}))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('not enabled'),
    });

    serverMock.loadWalletWorkerConfigFromEnv.mockImplementation(() => { throw new Error('no wallets configured'); });
    await expect(handlers.ResumeWorker(makeReq(['Admin'], {}))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('no wallets configured'),
    });
    expect(workerMock.startWalletWorker).not.toHaveBeenCalled();
  });
});
