/**
 * Integration tests for the deferred-submit path (KNOWN_ISSUES #11, Layer 2).
 *
 * deferSubmit: true lets an in-process consumer submit WITHOUT restructuring
 * its handler: verify + claim run on the caller's transaction (joining its
 * pooled connection — no deadlock), the action returns immediately with the
 * tx hash (= body hash), and the network submit runs detached after the
 * caller's commit. Interrupted submissions (claimed but never submitted) are
 * re-driven at boot from the persisted signed CBOR.
 */

import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext, getCardanoClient } from '../../srv/server';
import { TransactionAlreadySubmittedError, ProviderUnavailableError } from '../../srv/utils/errors';
import { redriveInterruptedSubmissions } from '../../srv/blockchain/signing/submission-finalizer';
import { TEST_FIXTURES } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks } from './mock-helpers';

const { INSERT, SELECT, UPDATE } = cds.ql;

jest.setTimeout(30000);

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

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

describe('deferred submit (KNOWN_ISSUES #11, Layer 2)', () => {
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
    jest.restoreAllMocks();
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

    // FINCA shape: the consumer's transaction has begun (SELECT holds the
    // pooled connection) — with deferSubmit this must NOT deadlock.
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

  it('marks the request failed when the deferred network submit fails', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    jest.spyOn(getCardanoClient(), 'submitTransaction')
      .mockRejectedValue(new ProviderUnavailableError('node down', 'koios'));

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

  it('re-drives an interrupted deferred submission at boot (idempotent via already-submitted)', async () => {
    const signingRequestId = await createSigningRequest();

    // Simulate the crash window: claimed on the deferred path (signed CBOR
    // persisted), process died before the detached submit ran. Produce the
    // combined CBOR by running the normal defer flow with a failing submit,
    // then reset the row to the interrupted state.
    const signSrv = await cds.connect.to('CardanoSignService');
    jest.spyOn(getCardanoClient(), 'submitTransaction')
      .mockRejectedValue(new ProviderUnavailableError('crash-window sim', 'koios'));
    await signSrv.send('SubmitVerifiedTransaction', {
      signingRequestId,
      signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      deferSubmit: true,
    });
    await waitForStatus(signingRequestId, ['failed']);
    jest.restoreAllMocks();

    const row = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { signedTxCbor?: string };
    expect(row?.signedTxCbor ?? '').to.not.equal('');

    // Reset to the interrupted state: 'submitting' with persisted CBOR
    await cds.run(
      UPDATE.entity('CardanoSignService.SigningRequests')
        .set({ status: 'submitting' })
        .where({ id: signingRequestId })
    );

    // Boot sweep: the node already holds the tx → finalize as submitted.
    jest.spyOn(getCardanoClient(), 'submitTransaction')
      .mockRejectedValue(new TransactionAlreadySubmittedError(TEST_FIXTURES.txBodyHash));
    const attempted = await redriveInterruptedSubmissions();
    expect(attempted).to.equal(1);

    const finalRow = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    expect(finalRow?.status).to.equal('submitted');
  });
});
