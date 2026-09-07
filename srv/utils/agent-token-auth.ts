/**
 * Transport authentication with lanes: CAP's configured strategy PLUS an
 * `x-agent-token` lane (AGENT_GRANTS_DESIGN.md §3).
 *
 * CAP's auth middleware 401s a request without transport credentials before any
 * service hook runs, so an agent holding only an `odat_` token could never
 * reach a service. This middleware is installed as `cds.requires.auth.impl` by
 * src/plugin.ts when `odatano-core.agentGrants.enabled` is set, and:
 *
 *  - runs every registered LANE first. The built-in lane admits a request that
 *    carries `x-agent-token` on one of the six ODATANO service paths (exact
 *    segment match, no lookalike prefixes): the token is authenticated HERE
 *    (unknown 401, expired 410, non-leaking) and the request continues as the
 *    principal `agent:<grantId>` with the role `agent-grant`. The resolved grant
 *    rides on the express request (`req.agentGrant`) for the enforcement hook.
 *    Other packages (@odatano/x402) add lanes with `registerTransportLane`
 *    instead of fighting for the single `auth.impl` slot.
 *  - otherwise DELEGATES to CAP's own strategy for the configured kind
 *    (mocked/basic → basic-auth, jwt/xsuaa → jwt-auth, ias, dummy): behaviour
 *    for every request without a token is exactly what it was before.
 *
 * Failed token attempts are throttled per client address (20 per 15 minutes):
 * one static hash lookup must not become an offline-speed guessing oracle.
 */

import cds from '@sap/cds';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_SERVICE_NAMES,
  AGENT_TOKEN_HEADER,
  makeAgentUser,
  resolveAgentToken,
  type AgentGrantRow,
} from './agent-grants';
import { RateLimiter } from './rate-limiter';

type ExpressReq = IncomingMessage & {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  ip?: string;
  user?: unknown;
  agentGrant?: AgentGrantRow;
};
type ExpressRes = ServerResponse & {
  status?: (code: number) => ExpressRes;
  set?: (name: string, value: string) => ExpressRes;
  json?: (body: unknown) => void;
};
type Next = (err?: unknown) => void;
export type AuthMiddleware = (req: ExpressReq, res: ExpressRes, next: Next) => unknown;

/** What a lane's `authenticate` may answer. */
export type LaneOutcome =
  /** The lane authenticated the request; continue as this principal. */
  | { user: cds.User }
  /** The lane already sent a response (401/410/429); stop here. */
  | { handled: true }
  /** Not this lane's request after all; try the next lane, then the delegate. */
  | null;

export interface TransportLane {
  /** Unique name; registering the same name twice replaces the lane. */
  name: string;
  /** Cheap check on headers/path; no I/O. */
  match: (req: ExpressReq) => boolean;
  /** Authenticate; may respond itself. */
  authenticate: (req: ExpressReq, res: ExpressRes) => Promise<LaneOutcome>;
}

const lanes: TransportLane[] = [];

/** Add (or replace) a lane. Lanes run in registration order, the built-in agent-token lane first. */
export function registerTransportLane(lane: TransportLane): void {
  const i = lanes.findIndex((l) => l.name === lane.name);
  if (i >= 0) lanes[i] = lane;
  else lanes.push(lane);
}

/** Registered lane names, in order (tests, diagnostics). */
export function transportLanes(): string[] {
  return lanes.map((l) => l.name);
}

/** Remove every lane except the built-in one (tests). */
export function __resetTransportLanesForTests(): void {
  lanes.length = 0;
  tokenFailures.reset();
  servicePathsCache = null;
  servicePathsPinned = false;
}

/** Built-in CAP strategies by kind, same table as @sap/cds/lib/srv/middlewares/auth/index.js. */
const BUILTIN: Record<string, string> = {
  mocked: 'basic-auth',
  basic: 'basic-auth',
  ias: 'ias-auth',
  jwt: 'jwt-auth',
  xsuaa: 'jwt-auth',
  dummy: 'dummy-auth',
};

// ---------------------------------------------------------------------------
// Built-in lane: x-agent-token on the ODATANO service paths
// ---------------------------------------------------------------------------

const tokenFailures = new RateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, maxKeys: 10_000 });

let servicePathsCache: string[] | null = null;

let servicePathsPinned = false;

/** Test seam: pin the service paths instead of reading `cds.services`. `null` resets. */
export function __setAgentServicePathsForTests(paths: string[] | null): void {
  servicePathsCache = paths;
  servicePathsPinned = paths !== null;
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

function requestPath(req: ExpressReq): string {
  const raw = String(req.originalUrl || req.url || req.path || '');
  return raw.split('?')[0];
}

/** Exact segment boundary: `/odata/v4/cardano-odata` and below, never `/odata/v4/cardano-odata-evil`. */
export function inAgentLane(path: string, servicePaths: string[] = agentServicePaths()): boolean {
  return servicePaths.some((p) => path === p || path.startsWith(p + '/'));
}

function clientKey(req: ExpressReq): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return `ip=${String(ip).replace(/:/g, '.')}:agent-token`;
}

function respond(res: ExpressRes, status: number, message: string, retryAfterMs?: number): { handled: true } {
  if (retryAfterMs !== undefined) res.set?.('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  const body = { error: { code: String(status), message } };
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(status);
    res.json(body);
  } else {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }
  return { handled: true };
}

