import cds from '@sap/cds';
import { registerAgentGrantHandlers } from './utils/agent-grants';

// Handlers live in srv/utils/agent-grants.ts, shared with the programmatic API.
// The token enforcement hook is attached to all services in src/plugin.ts.
module.exports = (srv: cds.Service) => {
  registerAgentGrantHandlers(srv);
};
