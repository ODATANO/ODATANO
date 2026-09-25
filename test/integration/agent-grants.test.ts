/**
 * Agent grants end to end against the real CAP server and SQLite: the transport lane,
 * Admin-only administration, token self-service, the enforcement hook (allow list,
 * wallet pinning, daily budget) and row-level narrowing.
 */

import cds from '@sap/cds';

// Read when srv/server.ts loads, so these must precede the require() below
// (imports are hoisted, require() is not).
process.env.AGENT_GRANTS_ENABLED = 'true';
process.env.AGENT_GRANTS_DELEGATE = 'mocked';
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

// require() shares the native module graph with the booted CAP server.
const { createTestContext, resetAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
const { __resetGrantRateLimiterForTests } =
  require('../../srv/utils/agent-grants') as typeof import('../../srv/utils/agent-grants');

const { DELETE, SELECT } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

import { TEST_FIXTURES } from './test-fixtures';

const WALLET = 'agent-wallet';
const REQUEST = JSON.stringify({ recipientAddress: TEST_FIXTURES.validBech32Address, lovelaceAmount: '2000000' });
const AGENT = '/odata/v4/cardano-agent';
const WORKER = '/odata/v4/cardano-worker';

type Axios = (path: string, ...rest: unknown[]) => Promise<{ status: number; data: any }>;

describe('agent grants (integration: real CAP + real SQLite)', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;
  const GET = test.GET as unknown as Axios;
  const POST = test.POST as unknown as Axios;

  // Requests without credentials run as cds.User.Privileged (test setup), which
  // passes every @requires — that is "the operator". bob is a plain mocked user.
  const asBob = { auth: { username: 'bob', password: '' } };
  const withToken = (token: string, extra: Record<string, unknown> = {}) => ({ headers: { 'x-agent-token': token }, ...extra });

  async function expectStatus(p: Promise<unknown>, status: number): Promise<any> {
    try {
      await p;
    } catch (err) {
      const e = err as { response?: { status: number; data: unknown } };
      expect(e.response?.status, `expected HTTP ${status}, got ${e.response?.status}: ${JSON.stringify(e.response?.data)}`).to.equal(status);
      return e.response?.data;
    }
    throw new Error(`expected HTTP ${status}, got a success`);
  }

  beforeAll(async () => {
    resetAppContext(await createTestContext(['koios']));
  });

  beforeEach(async () => {
    // Grant administration is limited to 10 per operator per hour; the suite
    // issues more than that, so every test starts with a fresh window.
    __resetGrantRateLimiterForTests();
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from('odatano.cardano.CardanoAgentGrantUsage'));
      await tx.run(DELETE.from('odatano.cardano.CardanoAgentGrants'));
      await tx.run(DELETE.from('odatano.cardano.CardanoWalletJobs'));
      await tx.run(DELETE.from('odatano.cardano.CardanoWorkerWallets'));
      await tx.run(cds.ql.INSERT.into('odatano.cardano.CardanoWorkerWallets').entries({
        walletId: WALLET, signerType: 'software', address: TEST_FIXTURES.validBech32Address,
        publicKeyHash: 'f'.repeat(56), enabled: true, jobsConfirmed: 0, jobsFailed: 0,
      }));
    });
    process.env.WALLET_WORKER_ENABLED = 'true';
    process.env.WALLET_WORKER_WALLETS =
      JSON.stringify([{ walletId: WALLET, signerType: 'software', keyEnv: 'AGENT_ITEST_WALLET_KEY' }]);
    process.env.AGENT_ITEST_WALLET_KEY = '7'.repeat(64);
  });

  afterEach(() => {
    delete process.env.WALLET_WORKER_ENABLED;
    delete process.env.WALLET_WORKER_WALLETS;
    delete process.env.AGENT_ITEST_WALLET_KEY;
  });

  async function issue(body: Record<string, unknown>) {
    const { data } = await POST(`${AGENT}/CreateAgentGrant`, body);
    return data as { grantId: string; token: string; allowedActions: string[] };
  }

  // ---- administration ---------------------------------------------------------

  it('is discoverable: the service document lists AgentGrants', async () => {
    const { data } = await GET(`${AGENT}/`);
    expect(data.value.map((v: { name: string }) => v.name)).to.include('AgentGrants');
  });

  it('lets only an Admin issue grants, returns the token once and stores its hash only', async () => {
    await expectStatus(POST(`${AGENT}/CreateAgentGrant`, { allowedActions: ['VerifySignature'] }, asBob), 403);

    const issued = await issue({ allowedActions: ['BuildSimpleAdaTransaction', 'SubmitWalletJob'], walletId: WALLET, maxJobsPerDay: 3, agentLabel: 'itest' });
    expect(issued.token).to.match(/^odat_[0-9a-f]{64}$/);

    const row = await cds.tx((tx) => tx.run(SELECT.one.from('odatano.cardano.CardanoAgentGrants').where({ ID: issued.grantId })));
    expect(row.tokenHash).to.have.lengthOf(64);
    expect(row.tokenHash).to.not.equal(issued.token);
    expect(row.walletId).to.equal(WALLET);

    // The projection never exposes the hash, and bob may not read it at all.
    const { data } = await GET(`${AGENT}/AgentGrants`);
    expect(data.value).to.have.lengthOf(1);
    expect(data.value[0]).to.not.have.property('tokenHash');
    await expectStatus(GET(`${AGENT}/AgentGrants`, asBob), 403);
  });

  it('refuses non-grantable actions and a wallet action without a wallet at creation', async () => {
    await expectStatus(POST(`${AGENT}/CreateAgentGrant`, { allowedActions: ['PauseWorker'] }), 400);
    await expectStatus(POST(`${AGENT}/CreateAgentGrant`, { allowedActions: ['SignWithHsm'] }), 400);
    await expectStatus(POST(`${AGENT}/CreateAgentGrant`, { allowedActions: ['SubmitWalletJob'] }), 400);
  });

  // ---- the token at work --------------------------------------------------------

  it('authenticates a token on the service paths and refuses unknown or revoked tokens', async () => {
    const issued = await issue({ allowedActions: ['VerifySignature'] });

    const { data: doc } = await GET('/odata/v4/cardano-odata/', withToken(issued.token));
    expect(doc.value).to.be.an('array');

    await expectStatus(GET('/odata/v4/cardano-odata/', withToken('odat_' + '0'.repeat(64))), 401);
    await expectStatus(GET('/odata/v4/cardano-odata/', withToken('nope')), 401);

    await POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId });
    await expectStatus(GET('/odata/v4/cardano-odata/', withToken(issued.token)), 401);
    await expectStatus(POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId }), 404);
  });

  it('sees its own grant only, and GetGrantStatus reports the allow list and budget', async () => {
    const mine = await issue({ allowedActions: ['VerifySignature'], maxJobsPerDay: 5, agentLabel: 'mine' });
    await issue({ allowedActions: ['VerifySignature'], agentLabel: 'other' });

    const { data: list } = await GET(`${AGENT}/AgentGrants`, withToken(mine.token));
    expect(list.value.map((g: { ID: string }) => g.ID)).to.deep.equal([mine.grantId]);

    const { data: status } = await GET(`${AGENT}/GetGrantStatus()`, withToken(mine.token));
    expect(status.grantId).to.equal(mine.grantId);
    expect(status.allowedActions).to.deep.equal(['VerifySignature']);
    expect(status.maxJobsPerDay).to.equal(5);
    expect(status.jobsUsedToday).to.equal(0);

    // An operator without a token is told to list the entity instead.
    await expectStatus(GET(`${AGENT}/GetGrantStatus()`), 400);
  });

  it('never inherits Admin: pause/resume, HSM signing and grant administration are refused', async () => {
    const issued = await issue({ allowedActions: ['VerifySignature'] });
    await expectStatus(POST(`${WORKER}/PauseWorker`, {}, withToken(issued.token)), 403);
    await expectStatus(POST('/odata/v4/cardano-indexer/pauseCrawler', {}, withToken(issued.token)), 403);
    // A well-formed payload (buildId, address): an unknown parameter would be a
    // 400 from CAP's input validation before any authorization check runs.
    await expectStatus(POST('/odata/v4/cardano-sign/SignWithHsm', { buildId: '00000000-0000-4000-8000-000000000000' }, withToken(issued.token)), 403);
    await expectStatus(POST(`${AGENT}/CreateAgentGrant`, { allowedActions: ['VerifySignature'] }, withToken(issued.token)), 403);
    await expectStatus(POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId }, withToken(issued.token)), 403);
  });

  it('refuses actions outside the allow list with 403 naming the action', async () => {
    const issued = await issue({ allowedActions: ['VerifySignature'] });
    const body = await expectStatus(
      POST('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction',
        { senderAddress: TEST_FIXTURES.validBech32Address, recipientAddress: TEST_FIXTURES.validBech32Address, lovelaceAmount: '2000000' },
        withToken(issued.token)),
      403
    );
    expect(JSON.stringify(body)).to.include('BuildSimpleAdaTransaction');
  });

  it('pins wallet jobs to the grant wallet, records them under the agent principal, and scopes reads to them', async () => {
    const issued = await issue({ allowedActions: ['SubmitWalletJob', 'CancelJob'], walletId: WALLET, allowedJobKinds: ['simpleAda'] });

    // Foreign wallet: refused. Absent wallet: injected.
    await expectStatus(POST(`${WORKER}/SubmitWalletJob`, { walletId: 'treasury', kind: 'simpleAda', requestJson: REQUEST }, withToken(issued.token)), 403);
    await expectStatus(POST(`${WORKER}/SubmitWalletJob`, { kind: 'mint', requestJson: REQUEST }, withToken(issued.token)), 403);
    const { data: job } = await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST }, withToken(issued.token));
    expect(job.status).to.equal('pending');

    const row = await cds.tx((tx) => tx.run(SELECT.one.from('odatano.cardano.CardanoWalletJobs').where({ ID: job.jobId })));
    expect(row.walletId).to.equal(WALLET);
    expect(row.createdBy).to.equal(`agent:${issued.grantId}`);

    // A job the operator queued is invisible to the token; its own job is visible.
    const { data: operatorJob } = await POST(`${WORKER}/SubmitWalletJob`, { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST });
    const { data: visible } = await GET(`${WORKER}/WalletJobs`, withToken(issued.token));
    expect(visible.value.map((j: { ID: string }) => j.ID)).to.deep.equal([job.jobId]);
    await expectStatus(GET(`${WORKER}/GetJobStatus(jobId=${operatorJob.jobId})`, withToken(issued.token)), 404);
    const { data: own } = await GET(`${WORKER}/GetJobStatus(jobId=${job.jobId})`, withToken(issued.token));
    expect(own.jobId).to.equal(job.jobId);

    // Cancel: own job yes, operator's job 404 (no existence oracle).
    await expectStatus(POST(`${WORKER}/CancelJob`, { jobId: operatorJob.jobId }, withToken(issued.token)), 404);
    const { data: cancelled } = await POST(`${WORKER}/CancelJob`, { jobId: job.jobId }, withToken(issued.token));
    expect(cancelled.value ?? cancelled).to.equal(true);
  });

  it('meters allow-listed calls per UTC day and answers 429 once the budget is spent', async () => {
    const issued = await issue({ allowedActions: ['SubmitWalletJob'], walletId: WALLET, maxJobsPerDay: 2 });
    await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'a' }, withToken(issued.token));
    await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'b' }, withToken(issued.token));
    await expectStatus(POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'c' }, withToken(issued.token)), 429);

    const { data: status } = await GET(`${AGENT}/GetGrantStatus()`, withToken(issued.token));
    expect(status.jobsUsedToday).to.equal(2);
    // Reads stay free.
    await GET(`${WORKER}/WalletJobs`, withToken(issued.token));
  });

  it('gives the unit back when the handler refuses the input', async () => {
    const issued = await issue({ allowedActions: ['SubmitWalletJob'], walletId: WALLET, maxJobsPerDay: 1 });
    // Invalid requestJson → 400 from the handler → refund.
    await expectStatus(POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: 'not json' }, withToken(issued.token)), 400);
    const { data: job } = await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST }, withToken(issued.token));
    expect(job.status).to.equal('pending');
  });

  it('keeps every existing surface unchanged for ordinary principals', async () => {
    const { data } = await GET(`${WORKER}/GetWorkerStatus()`);
    expect(data).to.have.property('running');
    await expectStatus(GET(`${AGENT}/AgentGrants`, asBob), 403);
  });

  // ---- lifecycle: rotate, update, usage ------------------------------------------

  const GRANTS = 'odatano.cardano.CardanoAgentGrants';
  const NOBODY = '00000000-0000-4000-8000-000000000000';

  it('rotates the token: the old one is unknown from the next request, the new one carries the same grant and budget', async () => {
    const issued = await issue({ allowedActions: ['VerifySignature'], maxJobsPerDay: 3 });
    await cds.tx((tx) => tx.run(cds.ql.UPDATE.entity(GRANTS).set({ budgetWindow: new Date().toISOString().slice(0, 10), jobsUsedToday: 2 }).where({ ID: issued.grantId })));

    const { data: rotated } = await POST(`${AGENT}/RotateAgentGrantToken`, { grantId: issued.grantId });
    expect(rotated.grantId).to.equal(issued.grantId);
    expect(rotated.token).to.match(/^odat_[0-9a-f]{64}$/);
    expect(rotated.token).to.not.equal(issued.token);

    await expectStatus(GET(`${AGENT}/GetGrantStatus()`, withToken(issued.token)), 401);
    const { data: status } = await GET(`${AGENT}/GetGrantStatus()`, withToken(rotated.token));
    expect(status.grantId).to.equal(issued.grantId);
    expect(Number(status.jobsUsedToday)).to.equal(2);

    // Admin only; never for a token; 404 once revoked.
    await expectStatus(POST(`${AGENT}/RotateAgentGrantToken`, { grantId: issued.grantId }, asBob), 403);
    await expectStatus(POST(`${AGENT}/RotateAgentGrantToken`, { grantId: issued.grantId }, withToken(rotated.token)), 403);
    await POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId });
    await expectStatus(POST(`${AGENT}/RotateAgentGrantToken`, { grantId: issued.grantId }), 404);
    await expectStatus(POST(`${AGENT}/RotateAgentGrantToken`, { grantId: NOBODY }), 404);
  });

  it('updates a grant partially, clears with an explicit null, keeps the wallet immutable, 404 unknown, 409 GRANT_REVOKED', async () => {
    const issued = await issue({
      allowedActions: ['BuildSimpleAdaTransaction', 'SubmitWalletJob'], walletId: WALLET, allowedJobKinds: ['simpleAda'], maxJobsPerDay: 3, agentLabel: 'before',
    });
    const row = () => cds.tx((tx) => tx.run(SELECT.one.from(GRANTS).where({ ID: issued.grantId })));

    // Absent parameters stay: only label and budget change.
    const { data: u } = await POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, agentLabel: 'after', maxJobsPerDay: 9 });
    expect(u.grantId).to.equal(issued.grantId);
    expect(u.updated).to.have.members(['agentLabel', 'maxJobsPerDay']);
    let r = await row();
    expect(r.agentLabel).to.equal('after');
    expect(Number(r.maxJobsPerDay)).to.equal(9);
    expect(JSON.parse(r.allowedJobKinds)).to.deep.equal(['simpleAda']);
    expect(r.walletId).to.equal(WALLET);

    // An explicit null clears; the token sees the new shape.
    await POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, allowedJobKinds: null, maxJobsPerDay: null });
    r = await row();
    expect(r.allowedJobKinds).to.equal(null);
    expect(r.maxJobsPerDay).to.equal(null);
    const { data: status } = await GET(`${AGENT}/GetGrantStatus()`, withToken(issued.token));
    expect(status.agentLabel).to.equal('after');
    expect(status.maxJobsPerDay).to.equal(null);

    // Merged-row validation and immutability.
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, allowedActions: [] }), 400);
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, allowedActions: ['PauseWorker'] }), 400);
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, validUntil: '2000-01-01T00:00:00Z' }), 400);
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, walletId: 'other' }), 400);
    expect((await row()).walletId).to.equal(WALLET);

    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, agentLabel: 'x' }, asBob), 403);
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, agentLabel: 'x' }, withToken(issued.token)), 403);
    await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: NOBODY, agentLabel: 'x' }), 404);

    await POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId });
    const body = await expectStatus(POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, agentLabel: 'x' }), 409);
    expect(body?.error?.code).to.equal('GRANT_REVOKED');
  });

  it('records usage per service and action, refunds a refused call, and narrows a token to its own grant', async () => {
    const issued = await issue({ allowedActions: ['SubmitWalletJob'], walletId: WALLET, maxJobsPerDay: 5 });
    await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'u1' }, withToken(issued.token));
    await POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'u2' }, withToken(issued.token));
    // Invalid requestJson → 400 from the handler → budget and usage unit refunded (off the request's tick).
    await expectStatus(POST(`${WORKER}/SubmitWalletJob`, { kind: 'simpleAda', requestJson: 'not json' }, withToken(issued.token)), 400);
    await new Promise((r) => setTimeout(r, 100));

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const usageUrl = (grantId: string) => `${AGENT}/GetGrantUsage(grantId=${grantId},since=${since},until=${until})`;

    const { data: usage } = await GET(usageUrl(issued.grantId));
    expect(usage.grantId).to.equal(issued.grantId);
    expect(usage.calls).to.deep.equal([{ service: 'CardanoWorkerService', action: 'SubmitWalletJob', count: 2, refunded: 1 }]);
    expect(Number(usage.total)).to.equal(2);
    expect(Number(usage.jobsUsedToday)).to.equal(2);
    expect(Number(usage.maxJobsPerDay)).to.equal(5);

    // Defaults: since/until may be left out (until = now, since = 30 days back).
    const { data: defaults } = await GET(`${AGENT}/GetGrantUsage(grantId=${issued.grantId})`);
    expect(Number(defaults.total)).to.equal(2);

    // The token: its own grant yes, a foreign one is not found, bob sees nothing, the window is capped.
    const { data: own } = await GET(usageUrl(issued.grantId), withToken(issued.token));
    expect(Number(own.total)).to.equal(2);
    const other = await issue({ allowedActions: ['VerifySignature'] });
    await expectStatus(GET(usageUrl(other.grantId), withToken(issued.token)), 404);
    await expectStatus(GET(usageUrl(issued.grantId), asBob), 403);
    await expectStatus(GET(usageUrl(NOBODY)), 404);
    await expectStatus(GET(`${AGENT}/GetGrantUsage(grantId=${issued.grantId},since=2020-01-01T00:00:00Z,until=${until})`), 400);

    // Revoked grants keep their history.
    await POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId });
    const { data: after } = await GET(usageUrl(issued.grantId));
    expect(Number(after.total)).to.equal(2);
  });

  it('applies the configurable admin rate limit to all four administration actions', async () => {
    process.env.AGENT_GRANT_ADMIN_RATE_LIMIT = '3';
    __resetGrantRateLimiterForTests();
    try {
      const issued = await issue({ allowedActions: ['VerifySignature'] });
      await POST(`${AGENT}/RotateAgentGrantToken`, { grantId: issued.grantId });
      await POST(`${AGENT}/UpdateAgentGrant`, { grantId: issued.grantId, agentLabel: 'third' });
      await expectStatus(POST(`${AGENT}/RevokeAgentGrant`, { grantId: issued.grantId }), 429);
      // Reads are not administration.
      const { data } = await GET(`${AGENT}/AgentGrants`);
      expect(data.value[0].isActive).to.equal(true);
    } finally {
      delete process.env.AGENT_GRANT_ADMIN_RATE_LIMIT;
      __resetGrantRateLimiterForTests();
    }
  });

  it('answers the liveness probe on the indexer service without touching backends', async () => {
    const { status, data } = await GET('/odata/v4/cardano-indexer/getLiveness()');
    expect(status).to.equal(200);
    expect(data.status).to.equal('alive');
    expect(data).to.include.keys('status', 'timestamp', 'uptime', 'version', 'network');
    expect(['preview', 'preprod', 'mainnet']).to.include(data.network);
    expect(data.version).to.equal(require('../../package.json').version);
    // A token may probe too (always-allowed, no budget).
    const issued = await issue({ allowedActions: ['VerifySignature'], maxJobsPerDay: 1 });
    const { data: viaToken } = await GET('/odata/v4/cardano-indexer/getLiveness()', withToken(issued.token));
    expect(viaToken.status).to.equal('alive');
  });
});
