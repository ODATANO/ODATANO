/**
 * The old read-service path `/odata/v4/cardano-odata` answers like `/odata/v4/cardano`
 * until the 2.0.0 release: same metadata, same refusal of an unknown agent token; a lookalike
 * path is not rewritten.
 */

import cds from '@sap/cds';
import { afterAll, describe, expect, it } from 'vitest';

process.env.AGENT_GRANTS_ENABLED = 'true';
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

cds.User.default = (cds.User as unknown as { Anonymous: typeof cds.User.default }).Anonymous;

(cds.env.requires as Record<string, unknown>).auth = {
  kind: 'basic',
  impl: '@odatano/cap-auth',
  realm: 'odatano',
  users: { odatano: { password: 'op-secret', roles: ['Admin'] } },
};

require('../../srv/server');

const cap = cds.test(__dirname + '/../../') as unknown as { url: string };
const operator = { authorization: 'Basic ' + Buffer.from('odatano:op-secret').toString('base64') };

describe('legacy service path', () => {
  afterAll(async () => {
    const { shutdownAppContext } = require('../../srv/server') as typeof import('../../srv/server');
    await shutdownAppContext();
  });

  it('serves the old path as the new one', async () => {
    const now = await fetch(`${cap.url}/odata/v4/cardano/$metadata`, { headers: operator });
    const old = await fetch(`${cap.url}/odata/v4/cardano-odata/$metadata`, { headers: operator });
    expect(now.status).toBe(200);
    expect(old.status).toBe(200);
    expect(await old.text()).toBe(await now.text());
  });

  it('refuses an unknown agent token on both paths alike', async () => {
    const headers = { 'x-agent-token': 'odat_' + 'a'.repeat(64) };
    const now = await fetch(`${cap.url}/odata/v4/cardano/Blocks`, { headers });
    const old = await fetch(`${cap.url}/odata/v4/cardano-odata/Blocks`, { headers });
    expect(old.status).toBe(now.status);
    expect(old.status).toBe(401);
  });

  it('does not rewrite a lookalike path', async () => {
    const res = await fetch(`${cap.url}/odata/v4/cardano-odata-x/$metadata`, { headers: operator });
    expect(res.status).toBe(404);
  });
});
