/**
 * The `x-agent-token` lane (AGENT_GRANTS_DESIGN.md §3) inside the
 * @odatano/cap-auth middleware with a stub delegate: a token on the six
 * service paths is authenticated here, everything else is the delegate's.
 * Token resolution is stubbed at the module boundary; its own tests live in
 * agent-grants.test.ts.
 */

const { grantsMock } = vi.hoisted(() => ({
  grantsMock: {
    resolveAgentToken: vi.fn(async (_token: string): Promise<unknown> => ({ ok: false, status: 401, message: 'invalid agent token' })),
  },
}));

vi.mock('../../srv/utils/agent-grants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../srv/utils/agent-grants')>();
  return { ...actual, resolveAgentToken: grantsMock.resolveAgentToken };
});

import cds from '@sap/cds';
import path from 'node:path';
import { createTransportAuth, registerTransportLane, transportLanes, __resetTransportLanesForTests, type AuthMiddleware } from '@odatano/cap-auth';
import {
  __resetAgentTokenLaneForTests,
  __setAgentServicePathsForTests,
  agentTokenLane,
  inAgentLane,
} from '../../srv/utils/agent-token-auth';
import { AGENT_ROLE, AGENT_TOKEN_HEADER, AGENT_TOKEN_PREFIX, type AgentGrantRow } from '../../srv/utils/agent-grants';

const SERVICE_PATHS = [
  '/odata/v4/cardano-odata',
  '/odata/v4/cardano-transaction',
  '/odata/v4/cardano-sign',
  '/odata/v4/cardano-worker',
  '/odata/v4/cardano-indexer',
  '/odata/v4/cardano-agent',
];

const GRANT: AgentGrantRow = {
  ID: '11111111-1111-4111-8111-111111111111',
  userId: 'alice',
  allowedActions: '["BuildSimpleAdaTransaction"]',
  walletId: null,
  isActive: true,
};

function fakeReq(url: string, headers: Record<string, string> = {}, ip = '10.0.0.1') {
  return { originalUrl: url, url, headers, ip, socket: { remoteAddress: ip } } as unknown as Parameters<AuthMiddleware>[0] & {
    user?: unknown; agentGrant?: AgentGrantRow;
  };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    set(name: string, value: string) { res.headers[name] = value; return res; },
    json(body: unknown) { res.body = body; },
    setHeader(name: string, value: string) { res.headers[name] = value; },
    end(body?: string) {
      if (!body) { res.body = undefined; return; }
      try { res.body = JSON.parse(body); } catch { res.body = body; }
    },
  };
  return res as unknown as Parameters<AuthMiddleware>[1] & typeof res;
}

const TOKEN = AGENT_TOKEN_PREFIX + 'a'.repeat(64);

let delegate: ReturnType<typeof vi.fn>;
let auth: AuthMiddleware;

beforeEach(() => {
  __resetTransportLanesForTests();
  __resetAgentTokenLaneForTests();
  __setAgentServicePathsForTests(SERVICE_PATHS);
  grantsMock.resolveAgentToken.mockReset();
  grantsMock.resolveAgentToken.mockResolvedValue({ ok: false, status: 401, message: 'invalid agent token' });
  delegate = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  registerTransportLane(agentTokenLane);
  auth = createTransportAuth({ kind: 'mocked' }, delegate as unknown as AuthMiddleware);
});

describe('inAgentLane', () => {
  it('matches the service root and paths below it, never lookalike prefixes', () => {
    expect(inAgentLane('/odata/v4/cardano-odata', SERVICE_PATHS)).toBe(true);
    expect(inAgentLane('/odata/v4/cardano-odata/Blocks', SERVICE_PATHS)).toBe(true);
    expect(inAgentLane('/odata/v4/cardano-odata?$top=1', SERVICE_PATHS)).toBe(true);
    expect(inAgentLane('/odata/v4/cardano-agent/GetGrantStatus()', SERVICE_PATHS)).toBe(true);
    expect(inAgentLane('/odata/v4/cardano-odata-evil/Blocks', SERVICE_PATHS)).toBe(false);
    expect(inAgentLane('/odata/v4/other', SERVICE_PATHS)).toBe(false);
    expect(inAgentLane('/', SERVICE_PATHS)).toBe(false);
  });
});

