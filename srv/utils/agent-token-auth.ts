// A token on a service path runs as `agent:<grantId>` with role `agent-grant`. Other paths go to the delegate.
// Unknown tokens get 401, expired ones 410. Failed attempts are throttled per client address.

import cds from '@sap/cds';
import * as capAuth from '@odatano/cap-auth';
import { inLaneOf, requestPath, respondError, type TransportLane } from '@odatano/cap-auth';
import {
  AGENT_SERVICE_NAMES,
  AGENT_TOKEN_HEADER,
  makeAgentUser,
  resolveAgentToken,
  type AgentGrantRow,
} from './agent-grants';
import { RateLimiter } from './rate-limiter';

const tokenFailures = new RateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, maxKeys: 10_000 });

let servicePathsCache: string[] | null = null;
let servicePathsPinned = false;

/** Test seam: pin the service paths instead of reading `cds.services`. `null` resets. */
export function __setAgentServicePathsForTests(paths: string[] | null): void {
  servicePathsCache = paths;
  servicePathsPinned = paths !== null;
}

/** Forget throttle state and the path cache (tests). */
export function __resetAgentTokenLaneForTests(): void {
  tokenFailures.reset();
  servicePathsCache = null;
  servicePathsPinned = false;
}

/** Mount paths of the six services, read from `cds.services` once they are served. */
export function agentServicePaths(): string[] {
  if (servicePathsPinned && servicePathsCache) return servicePathsCache;
  if (servicePathsCache && servicePathsCache.length === AGENT_SERVICE_NAMES.length) return servicePathsCache;
  const services = (cds as unknown as { services?: Record<string, { name?: string; path?: string }> }).services ?? {};
  const paths = Object.values(services)
    .filter((s) => s && AGENT_SERVICE_NAMES.includes(String(s.name)) && typeof s.path === 'string')
    .map((s) => String(s.path).replace(/\/+$/, ''));
  servicePathsCache = paths;
  return paths;
}

/** Exact segment boundary: `/odata/v4/cardano` and below, never `/odata/v4/cardano-evil`. */
export function inAgentLane(path: string, servicePaths: string[] = agentServicePaths()): boolean {
  const bare = path.split('?')[0];
  return servicePaths.some((p) => inLaneOf(bare, p));
}

type LaneRequest = Parameters<TransportLane['authenticate']>[0];

// The login package's own reading of the client address and of `trustProxy`, so a token and a
// password are throttled per the same client. A release without `trustedProxyCount` has no proxy setting.
const clientAddressOf = capAuth.clientAddress as (req: LaneRequest, trustedProxies?: number) => string;
const proxyCountOf = (capAuth as { trustedProxyCount?: (value: unknown) => number }).trustedProxyCount;

function clientKey(req: LaneRequest): string {
  const trustProxy = (cds.env.requires as { auth?: { trustProxy?: unknown } }).auth?.trustProxy;
  return `ip=${clientAddressOf(req, proxyCountOf ? proxyCountOf(trustProxy) : 0)}:agent-token`;
}

export const agentTokenLane: TransportLane = {
  name: 'agent-token',
  match: (req) => typeof req.headers?.[AGENT_TOKEN_HEADER] === 'string' && (req.headers[AGENT_TOKEN_HEADER] as string).length > 0,
  authenticate: async (req, res) => {
    const token = req.headers[AGENT_TOKEN_HEADER] as string;
    if (!inAgentLane(requestPath(req))) return { next: true };
    const key = clientKey(req);
    // A token is 32 random bytes, so a valid one cannot be guessed: it passes even while its client
    // is locked, and other clients' failures never shut it out. A locked client gets 429 for any other.
    const resolution = await resolveAgentToken(token);
    if (!resolution.ok) {
      const locked = tokenFailures.peek(key);
      if (!locked.allowed) return respondError(res, 429, 'Too many failed agent token attempts', locked.retryAfterMs);
      const failed = tokenFailures.check(key);
      if (!failed.allowed) return respondError(res, 429, 'Too many failed agent token attempts', failed.retryAfterMs);
      return respondError(res, resolution.status, resolution.message);
    }
    (req as { agentGrant?: AgentGrantRow }).agentGrant = resolution.grant;
    return { user: makeAgentUser(resolution.grant) };
  },
};
