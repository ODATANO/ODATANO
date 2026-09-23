import cds from '@sap/cds';

/**
 * Agent-grant feature switch. Read from `cds.requires.odatano-core.agentGrants`
 * first, then from the environment; kept in its own tiny module because
 * src/plugin.ts reads it at plugin load, before any blockchain module may be
 * required.
 *
 *   cds:  "odatano-core": { "agentGrants": { "enabled": true, "delegate": "mocked", "adminRateLimit": 10 } }
 *   env:  AGENT_GRANTS_ENABLED=true  AGENT_GRANTS_DELEGATE=mocked|basic|jwt|xsuaa|ias|dummy
 *         AGENT_GRANT_ADMIN_RATE_LIMIT=10
 *
 * `delegate` names the CAP auth strategy that keeps authenticating every
 * request WITHOUT an `x-agent-token` header (the transport lane only adds the
 * token path next to it). Default: the configured `cds.requires.auth.kind`.
 *
 * `adminRateLimit` is the number of grant-administration calls
 * (CreateAgentGrant, UpdateAgentGrant, RotateAgentGrantToken, RevokeAgentGrant)
 * one principal may make per hour; NIGHTGATE's `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT`.
 * A gateway that mints for everybody (ODATANO ACCESS) raises it.
 */
export interface AgentGrantsConfig {
  enabled: boolean;
  /** CAP auth kind the transport middleware delegates to for non-token requests. */
  delegate: string;
  /** Grant administration calls per principal per hour (integer >= 1). */
  adminRateLimit: number;
}

export const AGENT_GRANTS_DELEGATES: readonly string[] = ['mocked', 'basic', 'jwt', 'xsuaa', 'ias', 'dummy'];

export const AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT = 10;

/**
 * The admin rate limit: `agentGrants.adminRateLimit`, then
 * `AGENT_GRANT_ADMIN_RATE_LIMIT`, default 10. An unusable value (not an
 * integer, below 1) is logged once and falls back to the default — a typo in
 * this knob must not switch the whole feature off, unlike a wrong delegate.
 */
export function loadGrantAdminRateLimit(env: Record<string, string | undefined> = process.env): number {
  const cfg = envRecord();
  const raw = cfg.adminRateLimit !== undefined ? cfg.adminRateLimit : env.AGENT_GRANT_ADMIN_RATE_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    cds.log('ODATANO').warn(
      `AGENT_GRANT_ADMIN_RATE_LIMIT "${String(raw)}" is not an integer >= 1; using ${AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT}`
    );
    return AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT;
  }
  return n;
}

export const AGENT_TOKEN_CACHE_MS_DEFAULT = 10_000;

/**
 * How long the transport lane may reuse a resolved token (the grant row) before
 * it reads the database again: `agentGrants.tokenCacheMs`, then
 * `AGENT_TOKEN_CACHE_MS`, default 10 s, 0 switches the cache off. Seconds, not
 * minutes, on purpose: a busy grant sends many requests per second, so a few
 * seconds already spare almost every lookup, while a revoke on ANOTHER replica
 * is honoured at most this much later (on the same process it is immediate).
 * An unusable value (not an integer, below 0) is logged once and falls back.
 */
export function loadTokenCacheMs(env: Record<string, string | undefined> = process.env): number {
  const cfg = envRecord();
  const raw = cfg.tokenCacheMs !== undefined ? cfg.tokenCacheMs : env.AGENT_TOKEN_CACHE_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return AGENT_TOKEN_CACHE_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    cds.log('ODATANO').warn(`AGENT_TOKEN_CACHE_MS "${String(raw)}" is not an integer >= 0; using ${AGENT_TOKEN_CACHE_MS_DEFAULT}`);
    return AGENT_TOKEN_CACHE_MS_DEFAULT;
  }
  return n;
}

function envRecord(): Record<string, unknown> {
  const requires = (cds.env?.requires ?? {}) as Record<string, unknown>;
  const core = (requires['odatano-core'] ?? {}) as Record<string, unknown>;
  return (core.agentGrants ?? {}) as Record<string, unknown>;
}

/** The configured `cds.requires.auth` as an object (the shorthand `"auth": "xsuaa"` is a string). */
export function configuredAuth(): Record<string, unknown> {
  const auth = (cds.env?.requires as Record<string, unknown> | undefined)?.auth;
  if (typeof auth === 'string') return { kind: auth };
  return (auth ?? {}) as Record<string, unknown>;
}

/** The transport middleware, recognisable in `auth.impl` so activation stays idempotent. */
const OUR_IMPL = 'cap-auth';

/**
 * A custom `cds.requires.auth.impl` the host configured before us (anything
 * that is not this package's middleware). It keeps authenticating every
 * non-token request: the lane wraps it instead of replacing it.
 */
export function customAuthImpl(auth: Record<string, unknown> = configuredAuth()): string | null {
  const impl = typeof auth.impl === 'string' ? auth.impl.trim() : '';
  if (!impl || impl.includes(OUR_IMPL)) return null;
  return impl;
}

