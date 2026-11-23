import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import { registerAgentGrantHandlers } from './utils/agent-grants';
import { answerNumbersAsText } from './utils/result-numbers';
import { loadAgentGrantsConfig } from './config';
import { rejectInvalid } from './utils/errors';

// Handlers live in srv/utils/agent-grants.ts, shared with the programmatic API.
// The token enforcement hook is attached to all services in src/plugin.ts.
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);
  // Grants issued while the feature is off would turn into live tokens once it is switched on.
  srv.before('*', (req: Request) => {
    if (!loadAgentGrantsConfig().enabled) {
      return rejectInvalid(req, String(req.event), 'Agent grants are not enabled: set cds.requires.odatano-core.agentGrants.enabled (or AGENT_GRANTS_ENABLED=true).');
    }
  });
  registerAgentGrantHandlers(srv);
};
