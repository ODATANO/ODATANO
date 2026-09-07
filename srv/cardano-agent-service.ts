import cds from '@sap/cds';
import { registerAgentGrantHandlers } from './utils/agent-grants';

/**
 * CardanoAgentService handlers — grant administration (Admin) and token
 * self-service. Everything lives in srv/utils/agent-grants.ts so the
 * programmatic API (`issueAgentGrant`, used by @odatano/x402 to sell grants) and
 * the OData actions share one code path.
 *
 * The enforcement hook for token requests is attached to all six services from
 * src/plugin.ts (cds.on('serving')), not here.
 */
module.exports = (srv: cds.Service) => {
  registerAgentGrantHandlers(srv);
};
