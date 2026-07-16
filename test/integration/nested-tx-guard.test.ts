/**
 * Integration tests for the detachedTx deadlock guard (KNOWN_ISSUES #11).
 *
 * Reproduces the FINCA shape: a consumer handler whose request transaction has
 * begun (first SELECT holds sqlite's single pooled connection) awaits
 * SubmitVerifiedTransaction in-process. Without the guard this hangs forever
 * (zero CPU); with the guard it fails fast with 503 ODATANO_NESTED_TX_TIMEOUT
 * and — critically — the orphaned late acquire must NOT claim the request
 * after the caller already saw the error.
 */

import cds from '@sap/cds';
// require() shares the native module graph with the booted CAP server
// (see signing-services.test.ts for the rationale).
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
import { TEST_FIXTURES } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks } from './mock-helpers';

const { INSERT, SELECT } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';
// Short guard budget so the deadlock test completes quickly.
process.env.ODATANO_DETACHED_TX_TIMEOUT_MS = '2000';

describe('detachedTx deadlock guard (KNOWN_ISSUES #11)', () => {
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
    testBuildId = 'test-build-nested';
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

  it('fails fast with 503 NESTED_TX_TIMEOUT instead of deadlocking when the caller holds the pooled connection', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    // Consumer shape: the ambient transaction begins on the first statement
    // and holds the single pooled connection across the awaited plugin call.
    const err: unknown = await cds.tx(async (tx: cds.Transaction) => {
      await tx.run(SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId }));
      return signSrv
        .send('SubmitVerifiedTransaction', {
          signingRequestId,
          signedTxCbor: TEST_FIXTURES.witnessSetCbor,
          signerType: 'browser-wallet',
          signerInfo: 'nested-call-test',
        })
        .then(() => null, (e: unknown) => e);
    });

    expect(err, 'expected the nested submit to fail instead of succeeding').to.not.equal(null);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).to.include('ODATANO_NESTED_TX_TIMEOUT');
    expect(message).to.include('KNOWN_ISSUES');
  });

  it('does not claim the signing request from the orphaned late acquire after the timeout', async () => {
    const signingRequestId = await createSigningRequest();
    const signSrv = await cds.connect.to('CardanoSignService');

    await cds.tx(async (tx: cds.Transaction) => {
      await tx.run(SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId }));
      await signSrv
        .send('SubmitVerifiedTransaction', { signingRequestId, signedTxCbor: TEST_FIXTURES.witnessSetCbor })
        .catch(() => undefined);
    });

    // The outer tx has committed and released the connection: the orphaned
    // acquire now gets its turn. The abort flag must make it roll back without
    // claiming — give it a moment, then verify.
    await new Promise((r) => setTimeout(r, 300));

    const row = await cds.run(
      SELECT.one.from('CardanoSignService.SigningRequests').where({ id: signingRequestId })
    ) as { status?: string };
    expect(row?.status).to.equal('pending');
  });

  it('keeps the non-nested in-process path working (consumer with detached reads)', async () => {
    const signingRequestId = await createSigningRequest();
    setupTxResponseMock();

    // FINCA-after-fix shape: reads happened in a committed tx that has already
    // released the connection; the plugin call runs with no ambient claim on it.
    const signSrv = await cds.connect.to('CardanoSignService');
    const result = await signSrv.send('SubmitVerifiedTransaction', {
      signingRequestId,
      signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      signerType: 'browser-wallet',
      signerInfo: 'detached-call-test',
    }) as { status?: string; txHash?: string };

    expect(result?.status).to.equal('submitted');
    expect(result).to.have.property('txHash');
  });
});
