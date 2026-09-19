/**
 * The image's transport auth end to end: @odatano/cap-auth's contract table
 * against the real CAP server with `kind: basic`, the operator user and the
 * `x-agent-token` lane (an unknown token is refused by the lane, without a
 * basic challenge). Every guarded path is a lane path, so the contract's
 * off-lane row is skipped. No network: nothing is initialized.
 */

import cds from '@sap/cds';
import { runTransportAuthContract } from '@odatano/cap-auth/contract';

process.env.AGENT_GRANTS_ENABLED = 'true';
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

// The test setup makes credential-free requests privileged; this suite is
// about exactly those requests.
cds.User.default = (cds.User as unknown as { Anonymous: typeof cds.User.default }).Anonymous;

(cds.env.requires as Record<string, unknown>).auth = {
  kind: 'basic',
  impl: '@odatano/cap-auth',
  realm: 'odatano',
  basicThrottle: { maxFailures: 4 },
  users: { odatano: { password: 'op-secret', roles: ['Admin'] } },
};

// require() shares the native module graph with the booted CAP server; it
// activates agent grants (and registers the lane) before CAP builds its
// middlewares.
require('../../srv/server');

const cap = cds.test(__dirname + '/../../') as unknown as { url: string };

runTransportAuthContract({
  url: () => cap.url,
  kind: 'basic',
  anonymousPath: '/odata/v4/cardano-indexer/getLiveness()',
  authenticatedPath: '/odata/v4/cardano-odata',
  operator: { user: 'odatano', password: 'op-secret' },
  realm: 'odatano',
  maxFailures: 4,
  lane: {
    header: 'x-agent-token',
    value: 'odat_' + 'a'.repeat(64),
    insidePath: '/odata/v4/cardano-odata/Blocks',
    insideStatus: 401,
  },
});
