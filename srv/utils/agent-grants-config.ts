import cds from '@sap/cds';

/**
 * Agent-grant feature switch from `cds.requires.odatano-core.agentGrants`, else the environment
 * (AGENT_GRANTS_ENABLED, AGENT_GRANTS_DELEGATE, AGENT_GRANT_ADMIN_RATE_LIMIT). Own module because
 * src/plugin.ts reads it at plugin load, before any blockchain module is required.
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
 * Grant-administration calls per principal per hour: `agentGrants.adminRateLimit`, then
 * `AGENT_GRANT_ADMIN_RATE_LIMIT`, default 10. An unusable value is logged and falls back, never disables the feature.
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
 * How long the transport lane reuses a resolved grant row before re-reading the DB: `agentGrants.tokenCacheMs`,
 * then `AGENT_TOKEN_CACHE_MS`, default 10 s, 0 disables. Bounds how late a revoke on another replica takes effect.
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

/** A host-configured custom `cds.requires.auth.impl` (not this package's middleware); the lane wraps it. */
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
  // A host's own auth.impl becomes the delegate ("custom") unless configured otherwise.
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

/** Once-per-process marker on the `cds` singleton; a module-level flag would not survive a double load. */
const ACTIVATED = Symbol.for('odatano.agentGrants.activated');

/**
 * Switch agent grants on when configured: installs @odatano/cap-auth with the `x-agent-token` lane
 * (previous strategy kept as delegate) and attaches the enforcement hook to each service on `serving`.
 * Called from src/plugin.ts and srv/server.ts, before cds.server() builds middlewares. Never throws.
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
      // Host's own auth.impl stays as delegate. Absolute path: in plugin mode cds.root is the
      // consumer app, which need not resolve this package's dependency.
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
