// Switches the agent grant feature on. src/plugin.ts calls it before any service module loads.
import cds from '@sap/cds';
import { AGENT_AUTH_IMPL, configuredAuth, customAuthImpl, loadAgentGrantsConfig } from '../config';

/** Once-per-process marker on the `cds` singleton; a module-level flag would not survive a double load. */
const ACTIVATED = Symbol.for('odatano.agentGrants.activated');

// Installs @odatano/cap-auth with the `x-agent-token` lane and keeps the old strategy as delegate.
// Must run before cds.server() builds middlewares. Never throws.
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
    if (!current.includes(AGENT_AUTH_IMPL)) {
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
