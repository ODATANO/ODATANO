/**
 * CardanoSignService handlers: the HSM gates (role, connection, sender and change address, required
 * signers) and the signing request lookup. Dependencies are mocked at module boundaries; the fake
 * db answers by entity and records what was asked.
 */
export {};

interface Query { op: string; entity: unknown; set?: Record<string, unknown>; where?: Record<string, unknown> }

const { fakeDb, rows, hsm, signer, serverMock, sendProblem } = vi.hoisted(() => ({
  sendProblem: vi.fn((_cbor: string, _network: string): string | null => null),
  fakeDb: { run: vi.fn() },
  rows: {
    build: undefined as Record<string, unknown> | undefined,
    request: undefined as Record<string, unknown> | undefined,
    outputs: [] as Array<{ outputIndex: number; address: string; isChange: boolean }>,
    body: [] as Array<{ address: string }>,
  },
  hsm: {
    isConnected: vi.fn(() => true),
    getAddress: vi.fn(() => 'addr_test1hsm'),
    signTransaction: vi.fn(() => 'signed-cbor'),
    getStatus: vi.fn(() => ({ connected: true, keyLabel: 'k1', keyId: '0x01' })),
  },
  signer: {
    createSigningRequest: vi.fn(() => ({ payload: true })),
    verifySignedTransaction: vi.fn((_cbor: string, _hash: string, _opts?: unknown) => ({ isValid: true, witnessCount: 1, signerKeyHashes: ['k'], warnings: [] })),
    verifyOrThrow: vi.fn(() => ({ txBodyHash: 'h', witnessCount: 1, signerKeyHashes: ['k'], warnings: [] })),
  },
  serverMock: {
    getCardanoIndexer: vi.fn(),
    getCardanoClient: vi.fn(() => ({ network: 'preview' })),
    getHsmConfig: vi.fn((): { requiresRole?: string } | undefined => ({ requiresRole: 'HsmSigner' })),
  },
}));

vi.mock('@sap/cds', () => {
  const make = (op: string, entity: unknown) => {
    const query: Query = { op, entity };
    const api = {
      query,
      set: (data: Record<string, unknown>) => { query.set = data; return api; },
      columns: () => api,
      where: (cond: Record<string, unknown>) => { query.where = cond; return api; },
    };
    return api;
  };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: () => fakeDb,
    ql: {
      SELECT: { one: { from: (e: unknown) => make('SELECT_ONE', e) }, from: (e: unknown) => make('SELECT', e) },
      UPDATE: { entity: (e: unknown) => make('UPDATE', e) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/backend-request-handler', () => ({
  handleRequest: (_req: unknown, cb: (db: unknown) => unknown) => cb(fakeDb),
}));
vi.mock('../../srv/server', () => serverMock);
vi.mock('../../srv/blockchain/signing/hsm-signer', () => ({ getHsmSigner: vi.fn(() => hsm) }));
vi.mock('../../srv/blockchain/signing/external-signer', () => ({ getExternalSignerModule: () => signer }));
vi.mock('../../srv/blockchain/signing/landing-proof', () => ({ sendProblem, isExpired: () => false, landingFacts: () => ({ inputs: [] }) }));
vi.mock('../../srv/blockchain/signing/submission-finalizer', () => ({ submitAndFinalize: vi.fn(), scheduleDeferredSubmit: vi.fn() }));
vi.mock('../../srv/cbor', () => ({ parseTransaction: () => ({ requiredSigners: ['ab'.repeat(28)], outputs: rows.body }) }));
vi.mock('#cds-models/odatano/cardano', () => ({ TransactionBuildOutputs: 'TransactionBuildOutputs' }));
vi.mock('#cds-models/CardanoSignService', () => ({
  SigningRequests: 'SigningRequests', AddressSigningRequests: 'AddressSigningRequests', TransactionBuilds: 'TransactionBuilds',
}));

import { getHsmSigner } from '../../srv/blockchain/signing/hsm-signer';

type Handler = (req: Record<string, unknown>) => Promise<unknown>;
let registerHandlers: (srv: unknown) => void;
beforeAll(async () => {
  const mod: any = await import('../../srv/cardano-sign-service');
  registerHandlers = mod.default ?? mod;
});

function boot(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerHandlers({ on: (event: string, h: Handler) => { handlers[event] = h; }, before: () => undefined, after: () => undefined });
  return handlers;
}

const req = (data: Record<string, unknown>, roles = ['HsmSigner']) => ({
  data, user: { id: 'alice', is: (r: string) => roles.includes(r) },
  // like CAP: req.reject(status, message) or req.reject({ status, code, message, target })
  reject: vi.fn((arg: number | { status: number; code?: string; message: string; target?: string }, msg?: string) => {
    if (typeof arg === 'object') throw Object.assign(new Error(arg.message), { statusCode: arg.status, code: arg.code, target: arg.target });
    throw Object.assign(new Error(msg), { code: arg });
  }),
});
/** The service requires its generated entities with require(), so they arrive as classes or as names. */
const nameOf = (entity: unknown): string => (typeof entity === 'string' ? entity : String((entity as { name?: unknown })?.name ?? ''));
const queries = (op: string) => fakeDb.run.mock.calls.map(([q]) => (q as { query: Query }).query).filter((q) => q.op === op);
const BUILD_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  rows.build = { id: BUILD_ID, senderAddress: 'addr_test1hsm', changeAddress: 'addr_test1hsm', unsignedTxCbor: 'u', txBodyHash: 'h', network: 'preview' };
  rows.request = undefined;
  rows.outputs = [
    { outputIndex: 0, address: 'addr_test1payee', isChange: false },
    { outputIndex: 1, address: 'addr_test1hsm', isChange: true },
  ];
  rows.body = [{ address: 'addr_test1payee' }, { address: 'addr_test1hsm' }];
  serverMock.getCardanoIndexer.mockReturnValue({
    persistSigningRequest: vi.fn(async () => ({ id: 'req-1' })),
    persistSignatureVerification: vi.fn(async () => ({ id: 'ver-1' })),
    indexVerifiedTransactionSubmission: vi.fn(async () => ({ id: 'sub-1' })),
  });
  sendProblem.mockReturnValue(null);
  fakeDb.run.mockImplementation(async (q: { query: Query }) => {
    const { op, entity } = q.query;
    if (op === 'UPDATE') return 1;
    if (nameOf(entity).endsWith('TransactionBuildOutputs')) return rows.outputs;
    if (nameOf(entity).endsWith('TransactionBuilds')) return rows.build;
    if (nameOf(entity).endsWith('SigningRequests')) return rows.request ?? { id: 'req-1', status: 'verified' };
    return undefined;
  });
});

