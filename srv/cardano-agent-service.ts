import cds from '@sap/cds';
import { registerAgentGrantHandlers } from './utils/agent-grants';

/**
 * CardanoAgentService handlers. Grant administration and token self-service live in
 * srv/utils/agent-grants.ts so the OData actions and the programmatic API share one path.
 * The token enforcement hook is attached to all services from src/plugin.ts, not here.
 */
module.exports = (srv: cds.Service) => {
  registerAgentGrantHandlers(srv);
};
