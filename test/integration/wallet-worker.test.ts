/**
 * Integration tests for the wallet worker (v2.0).
 *
 * These cover exactly what the unit suites CANNOT reach, because they run the
 * real CAP server against the real SQLite schema:
 *
 *  - the **deployed** UNIQUE constraint on (walletId, kind, dedupKey). The unit
 *    tests simulate it in an in-memory fake, so dropping `@assert.unique.dedup`
 *    from db/schema.cds would leave every unit test green while idempotency —
 *    the thing that prevents a duplicate payment — silently disappears.
 *  - **real transactions**: insertJob runs on the caller's tx while the worker's
 *    transitions run in their own short ones (the two NIGHTGATE lessons). The
 *    unit fake has no transactions at all, so a commit-ordering or pooling bug
 *    is invisible there.
 *  - the **OData layer**: row-level @restrict, function-vs-action, real users.
 *
 * No network and no funds: the CardanoClient and the CardanoIndexer's build are
 * stubbed, and the dispatch loop is driven manually. Signing, confirmation depth
 * and reorgs against a live chain stay in scripts/testing/wallet-worker-e2e-preview.ts.
 */

import cds from '@sap/cds';
import { Cbor, CborArray, CborMap } from '@harmoniclabs/cbor';
import { toHex } from '@harmoniclabs/uint8array-utils';
// require() shares the native module graph with the booted CAP server
// (see signing-services.test.ts for the rationale).
const { createTestContext, resetAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
const { startWalletWorker, stopWalletWorker, getWalletWorker } =
  require('../../srv/blockchain/wallet-worker') as typeof import('../../srv/blockchain/wallet-worker');

const { SELECT, DELETE } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

const WALLET = 'itest-wallet';
const TX_HASH = 'a'.repeat(64);
import { TEST_FIXTURES } from './test-fixtures';
// A real preview address: with the server booted the validators are network-aware,
// so a placeholder would fail request preparation before the job ever builds.
const REQUEST = JSON.stringify({
  recipientAddress: TEST_FIXTURES.validBech32Address,
  lovelaceAmount: '2000000',
});

/**
 * The SIGNER is real (built from the configured key), so the build stub must return
 * something it can actually parse and merge a witness into: [ body(map), witnesses(map) ].
 */
const MINIMAL_UNSIGNED_TX = toHex(Cbor.encode(new CborArray([new CborMap([]), new CborMap([])])));

/** Build and submit are stubbed — this suite is about persistence, not chain I/O. */
function stubDeps() {
  const client = {
    network: 'preview',
    submitTransaction: vi.fn(async () => TX_HASH),
    getTransaction: vi.fn(async () => ({ hash: TX_HASH, blockHeight: 100, slot: 500 })),
    getLatestBlock: vi.fn(async () => ({ height: 100, slot: 500 })),
  };
  const indexer = {
    indexSimpleBuildResult: vi.fn(async () => ({
      id: 'build-1', unsignedTxCbor: MINIMAL_UNSIGNED_TX, txBodyHash: 'e'.repeat(64), fee: '170000',
    })),
    persistTransactionSubmission: vi.fn(async () => ({})),
  };
  return { client, indexer };
}

describe('wallet worker (integration: real CAP + real SQLite)', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;
  const { POST, GET } = test;

  const asAlice = { auth: { username: 'alice', password: '' } };
  const asBob = { auth: { username: 'bob', password: '' } };

  beforeAll(async () => {
    const ctx = await createTestContext(['koios']);
    resetAppContext(ctx);
  });

  beforeEach(async () => {
    await test.data.reset();
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from('odatano.cardano.CardanoWalletJobs'));
      await tx.run(DELETE.from('odatano.cardano.CardanoWorkerWallets'));
    });
    process.env.WALLET_WORKER_ENABLED = 'true';
    process.env.WALLET_WORKER_WALLETS =
      JSON.stringify([{ walletId: WALLET, signerType: 'software', keyEnv: 'ITEST_WALLET_KEY' }]);
    process.env.ITEST_WALLET_KEY = '7'.repeat(64);
    // Long poll interval: the tests drive tick() themselves so nothing races them.
    process.env.WALLET_WORKER_POLL_INTERVAL_MS = '600000';
    process.env.WALLET_WORKER_CONFIRMATION_DEPTH = '1';
  });

  afterEach(async () => {
    await stopWalletWorker();
    delete process.env.WALLET_WORKER_ENABLED;
    delete process.env.WALLET_WORKER_WALLETS;
    delete process.env.ITEST_WALLET_KEY;
  });

  /** Boot the worker with stubbed backends and return the handle for manual ticks. */
  async function startWorker(deps = stubDeps()) {
    const { loadWalletWorkerConfigFromEnv } = require('../../srv/server') as typeof import('../../srv/server');
    await startWalletWorker({
      client: deps.client as never,
      indexer: deps.indexer as never,
      network: 'preview',
      config: loadWalletWorkerConfigFromEnv(),
      instanceId: 'itest',
    });
    return deps;
  }

  const tick = async () => {
    const worker = getWalletWorker() as unknown as {
      tick: () => Promise<void>;
      executionPromises: Set<Promise<void>>;
    };
    await worker.tick();
    await Promise.allSettled([...worker.executionPromises]);
  };

  const jobRow = (id: string) =>
    cds.tx((tx) => tx.run(SELECT.one.from('odatano.cardano.CardanoWalletJobs').where({ ID: id })));

  // ---- the deployed constraint -------------------------------------------------

  it('enforces the idempotency constraint in the DATABASE, not just in the lookup', async () => {
    await startWorker();

    const key = 'invoice-1';
    const first = await POST('/odata/v4/cardano-worker/SubmitWalletJob',
      { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: key }, asAlice);
    expect(first.data.deduplicated).to.equal(false);

    // Bypass the read fast-path: insert a second row with the same claim directly.
    // The UNIQUE(walletId, kind, dedupKey) constraint must reject it.
    let rejected = false;
    try {
      await cds.tx((tx) => tx.run(
        cds.ql.INSERT.into('odatano.cardano.CardanoWalletJobs').entries({
          ID: cds.utils.uuid(), walletId: WALLET, kind: 'simpleAda', status: 'pending',
          idempotencyKey: key, dedupKey: key, request: REQUEST, attempt: 0, maxAttempts: 3,
        }),
      ));
    } catch {
      rejected = true;
    }
    expect(rejected, 'a duplicate (walletId, kind, dedupKey) must be rejected by the database').to.equal(true);

    const rows = await cds.tx((tx) => tx.run(SELECT.from('odatano.cardano.CardanoWalletJobs')));
    expect(rows).to.have.length(1);
  });

  it('returns the same job for a repeated idempotency key', async () => {
    await startWorker();
    const body = { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST, idempotencyKey: 'invoice-2' };

    const first = await POST('/odata/v4/cardano-worker/SubmitWalletJob', body, asAlice);
    const retry = await POST('/odata/v4/cardano-worker/SubmitWalletJob', body, asAlice);

    expect(retry.data.jobId).to.equal(first.data.jobId);
    expect(retry.data.deduplicated).to.equal(true);
  });

  // ---- real lifecycle against the real schema ---------------------------------

  it('runs a job through the real state machine and persists the artifacts', async () => {
    const deps = await startWorker();
    const { data } = await POST('/odata/v4/cardano-worker/SubmitWalletJob',
      { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST }, asAlice);

    await tick();

    const row = await jobRow(data.jobId) as Record<string, unknown>;
    // Diagnostic in the message: a job that never ran tells us why right here.
    expect(row.status, `job row after tick: ${JSON.stringify(row)}`).to.be.oneOf(['submitted', 'confirmed']);
    expect(deps.client.submitTransaction.mock.calls.length).to.be.greaterThan(0);
    // submitting persisted the signed tx BEFORE the submit; the tracker then confirms at depth 1
    expect(row.signedTxCbor, 'the signed tx must be durable').to.be.a('string');
    expect(row.txHash).to.be.a('string');
    expect(['submitted', 'confirmed']).to.include(row.status);
  });

  // ---- the OData layer --------------------------------------------------------

  it('shows a caller only their own jobs and hides foreign ones behind 404', async () => {
    await startWorker();
    const mine = await POST('/odata/v4/cardano-worker/SubmitWalletJob',
      { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST }, asAlice);

    const bobsList = await GET('/odata/v4/cardano-worker/WalletJobs', asBob);
    expect(bobsList.data.value.map((j: { ID: string }) => j.ID)).to.not.include(mine.data.jobId);

    const alicesList = await GET('/odata/v4/cardano-worker/WalletJobs', asAlice);
    expect(alicesList.data.value.map((j: { ID: string }) => j.ID)).to.include(mine.data.jobId);

    // Same 404 for "not yours" as for "does not exist" — no existence oracle.
    const foreign = await GET(`/odata/v4/cardano-worker/GetJobStatus(jobId=${mine.data.jobId})`, asBob)
      .catch((err: { response: { status: number } }) => err.response);
    expect(foreign.status).to.equal(404);
  });

  it('serves GetWorkerStatus and GetJobStatus as FUNCTIONS (GET, not POST)', async () => {
    await startWorker();
    const { data: submitted } = await POST('/odata/v4/cardano-worker/SubmitWalletJob',
      { walletId: WALLET, kind: 'simpleAda', requestJson: REQUEST }, asAlice);

    const status = await GET('/odata/v4/cardano-worker/GetWorkerStatus()', asAlice);
    expect(status.data.running).to.equal(true);
    expect(status.data.wallets).to.include(WALLET);

    const job = await GET(`/odata/v4/cardano-worker/GetJobStatus(jobId=${submitted.jobId})`, asAlice);
    expect(job.data.jobId).to.equal(submitted.jobId);

    // POSTing to a function is a 405 — the mistake the docs used to teach.
    const wrongVerb = await POST('/odata/v4/cardano-worker/GetWorkerStatus', {}, asAlice)
      .catch((err: { response: { status: number } }) => err.response);
    expect(wrongVerb.status).to.be.oneOf([404, 405]);
  });

  it('rejects a job for an unknown wallet without creating a row', async () => {
    await startWorker();

    const rejected = await POST('/odata/v4/cardano-worker/SubmitWalletJob',
      { walletId: 'nope', kind: 'simpleAda', requestJson: REQUEST }, asAlice)
      .catch((err: { response: { status: number; data: { error?: { message?: string } } } }) => err.response);
    expect(rejected.status).to.equal(400);
    expect(rejected.data.error?.message).to.match(/Unknown wallet/);

    const rows = await cds.tx((tx) => tx.run(SELECT.from('odatano.cardano.CardanoWalletJobs')));
    expect(rows).to.have.length(0);
  });
});