describe('SignWithHsm', () => {
  it('refuses a caller without the HSM role with 403 ODATANO_FORBIDDEN', async () => {
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }, []))).rejects.toMatchObject({
      statusCode: 403, code: 'ODATANO_FORBIDDEN', message: "[ODATANO_FORBIDDEN] SignWithHsm: Action 'SignWithHsm' requires role 'HsmSigner'",
    });
    expect(hsm.signTransaction).not.toHaveBeenCalled();
  });

  it('answers 503 ODATANO_HSM_NOT_CONFIGURED without a connected HSM', async () => {
    vi.mocked(getHsmSigner).mockReturnValueOnce(null);
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toMatchObject({
      statusCode: 503, code: 'ODATANO_HSM_NOT_CONFIGURED', target: 'hsm',
      message: '[ODATANO_HSM_NOT_CONFIGURED] SignWithHsm: HSM is not configured or not connected',
    });
  });

  it('refuses a build whose change goes to another address', async () => {
    rows.build = { ...rows.build, changeAddress: 'addr_test1builder' };
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining("change address 'addr_test1builder' is not the HSM address"),
    });
    expect(hsm.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses a build whose stored change output goes to another address, as rc.50 stored it', async () => {
    // rc.50 wrote the sender as the build change address, but flagged the real change output
    rows.outputs[1] = { outputIndex: 1, address: 'addr_test1builder', isChange: true };
    rows.body[1] = { address: 'addr_test1builder' };
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toThrow(/change output 1 goes to 'addr_test1builder'/);
    expect(hsm.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses a build whose stored outputs differ from its unsigned transaction', async () => {
    rows.body[1] = { address: 'addr_test1builder' };
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toThrow(/does not match its transaction/);
    expect(hsm.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses a build that spends from another address', async () => {
    rows.build = { ...rows.build, senderAddress: 'addr_test1other' };
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toThrow(/does not match HSM address/);
  });

  it('verifies the HSM signature against the required signers of the build', async () => {
    await boot().SignWithHsm(req({ buildId: BUILD_ID }));

    expect(signer.verifySignedTransaction).toHaveBeenCalledWith('signed-cbor', 'h', { requiredSigners: expect.arrayContaining(['ab'.repeat(28)]) });
    expect(queries('UPDATE')).toContainEqual(expect.objectContaining({ set: { hsmKeyId: 'k1' } }));
  });

  it('rolls back when the signature does not cover the required signers', async () => {
    signer.verifySignedTransaction.mockReturnValueOnce({ isValid: false, witnessCount: 1, signerKeyHashes: ['k'], warnings: [] });
    await expect(boot().SignWithHsm(req({ buildId: BUILD_ID }))).rejects.toThrow(/HSM signature verification failed/);
  });
});

describe('SignAndSubmitWithHsm', () => {
  it('applies the same change address check before signing', async () => {
    rows.build = { ...rows.build, changeAddress: 'addr_test1builder' };
    const r = req({ buildId: BUILD_ID, deferSubmit: true });
    await expect(boot().SignAndSubmitWithHsm(r)).rejects.toBeDefined();
    // the handler answers typed errors through req.reject with their status and message
    expect(r.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringContaining('is not the HSM address') }));
    expect(hsm.signTransaction).not.toHaveBeenCalled();
  });
});

