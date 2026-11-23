/**
 * The agent-token throttle reads the client address the way the login package does, with the
 * `trustProxy` count of `cds.requires.auth`, so a password and a token are throttled per one client.
 */

const { capAuthCalls } = vi.hoisted(() => ({ capAuthCalls: [] as Array<{ trustedProxies: unknown }> }));

vi.mock('@odatano/cap-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@odatano/cap-auth')>();
  return {
    ...actual,
    // stands in for a release that reads trustProxy
    trustedProxyCount: (value: unknown) => Number(value ?? 0),
    clientAddress: (req: unknown, trustedProxies?: number) => {
      capAuthCalls.push({ trustedProxies });
      const forwarded = String((req as { headers?: Record<string, string> }).headers?.['x-forwarded-for'] ?? '').split(',').map(a => a.trim()).filter(Boolean);
      return trustedProxies && forwarded.length >= trustedProxies ? forwarded[forwarded.length - trustedProxies] : '10.0.0.1';
    },
  };
});

vi.mock('../../srv/utils/agent-grants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../srv/utils/agent-grants')>();
  return { ...actual, resolveAgentToken: vi.fn(async () => ({ ok: false, status: 401, message: 'invalid agent token' })) };
});

import cds from '@sap/cds';
import { __resetAgentTokenLaneForTests, __setAgentServicePathsForTests, agentTokenLane } from '../../srv/utils/agent-token-auth';
import { AGENT_TOKEN_HEADER } from '../../srv/utils/agent-grants';

function request(forwardedFor: string) {
  return {
    originalUrl: '/odata/v4/cardano/', url: '/odata/v4/cardano/', ip: '10.0.0.1', socket: { remoteAddress: '10.0.0.1' },
    headers: { [AGENT_TOKEN_HEADER]: 'odat_' + '0'.repeat(64), 'x-forwarded-for': forwardedFor },
  } as never;
}

function response() {
  const res = { statusCode: 200, headers: {} as Record<string, string>, status(c: number) { res.statusCode = c; return res; }, set: () => res, setHeader: () => undefined, json: () => undefined, end: () => undefined };
  return res as never as { statusCode: number };
}

const auth = (cds.env.requires as Record<string, unknown>);
let saved: unknown;
beforeEach(() => {
  __resetAgentTokenLaneForTests();
  __setAgentServicePathsForTests(['/odata/v4/cardano']);
  capAuthCalls.length = 0;
  saved = auth.auth;
});
afterEach(() => { auth.auth = saved; __resetAgentTokenLaneForTests(); });

describe('agent-token throttle key', () => {
  it('passes the configured trustProxy count to the login package', async () => {
    auth.auth = { kind: 'basic', trustProxy: 1 };
    await agentTokenLane.authenticate(request('198.51.100.7'), response() as never);
    expect(capAuthCalls).toEqual([{ trustedProxies: 1 }]);
  });

  it('behind one proxy, a guessing client locks only itself out', async () => {
    auth.auth = { kind: 'basic', trustProxy: 1 };
    for (let i = 0; i < 21; i++) await agentTokenLane.authenticate(request('198.51.100.7'), response() as never);
    const guesser = response();
    await agentTokenLane.authenticate(request('198.51.100.7'), guesser as never);
    expect(guesser.statusCode).toBe(429);
    const other = response();
    await agentTokenLane.authenticate(request('203.0.113.9'), other as never);
    expect(other.statusCode).toBe(401);
  });

  it('without trustProxy, the socket address is the key', async () => {
    auth.auth = { kind: 'basic' };
    await agentTokenLane.authenticate(request('198.51.100.7'), response() as never);
    expect(capAuthCalls).toEqual([{ trustedProxies: 0 }]);
  });
});
