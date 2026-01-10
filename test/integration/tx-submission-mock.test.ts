import cds from '@sap/cds';
import nock from 'nock';

jest.setTimeout(60000);
// Configure environment to use only Koios backend for these tests with mocks because it uses HTTP
process.env.BACKENDS = 'koios';
delete process.env.OGMIOS_URL;
delete process.env.OGMIOS_WS_URL;
delete process.env.BLOCKFROST_KEY;

/**
 * Transaction Submission Tests with Mocked Koios Backend
 * 
 * This test suite focuses on testing the transaction submission functionality of the CardanoTransactionService
 * using a mocked Koios backend via the nock library. It ensures that transaction submissions are handled correctly
 * without making real network calls.
 */

describe('Transaction Submission Tests [MOCKED]', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  const FIXTURE = {
    network: 'preview',
    validSenderAddress: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
    validRecipientAddress: 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622',
    lovelaceAmount: '5000000',
    // represents a real signed transaction CBOR (in hex) for testing
    signedTxCbor: '84a400818258205305281b2828b54252969df717d3050ddd81f61e2f62b3125eb326a258c76f78000182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a1011b000000025370c023021a00028d5d0f00a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584066b33b3bcaf0a5f908d83a13273d570d2d9fbbe240d917985d620fc5d24d3a9e7919426a00a960d10a7e430889eac4f16a55e6520f8804891e9fb9af443c010ef5f6',
    // tx hash corresponding to the above signedTxCbor
    expectedTxHash: '290c6b9abf9118cdc1fdcbdc6635f94ef0d414c1212c2c95b069a209d32b97cf',
  };

  beforeEach(async () => {
    await test.data.reset();
    
    // cleanup nock before each test to avoid interference
    nock.cleanAll();
    nock.restore();
    nock.activate();
    
    // Disable all real network connections except localhost (for CDS test server)
    nock.disableNetConnect();
    // Allow localhost (for CDS test server)
    nock.enableNetConnect(/localhost/);
  });

  afterEach(() => {
    // Cleanup after each test
    nock.cleanAll();
  });

  afterAll(() => {
    // final cleanup
    nock.cleanAll();
    nock.restore();
    nock.enableNetConnect(); // Re-enable normal network calls
    
    // Give the test server time to shut down
    return new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('Koios Backend - TX Submission Mock', () => {
    it('SubmitSignedTransaction - successful submission via Koios', async () => {
        // Mock Koios TX Submit
      const scope = nock('https://preview.koios.rest')
        .post('/api/v1/submit_tx', {
          _txs: [FIXTURE.signedTxCbor]
        })
        .reply(200, [
          { tx_hash: FIXTURE.expectedTxHash }
        ]);

      const submitResponse = await test.post(
        '/odata/v4/cardano-transaction/SubmitSignedTransaction',
        {
          signedTxCbor: FIXTURE.signedTxCbor,
          network: FIXTURE.network,
        }
      );

      expect(submitResponse.status).to.equal(200);
      expect(submitResponse.data.txHash).to.equal(FIXTURE.expectedTxHash);
      expect(scope.isDone()).to.be.true;
    });

    it('SubmitTransaction - successful submission with prior build', async () => {
      
      // create a mock transaction build in the database
      const mockBuildId = 'test-build-123';
      const { INSERT } = cds.ql;
      const now = Date.now();
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
          id: mockBuildId,
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
          status: 'BUILT',
          unsignedTxCbor: 'mock_unsigned_tx_cbor',
          createdAt: now,
          validFrom: new Date(now).toISOString(),
          validTo: new Date(now + 300000).toISOString(),
        })
      );

      // Mock Koios TX Submit
      const scope = nock('https://preview.koios.rest')
        .post('/api/v1/submit_tx', {
          _txs: [FIXTURE.signedTxCbor]
        })
        .reply(200, [
          { tx_hash: FIXTURE.expectedTxHash }
        ]);

      // Submit with Build ID
      const submitResponse = await test.post(
        '/odata/v4/cardano-transaction/SubmitTransaction',
        {
          buildId: mockBuildId,
          signedTxCbor: FIXTURE.signedTxCbor,
        }
      );

      expect(submitResponse.status).to.equal(200);
      expect(submitResponse.data.submissionRecord).to.exist;
      expect(submitResponse.data.submissionRecord.txHash).to.equal(FIXTURE.expectedTxHash);
      expect(submitResponse.data.submissionRecord.build_id).to.equal(mockBuildId);
      expect(scope.isDone()).to.be.true;
    });
  });
});
