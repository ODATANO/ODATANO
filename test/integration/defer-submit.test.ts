/**
 * Deferred submit: with deferSubmit the verify + claim run on the caller's transaction,
 * the action returns the tx hash at once and the network submit runs after the caller's
 * commit. A refused transaction ends as 'failed'. A submit without a verdict stays
 * 'submitting' and is resolved later from the persisted signed CBOR.
 */

import cds from '@sap/cds';
// Native require: shares the module graph with the booted CAP server.
const { createTestContext, resetAppContext, shutdownAppContext, getCardanoClient } =
  require('../../srv/server') as typeof import('../../srv/server');
const { TransactionAlreadySubmittedError, ProviderUnavailableError, TransactionValidationError, NotFoundError } =
  require('../../srv/utils/errors') as typeof import('../../srv/utils/errors');
const { redriveInterruptedSubmissions } =
  require('../../srv/blockchain/signing/submission-finalizer') as typeof import('../../srv/blockchain/signing/submission-finalizer');
import { TEST_FIXTURES } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks } from './mock-helpers';

const { INSERT, SELECT, UPDATE } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

/** Poll the signing request row until it leaves 'submitting' (deferred submit ran). */
async function waitForStatus(signingRequestId: string, expected: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const row = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    status = row?.status ?? '';
    if (expected.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return status;
}

/** The node refuses the transaction and no backend has it on chain. */
function refuseSubmit(reason: string) {
  vi.spyOn(getCardanoClient(), 'getTransaction').mockRejectedValue(new NotFoundError('Transaction', 'koios'));
  return vi.spyOn(getCardanoClient(), 'submitTransaction').mockRejectedValue(new TransactionValidationError(reason, undefined));
}

describe('deferred submit', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  let testBuildId: string;

  beforeAll(async () => {
    setupNocks();
    setupKoiosMocks();
    const testContext = await createTestContext(['koios']);
    resetAppContext(testContext);
  });

  beforeEach(async () => {
    await test.data.reset();
    setupNocks();
    setupKoiosMocks();

    const now = Date.now();
    testBuildId = 'test-build-defer';
    await cds.run(
      INSERT.into('CardanoSignService.TransactionBuilds').entries({
        id: testBuildId,
        network: TEST_FIXTURES.network,
        senderAddress: TEST_FIXTURES.addressWithFunds,
        unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
        txBodyHash: TEST_FIXTURES.txBodyHash,
        status: 'built',
        builderType: 'buildooor',
        createdAt: now,
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 300000).toISOString(),
      })
    );
  });

  afterEach(() => {
    resetKoiosMocks();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  async function createSigningRequest(): Promise<string> {
    const { data } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
      buildId: testBuildId,
    });
    return data.id as string;
  }

  it('nested consumer: returns txHash immediately, submits after the caller commits', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');
    setupTxResponseMock();

    // The consumer's transaction has begun (SELECT holds the pooled connection);
    // with deferSubmit this must not deadlock.
    const result = await cds.tx(async (tx: cds.Transaction) => {
      await tx.run(SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId }));
      return signSrv.send('SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        signerType: 'browser-wallet',
        signerInfo: 'defer-test',
        deferSubmit: true,
      }) as Promise<{ txHash?: string; status?: string }>;
    });

    expect(result?.txHash).to.equal(TEST_FIXTURES.txBodyHash);
    expect(result?.status).to.equal('pending');

    // The detached submit runs after the outer commit — wait for finalize.
    const status = await waitForStatus(signingRequestId, ['submitted', 'failed']);
    expect(status).to.equal('submitted');

    // Durable submission record exists
    const submission = await cds.run(
      SELECT.one.from('CardanoSignService.TransactionSubmissions').where({ build_id: testBuildId })
    ) as { status?: string; txHash?: string };
    expect(submission?.status).to.equal('submitted');
    expect(submission?.txHash).to.equal(TEST_FIXTURES.txBodyHash);
  });

  it('verification failure stays synchronous and leaves no stranded claim, even when the caller swallows it', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    // unsignedTxCbor carries no witnesses → verification must fail
    const err: unknown = await cds.tx(async (tx: cds.Transaction) => {
      await tx.run(SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId }));
      return signSrv
        .send('SubmitVerifiedTransaction', {
          signingRequestId,
          signedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          deferSubmit: true,
        })
        .then(() => null, (e: unknown) => e);   // caller swallows the error and COMMITS
    });

    expect(err, 'expected a synchronous verification error').to.not.equal(null);

    // Claim-last ordering: the swallowed failure must not leave 'submitting' behind.
    const row = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    expect(row?.status).to.equal('pending');
  });

  it('marks the request failed when the node refuses the deferred submit', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    refuseSubmit('ValueNotConserved');

    const result = await cds.tx(async (tx: cds.Transaction) => {
      await tx.run(SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId }));
      return signSrv.send('SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        deferSubmit: true,
      }) as Promise<{ status?: string }>;
    });
    expect(result?.status).to.equal('pending');   // action itself succeeded

    const status = await waitForStatus(signingRequestId, ['submitted', 'failed']);
    expect(status).to.equal('failed');            // durable although the caller succeeded
  });

  it('keeps the request submitting when the submit gets no verdict, and resolves it on the next pass', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    const lookup = vi.spyOn(getCardanoClient(), 'getTransaction')
      .mockRejectedValue(new NotFoundError('Transaction', 'koios'));
    const submit = vi.spyOn(getCardanoClient(), 'submitTransaction')
      .mockRejectedValue(new ProviderUnavailableError('node down', 'koios'));

    await signSrv.send('SubmitVerifiedTransaction', {
      signingRequestId,
      signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      deferSubmit: true,
    });

    // The deferred attempt ends with the chain lookup; give its cleanup a moment.
    const deadline = Date.now() + 8000;
    while (lookup.mock.calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));

    const open = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string; signedTxCbor?: string };
    expect(open?.status).to.equal('submitting');
    expect(open?.signedTxCbor).to.be.a('string').and.not.equal('');

    // The node is back: the same signed transaction goes out again.
    submit.mockResolvedValue(TEST_FIXTURES.txBodyHash);
    const attempted = await redriveInterruptedSubmissions();
    expect(attempted).to.equal(1);
    expect(submit.mock.calls.length).to.equal(2);

    const resolved = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    expect(resolved?.status).to.equal('submitted');
  });

  it('re-drives an interrupted deferred submission at boot (idempotent via already-submitted)', async () => {
    const signingRequestId = await createSigningRequest();

    // Simulate the crash window: claimed on the deferred path (signed CBOR
    // persisted), process died before the detached submit ran.
    const signSrv = await cds.connect.to('CardanoSignService');
    const fullSignedTxCbor = await (async () => {
      // Produce the combined CBOR the claim would have persisted by running
      // the normal defer flow with a submit the node refuses (row 'failed'),
      // then reset the row.
      refuseSubmit('crash-window sim');
      await signSrv.send('SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        deferSubmit: true,
      });
      await waitForStatus(signingRequestId, ['failed']);
      vi.restoreAllMocks();
      const row = await cds.run(
        SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
      ) as { signedTxCbor?: string };
      return row?.signedTxCbor ?? '';
    })();
    expect(fullSignedTxCbor).to.not.equal('');

    // Reset to the interrupted state: 'submitting' with persisted CBOR
    await cds.run(
      UPDATE.entity('CardanoSignService.SigningRequests')
        .set({ status: 'submitting' })
        .where({ id: signingRequestId })
    );

    // Boot sweep: the node already holds the tx → finalize as submitted.
    vi.spyOn(getCardanoClient(), 'submitTransaction')
      .mockRejectedValue(new TransactionAlreadySubmittedError(TEST_FIXTURES.txBodyHash));
    const attempted = await redriveInterruptedSubmissions();
    expect(attempted).to.equal(1);

    const row = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    expect(row?.status).to.equal('submitted');
  });
});