describe('SubmitVerifiedTransaction', () => {
  it('answers an expired request as expired before it reads the signed bytes', async () => {
    rows.request = { id: 'req-1', status: 'pending', expiresAt: '2000-01-01T00:00:00.000Z', build_id: BUILD_ID, unsignedTxCbor: 'u', txBodyHash: 'h' };
    // not a transaction: reading it would fail with a parse error instead
    const r = req({ signingRequestId: 'req-1', signedTxCbor: 'abcd', deferSubmit: true });

    await expect(boot().SubmitVerifiedTransaction(r)).rejects.toThrow(/Signing request has expired/);
  });

  it('answers a request in another state with its status before it reads the signed bytes', async () => {
    rows.request = { id: 'req-1', status: 'submitted', expiresAt: '2999-01-01T00:00:00.000Z', build_id: BUILD_ID, unsignedTxCbor: 'u', txBodyHash: 'h' };
    const r = req({ signingRequestId: 'req-1', signedTxCbor: 'abcd', deferSubmit: true });

    await expect(boot().SubmitVerifiedTransaction(r)).rejects.toThrow(/status is 'submitted'/);
  });
});

describe('CreateSigningRequest', () => {
  it('expires a stale pending request and hands out only one that is still valid', async () => {
    rows.request = { id: 'fresh', status: 'pending' };
    const answer = await boot().CreateSigningRequest(req({ buildId: BUILD_ID }));

    expect(answer).toEqual({ id: 'fresh', status: 'pending' });
    const [expire] = queries('UPDATE');
    expect(expire).toMatchObject({ set: { status: 'expired' }, where: { build_id: BUILD_ID, status: 'pending', expiresAt: { '<=': expect.any(String) } } });
    const lookup = queries('SELECT_ONE').find((q) => nameOf(q.entity).endsWith('SigningRequests'));
    expect(lookup?.where).toMatchObject({ build_id: BUILD_ID, status: 'pending', expiresAt: { '>': expect.any(String) } });
  });
});

describe('the send rules on the sign service submit paths', () => {
  it('SignAndSubmitWithHsm refuses signed bytes ODATANO will not send, before claiming the request', async () => {
    sendProblem.mockReturnValue('The transaction has no expiry (body key 3, TTL); set one, so its outcome can be decided');
    const r = req({ buildId: BUILD_ID, deferSubmit: true });
    await expect(boot().SignAndSubmitWithHsm(r)).rejects.toBeDefined();
    expect(r.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, message: expect.stringContaining('no expiry') }));
    expect(queries('UPDATE')).not.toContainEqual(expect.objectContaining({ set: expect.objectContaining({ status: 'submitting' }) }));
  });
});

describe('ResolveSigningRequest', () => {
  const unresolved = { id: 'req-1', status: 'unresolved', build_id: BUILD_ID, txBodyHash: 'a'.repeat(64), signedTxCbor: 'signed', signerType: 'cli', signerInfo: null };

  it('refuses a request that is not unresolved', async () => {
    rows.request = { ...unresolved, status: 'submitting' };
    await expect(boot().ResolveSigningRequest(req({ signingRequestId: 'req-1', outcome: 'failed' }))).rejects.toThrow(/only an unresolved request/);
  });

  it('refuses a txHash of another transaction', async () => {
    rows.request = unresolved;
    await expect(boot().ResolveSigningRequest(req({ signingRequestId: 'req-1', outcome: 'failed', txHash: 'f'.repeat(64) }))).rejects.toThrow(/is not the transaction of this record/);
  });

  it('fails the request and keeps the note', async () => {
    rows.request = unresolved;
    await boot().ResolveSigningRequest(req({ signingRequestId: 'req-1', outcome: 'failed', note: 'not on any explorer' }));
    expect(queries('UPDATE')).toContainEqual(expect.objectContaining({
      set: { status: 'failed', resolution: expect.stringMatching(/^failed by alice at .*: not on any explorer$/) },
      where: { id: 'req-1', status: 'unresolved' },
    }));
    expect(serverMock.getCardanoIndexer().indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('confirmed writes the submission record a submit writes, from the stored bytes', async () => {
    rows.request = unresolved;
    await boot().ResolveSigningRequest(req({ signingRequestId: 'req-1', outcome: 'confirmed', txHash: 'A'.repeat(64) }));
    expect(queries('UPDATE')).toContainEqual(expect.objectContaining({ set: expect.objectContaining({ status: 'submitted' }) }));
    expect(signer.verifyOrThrow).toHaveBeenCalledWith('signed', 'a'.repeat(64));
    expect(serverMock.getCardanoIndexer().indexVerifiedTransactionSubmission).toHaveBeenCalledWith(fakeDb,
      expect.objectContaining({ signingRequestId: 'req-1', buildId: BUILD_ID, fullSignedTxCbor: 'signed' }));
  });
});