export function loadAgentGrantsConfig(env: Record<string, string | undefined> = process.env): AgentGrantsConfig {
  const cfg = envRecord();
  const enabledRaw = cfg.enabled !== undefined ? cfg.enabled : env.AGENT_GRANTS_ENABLED;
  const enabled = enabledRaw === true || String(enabledRaw ?? '').toLowerCase() === 'true';

  const auth = configuredAuth();
  const authKind = String(auth.kind ?? 'mocked');
  // A host with its own auth.impl keeps it as the delegate ("custom") unless
  // an explicit delegate says otherwise.
  const fallback = customAuthImpl(auth) ? 'custom' : authKind;
  const delegateRaw = String(cfg.delegate ?? env.AGENT_GRANTS_DELEGATE ?? fallback);
  // `xsuaa-auth` / `basic-auth` spellings are what CAP itself accepts as kinds.
  const delegate = delegateRaw.replace(/-auth$/, '');
  if (enabled && delegate !== 'custom' && !AGENT_GRANTS_DELEGATES.includes(delegate)) {
    throw new Error(
      `Invalid agentGrants.delegate "${delegateRaw}". Must be one of: ${AGENT_GRANTS_DELEGATES.join(', ')}, custom`
    );
  }
  if (enabled && delegate === 'custom' && !customAuthImpl(auth)) {
    throw new Error('agentGrants.delegate "custom" needs a custom cds.requires.auth.impl to delegate to');
  }
  return { enabled, delegate, adminRateLimit: loadGrantAdminRateLimit(env) };
}

/**
 * Marker on the shared `cds` facade: the activation below must run exactly once
 * per process even though this module can be loaded twice (natively by CAP /
 * src/plugin.ts and again through a test runner's transform). A module-level
 * flag would not survive that; the `cds` singleton does.
 */
const ACTIVATED = Symbol.for('odatano.agentGrants.activated');

/**
 * Switch agent grants on for this process when configured. Called from BOTH
 * entry points, because CAP loads `cds-plugin.js` only from a project's
 * dependencies, never from the project itself:
 *  - src/plugin.ts at plugin load (consumer app), and
 *  - srv/server.ts at module load (standalone `cds serve` / `cds watch`, where
 *    bin/serve.js imports the local server.js BEFORE cds.server() builds its
 *    middlewares — the last moment `cds.requires.auth.impl` can still change).
 *
 * When enabled:
 *  - the transport auth becomes @odatano/cap-auth (unless the host runs it
 *    already) with the `x-agent-token` lane of srv/utils/agent-token-auth
 *    registered; every other request goes to the strategy that was configured
 *    before (CAP's own for `kind`, or the host's custom impl as `delegateImpl`);
 *  - each of the six services gets the enforcement hook once it is served.
 *
 * Never throws: a misconfiguration is logged and the feature stays off, so a
 * host app never fails to start because of it. Returns whether grants are on.
 */
export function activateAgentGrants(): boolean {
  const facade = cds as unknown as Record<symbol, boolean | undefined>;
  if (facade[ACTIVATED] !== undefined) return facade[ACTIVATED] === true;
  const logger = cds.log('ODATANO');
  try {
    const agentGrants = loadAgentGrantsConfig();
    if (!agentGrants.enabled) {
      facade[ACTIVATED] = false;
      return false;
    }
    const auth = configuredAuth();
    const current = typeof auth.impl === 'string' ? auth.impl : '';
    if (!current.includes(OUR_IMPL)) {
      // A host's own auth.impl is preserved as the delegate: the lane only adds
      // the token path in front of it, it never replaces the host's gate.
      // The absolute path: in plugin mode cds.root is the consumer app, which
      // need not resolve this package's dependency.
      const original = customAuthImpl(auth);
      (cds.env.requires as Record<string, unknown>).auth = {
        ...auth,
        kind: agentGrants.delegate === 'custom' ? auth.kind : agentGrants.delegate,
        impl: require.resolve('@odatano/cap-auth'),
        ...(original ? { delegateImpl: original } : {})
      };
    }
    const { registerTransportLane } = require('@odatano/cap-auth') as typeof import('@odatano/cap-auth');
    const { agentTokenLane } = require('./agent-token-auth') as typeof import('./agent-token-auth');
    registerTransportLane(agentTokenLane);
    cds.on('serving', (srv) => {
      const { AGENT_SERVICE_NAMES, attachAgentGrantEnforcement } =
        require('./agent-grants') as typeof import('./agent-grants');
      if (AGENT_SERVICE_NAMES.includes(srv.name)) attachAgentGrantEnforcement(srv);
    });
    facade[ACTIVATED] = true;
    logger.info(`Agent grants enabled (transport delegate: ${agentGrants.delegate})`);
    return true;
  } catch (err) {
    facade[ACTIVATED] = false;
    logger.error('Agent grants not enabled:', err instanceof Error ? err.message : err);
    return false;
  }
}