export const agentTokenLane: TransportLane = {
  name: 'agent-token',
  match: (req) => typeof req.headers?.[AGENT_TOKEN_HEADER] === 'string' && (req.headers[AGENT_TOKEN_HEADER] as string).length > 0,
  authenticate: async (req, res) => {
    const token = req.headers[AGENT_TOKEN_HEADER] as string;
    if (!inAgentLane(requestPath(req))) {
      // A token on any other path is not ours to admit; the delegate decides
      // (and will 401 a request that carries nothing else).
      return null;
    }
    const key = clientKey(req);
    const locked = tokenFailures.peek(key);
    if (!locked.allowed) return respond(res, 429, 'Too many failed agent token attempts', locked.retryAfterMs);

    const resolution = await resolveAgentToken(token);
    if (!resolution.ok) {
      const failed = tokenFailures.check(key);
      if (!failed.allowed) return respond(res, 429, 'Too many failed agent token attempts', failed.retryAfterMs);
      return respond(res, resolution.status, resolution.message);
    }
    req.agentGrant = resolution.grant;
    return { user: makeAgentUser(resolution.grant) };
  },
};

function ensureBuiltinLane(): void {
  if (!lanes.some((l) => l.name === agentTokenLane.name)) lanes.unshift(agentTokenLane);
}

// ---------------------------------------------------------------------------
// Factory (CAP calls it with the merged cds.requires.auth options)
// ---------------------------------------------------------------------------

interface AuthOptions {
  kind?: string;
  impl?: string;
  /** Set by activateAgentGrants: the strategy that keeps authenticating non-token requests. */
  agentGrantsDelegate?: string;
  /**
   * Set by activateAgentGrants when the host had its own `auth.impl` before us:
   * that module (path as configured, resolved like CAP does it) is the delegate,
   * whatever `kind` says. The host's gate keeps running for every non-token
   * request, on every path.
   */
  agentGrantsDelegateImpl?: string;
  [key: string]: unknown;
}

/** Load CAP's own middleware for `kind`; exported so the wrapper can be unit-tested with a stub. */
/**
 * Resolve a host-configured `auth.impl` the way CAP's auth factory does
 * (@sap/cds/lib/srv/middlewares/auth/index.js): as a module relative to
 * cds.root, else with a `./` prefix. Exported for the unit tests.
 */
export function resolveCustomImpl(impl: string, root: string = String((cds as unknown as { root?: string }).root ?? process.cwd())): string {
  try {
    return require.resolve(impl, { paths: [root] });
  } catch {
    return require.resolve(`./${impl}`, { paths: [root] });
  }
}

function asMiddleware(loaded: unknown, delegateOptions: AuthOptions, what: string): AuthMiddleware {
  // default export of an ESM / .ts module
  const candidate = (loaded as { default?: unknown })?.default ?? loaded;
  const mw = typeof candidate === 'function' && (candidate as (o: unknown) => unknown).length < 3
    ? (candidate as (o: unknown) => unknown)(delegateOptions)
    : candidate;
  if (typeof mw !== 'function') {
    throw new Error(`agent-token-auth: ${what} did not yield a middleware function`);
  }
  return mw as AuthMiddleware;
}

export function loadDelegate(options: AuthOptions, kind: string): AuthMiddleware {
  // The delegate must not see our impl (it would recurse) nor our private keys.
  const delegateOptions: AuthOptions = { ...options };
  delete delegateOptions.impl;
  delete delegateOptions.agentGrantsDelegate;
  delete delegateOptions.agentGrantsDelegateImpl;

  // A host that brought its own auth.impl keeps it: whatever it enforced
  // before agent grants were switched on, it still enforces for every request
  // that does not carry a token, on every path.
  const custom = options.agentGrantsDelegateImpl;
  if (custom) {
    const resolved = resolveCustomImpl(custom);
    return asMiddleware(require(resolved) as unknown, { ...delegateOptions, impl: custom }, `custom auth impl '${custom}'`);
  }

  const builtin = BUILTIN[kind.replace(/-auth$/, '')];
  if (!builtin) throw new Error(`agent-token-auth: no built-in CAP auth strategy for kind '${kind}'`);
  // Same module CAP itself would have loaded for this kind. Pinned by the
  // @sap/cds peer dependency; the self-test in asMiddleware fails fast if the shape moves.
  const factory = require(`@sap/cds/lib/srv/middlewares/auth/${builtin}`) as unknown;
  return asMiddleware(factory, { ...delegateOptions, kind }, `CAP auth strategy '${builtin}'`);
}

export function createAgentTokenAuth(options: AuthOptions, delegate?: AuthMiddleware): AuthMiddleware {
  const delegateKind = String(options.agentGrantsDelegate ?? options.kind ?? 'mocked');
  const inner = delegate ?? loadDelegate(options, delegateKind);
  ensureBuiltinLane();
  const delegateLabel = options.agentGrantsDelegateImpl ? `custom impl ${options.agentGrantsDelegateImpl}` : `'${delegateKind}'`;
  cds.log('AgentGrants').info(`agent-token transport lane active, delegating other requests to ${delegateLabel}`);

  return async function agentTokenAuth(req, res, next) {
    for (const lane of lanes) {
      if (!lane.match(req)) continue;
      let outcome: LaneOutcome;
      try {
        outcome = await lane.authenticate(req, res);
      } catch (err) {
        cds.log('AgentGrants').error(`transport lane '${lane.name}' failed: ${String((err as Error)?.message ?? err)}`);
        respond(res, 500, 'authentication lane failed');
        return;
      }
      if (outcome === null) continue;
      if ('handled' in outcome) return;
      req.user = outcome.user;
      const ctx = (cds as unknown as { context?: { user?: unknown } }).context;
      if (ctx) ctx.user = outcome.user;
      return next();
    }
    return inner(req, res, next);
  };
}

/**
 * CAP requires this module and, seeing a function with fewer than three
 * parameters, calls it with the merged auth options to obtain the middleware.
 */
export default function agentTokenAuthFactory(options: AuthOptions): AuthMiddleware {
  return createAgentTokenAuth(options);
}
