import cds from '@sap/cds';

import { TEST_FIXTURES } from './test-fixtures';
import { setupKoiosMocks, nock } from './mock-helpers';
// Native require: must share the module graph of the cds.test()-booted CAP
// server, or the handlers never see the app context set by createTestContext.
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Skip server auto-init - mock tests create their own context after setting up nock mocks
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
delete process.env.OGMIOS_URL;
delete process.env.OGMIOS_WS_URL;
delete process.env.BLOCKFROST_API_KEY;

/**
 * Transaction submission through CardanoTransactionService against a nock-mocked Koios.
 */

describe('Transaction Submission Tests [MOCKED]', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  beforeAll(async () => {
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect(/localhost/);
    setupKoiosMocks();

    const testContext = await createTestContext(['koios']);
    resetAppContext(testContext);
  });

  beforeEach(async () => {
    await test.data.reset();
    nock.cleanAll();
    setupKoiosMocks();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    await shutdownAppContext();
  });

  describe('Koios Backend - TX Submission Mock', () => {
    it('SubmitSignedTransaction - successful submission without prior build', async () => {
      const scope = nock('https://preview.koios.rest')
        .post('/api/v1/submittx')
        .reply(200, TEST_FIXTURES.expectedTxHashCbor2);

      const submitResponse = await test.post(
        '/odata/v4/cardano-transaction/SubmitSignedTransaction',
        {
          signedTxCbor: TEST_FIXTURES.signedTxCbor2,
          network: TEST_FIXTURES.network,
        }
      );

      expect(submitResponse.status).to.equal(200);
      expect(submitResponse.data.txHash).to.equal(TEST_FIXTURES.expectedTxHashCbor2);
      expect(scope.isDone()).to.be.true;
    });

    it('SubmitTransaction - successful submission with prior build', async () => {

      const mockBuildId = 'test-build-123';
      const { INSERT } = cds.ql;
      const now = Date.now();
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
          id: mockBuildId,
          network: TEST_FIXTURES.network,
          senderAddress: TEST_FIXTURES.addressWithFunds,
          recipientAddress: TEST_FIXTURES.emptyAddress,
          lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
          changeAddress: TEST_FIXTURES.addressWithFunds,
          status: 'BUILT',
          unsignedTxCbor: 'mock_unsigned_tx_cbor',
          txBodyHash: TEST_FIXTURES.expectedTxHashCbor2,
          createdAt: now,
          validFrom: new Date(now).toISOString(),
          validTo: new Date(now + 300000).toISOString(),
        })
      );

      const scope = nock('https://preview.koios.rest')
        .post('/api/v1/submittx')
        .reply(200, TEST_FIXTURES.expectedTxHashCbor2);

      const submitResponse = await test.post(
        '/odata/v4/cardano-transaction/SubmitTransaction',
        {
          buildId: mockBuildId,
          signedTxCbor: TEST_FIXTURES.signedTxCbor2,
        }
      );

      expect(submitResponse.status).to.equal(200);
      expect(submitResponse.data).to.exist;
      expect(submitResponse.data.txHash).to.equal(TEST_FIXTURES.expectedTxHashCbor2);
      expect(submitResponse.data.build_id).to.equal(mockBuildId);
      expect(scope.isDone()).to.be.true;
    });

    // ============================================================================
    // Error Scenario Tests
    // ============================================================================

    describe('Error Scenarios', () => {

      it('SubmitSignedTransaction - should return 400 for invalid signature', async () => {
        const scope = nock('https://preview.koios.rest')
          .post('/api/v1/submittx')
          .reply(400, {
            error: 'Transaction validation failed: signature verification failed for input 0'
          });

        const { status, data } = await test.post(
          '/odata/v4/cardano-transaction/SubmitSignedTransaction',
          {
            signedTxCbor: TEST_FIXTURES.signedTxCbor2,
            network: TEST_FIXTURES.network,
          }
        ).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        expect(data.error.message).to.match(/validation failed|signature/i);
        expect(scope.isDone()).to.be.true;
      });

      it('SubmitSignedTransaction - should return 503 for network timeout', async () => {
        const scope = nock('https://preview.koios.rest')
          .post('/api/v1/submittx')
          .reply(503, {
            error: 'Service temporarily unavailable: timeout exceeded'
          });

        const { status, data } = await test.post(
          '/odata/v4/cardano-transaction/SubmitSignedTransaction',
          {
            signedTxCbor: TEST_FIXTURES.signedTxCbor2,
            network: TEST_FIXTURES.network,
          }
        ).catch(err => err.response);

        expect(status).to.equal(503);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        expect(data.error.message).to.match(/timeout|unavailable|failed/i);
        expect(scope.isDone()).to.be.true;
      });

      it('SubmitSignedTransaction - should return 409 for duplicate transaction', async () => {
        const scope = nock('https://preview.koios.rest')
          .post('/api/v1/submittx')
          .reply(400, {
            error: `Transaction ${TEST_FIXTURES.expectedTxHashCbor2} already exists in mempool`
          });

        const { status, data } = await test.post(
          '/odata/v4/cardano-transaction/SubmitSignedTransaction',
          {
            signedTxCbor: TEST_FIXTURES.signedTxCbor2,
            network: TEST_FIXTURES.network,
          }
        ).catch(err => err.response);

        expect(status).to.equal(409);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        expect(data.error.message).to.match(/already|exists|duplicate/i);
        expect(scope.isDone()).to.be.true;
      });

      it('SubmitSignedTransaction - should return 503 for backend unavailable', async () => {
        const scope = nock('https://preview.koios.rest')
          .post('/api/v1/submittx')
          .reply(502, {
            error: 'Bad Gateway: upstream connection refused'
          });

        const { status, data } = await test.post(
          '/odata/v4/cardano-transaction/SubmitSignedTransaction',
          {
            signedTxCbor: TEST_FIXTURES.signedTxCbor2,
            network: TEST_FIXTURES.network,
          }
        ).catch(err => err.response);

        expect(status).to.equal(503);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        expect(scope.isDone()).to.be.true;
      });

      it('SubmitSignedTransaction - should return 400 for malformed CBOR', async () => {
        const scope = nock('https://preview.koios.rest')
          .post('/api/v1/submittx')
          .reply(400, {
            error: 'Failed to deserialize transaction CBOR'
          });

        const { status, data } = await test.post(
          '/odata/v4/cardano-transaction/SubmitSignedTransaction',
          {
            signedTxCbor: TEST_FIXTURES.signedTxCbor2,
            network: TEST_FIXTURES.network,
          }
        ).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        expect(data.error.message).to.match(/validation|deserialize|malformed/i);
        expect(scope.isDone()).to.be.true;
      });
    });
  });
});
