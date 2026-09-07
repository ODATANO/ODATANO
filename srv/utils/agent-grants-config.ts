import cds from '@sap/cds';
import path from 'path';

/**
 * Agent-grant feature switch. Read from `cds.requires.odatano-core.agentGrants`
 * first, then from the environment; kept in its own tiny module because
 * src/plugin.ts reads it at plugin load, before any blockchain module may be
 * required.
 *
 *   cds:  "odatano-core": { "agentGrants": { "enabled": true, "delegate": "mocked" } }
 *   env:  AGENT_GRANTS_ENABLED=true  AGENT_GRANTS_DELEGATE=mocked|basic|jwt|xsuaa|ias|dummy
 *
 * `delegate` names the CAP auth strategy that keeps authenticating every
 * request WITHOUT an `x-agent-token` header (the transport lane only adds the
 * token path next to it). Default: the configured `cds.requires.auth.kind`.
 */
export interface AgentGrantsConfig {
  enabled: boolean;
  /** CAP auth kind the transport middleware delegates to for non-token requests. */
  delegate: string;
}

export const AGENT_GRANTS_DELEGATES: readonly string[] = ['mocked', 'basic', 'jwt', 'xsuaa', 'ias', 'dummy'];

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

/** Our own middleware module, recognisable in `auth.impl` so activation stays idempotent. */
const OUR_IMPL = 'agent-token-auth';

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
  return { enabled, delegate };
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
 *  - the transport auth becomes srv/utils/agent-token-auth, which admits the
 *    `x-agent-token` header on the six service paths and delegates every other
 *    request to the strategy that was configured before (kept as the delegate);
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
      const original = customAuthImpl(auth);
      (cds.env.requires as Record<string, unknown>).auth = {
        ...auth,
        kind: auth.kind ?? agentGrants.delegate,
        impl: path.join(__dirname, OUR_IMPL),
        agentGrantsDelegate: agentGrants.delegate,
        ...(original ? { agentGrantsDelegateImpl: original } : {})
      };
    }
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