describe('agent-token lane', () => {
  it('runs after the built-in basic lane', () => {
    expect(transportLanes()).toEqual(['agent-token']);
    expect((auth as unknown as { lanes: readonly string[] }).lanes).toEqual(['basic', 'agent-token']);
  });

  it('delegates a request without the header untouched', async () => {
    const req = fakeReq('/odata/v4/cardano-odata/Blocks');
    const next = vi.fn();
    await auth(req, fakeRes(), next);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(grantsMock.resolveAgentToken).not.toHaveBeenCalled();
  });

  it('admits a valid token on a service path as agent:<grantId> and parks the grant on the request', async () => {
    grantsMock.resolveAgentToken.mockResolvedValue({ ok: true, grant: GRANT });
    const req = fakeReq('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', { [AGENT_TOKEN_HEADER]: TOKEN });
    const next = vi.fn();
    await auth(req, fakeRes(), next);
    expect(delegate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const user = req.user as cds.User;
    expect(user.id).toBe(`agent:${GRANT.ID}`);
    expect(user.is(AGENT_ROLE)).toBe(true);
    expect(user.is('Admin')).toBe(false);
    expect(req.agentGrant).toBe(GRANT);
  });

  it('answers 401 for an unknown token and 410 for an expired grant, and never calls the delegate', async () => {
    const res401 = fakeRes();
    await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }), res401, vi.fn());
    expect(res401.statusCode).toBe(401);
    expect((res401.body as { error: { message: string } }).error.message).toBe('invalid agent token');
    expect(res401.headers['WWW-Authenticate']).toBeUndefined();

    grantsMock.resolveAgentToken.mockResolvedValue({ ok: false, status: 410, message: 'agent grant expired' });
    const res410 = fakeRes();
    await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }), res410, vi.fn());
    expect(res410.statusCode).toBe(410);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('leaves a token on a foreign path to the delegate', async () => {
    const req = fakeReq('/odata/v4/somebody-else/Things', { [AGENT_TOKEN_HEADER]: TOKEN });
    await auth(req, fakeRes(), vi.fn());
    expect(grantsMock.resolveAgentToken).not.toHaveBeenCalled();
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('throttles failed token attempts per client address (20 per window), then 429 even for a valid token', async () => {
    for (let i = 0; i < 20; i++) {
      await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }, '10.0.0.9'), fakeRes(), vi.fn());
    }
    grantsMock.resolveAgentToken.mockResolvedValue({ ok: true, grant: GRANT });
    const res = fakeRes();
    await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }, '10.0.0.9'), res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    const other = fakeRes();
    const next = vi.fn();
    await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }, '10.0.0.10'), other, next);
    expect(next).toHaveBeenCalled();
  });

  it('turns a lane crash into a 500, not an unauthenticated pass-through', async () => {
    grantsMock.resolveAgentToken.mockRejectedValue(new Error('db gone'));
    const res = fakeRes();
    const next = vi.fn();
    await auth(fakeReq('/odata/v4/cardano-odata/', { [AGENT_TOKEN_HEADER]: TOKEN }), res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
  });

  it('wrong basic credentials never reach the token lane', async () => {
    __resetTransportLanesForTests();
    registerTransportLane(agentTokenLane);
    const withUsers = createTransportAuth({ kind: 'basic', users: { op: { password: 'pw' } } }, delegate as unknown as AuthMiddleware);
    grantsMock.resolveAgentToken.mockResolvedValue({ ok: true, grant: GRANT });
    const res = fakeRes();
    const next = vi.fn();
    await withUsers(fakeReq('/odata/v4/cardano-odata/', { authorization: 'Basic ' + Buffer.from('op:wrong').toString('base64'), [AGENT_TOKEN_HEADER]: TOKEN }), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(grantsMock.resolveAgentToken).not.toHaveBeenCalled();
  });
});

describe('a host with its own auth.impl keeps it as the delegate', () => {
  // The fixture rejects everything without x-host-key. Before agent grants were
  // switched on it answered 401 to such requests; it must still do so after,
  // on ODATANO paths and on foreign ones: the lane only adds the token path.
  const options = { kind: 'mocked', delegateImpl: 'test/fixtures/custom-auth.cjs', hostKey: 'sesame' };

  beforeEach(() => {
    (cds as unknown as { root: string }).root = path.resolve(__dirname, '../..');
  });

  it('runs the custom gate for every non-token request', async () => {
    const wrapped = createTransportAuth(options);

    const refused = fakeRes();
    const next1 = vi.fn();
    await wrapped(fakeReq('/odata/v4/cardano-odata/Blocks'), refused, next1);
    expect(refused.statusCode).toBe(401);
    expect(next1).not.toHaveBeenCalled();

    const foreign = fakeRes();
    const next2 = vi.fn();
    await wrapped(fakeReq('/somewhere/else'), foreign, next2);
    expect(foreign.statusCode).toBe(401);
    expect(next2).not.toHaveBeenCalled();

    const admitted = fakeReq('/odata/v4/cardano-odata/Blocks', { 'x-host-key': 'sesame' });
    const next3 = vi.fn();
    await wrapped(admitted, fakeRes(), next3);
    expect(next3).toHaveBeenCalledTimes(1);
    expect((admitted.user as { id: string }).id).toBe('host-user');
  });

  it('still admits a valid agent token on the service paths in front of the custom gate', async () => {
    grantsMock.resolveAgentToken.mockResolvedValue({ ok: true, grant: GRANT });
    const wrapped = createTransportAuth(options);
    const req = fakeReq('/odata/v4/cardano-agent/GetGrantStatus()', { [AGENT_TOKEN_HEADER]: TOKEN });
    const next = vi.fn();
    await wrapped(req, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req.user as cds.User).id).toBe(`agent:${GRANT.ID}`);
  });
});
