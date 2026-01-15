import cds, { build } from '@sap/cds';
import { TxBuilderTestConfig, configureTxBuilderForTest } from './backend-test-helper';
import { response } from 'express';
import { sign } from 'crypto';
import { isTxHash } from '../../srv/utils/validators';

const { SELECT } = cds.ql;
jest.setTimeout(60000);

/**
 * Cardano Transaction Service Integration Tests
 * 
 * Tests the transaction building and submission functionality
 * across different transaction builders (Buildooor, CSL)
 */

// Helper function to create test suite for a specific transaction builder
export function createTxServiceTestSuite(txBuilderConfig: TxBuilderTestConfig) {
  // Configure environment to use this specific transaction builder
  configureTxBuilderForTest(txBuilderConfig);

  describe(`Cardano Transaction Service Tests [${txBuilderConfig.name.toUpperCase()}]`, () => {
    // Initialize the test suite
    const test = cds.test(__dirname + '/../../');
    const expect = test.expect;

    // Test data fixtures for preview network
    const FIXTURE = {
      network: 'preview',
      validSenderAddress: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
      validRecipientAddress: 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622',
      lovelaceAmount: '5000000', // 5 ADA (minimum UTxO requirement is ~2.66 ADA)
      invalidAddress: 'invalid_address',
      invalidLovelaceAmount: 'not_a_number',
    };

    // Reset the database before each test to ensure a clean state
    beforeEach(async () => {
      await test.data.reset();
    });

    // ============================================================================
    // Entity READ Tests
    // ============================================================================

    describe('Entity READ Operations', () => {
      it('GET /TransactionBuilds - read TransactionBuilds collection', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds');
        expect(status).to.equal(200);
        expect(data).to.have.property('value');
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('GET /TransactionBuildInputs - read TransactionBuildInputs collection', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuildInputs');
        expect(status).to.equal(200);
        expect(data).to.have.property('value');
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('GET /TransactionBuildOutputs - read TransactionBuildOutputs collection', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuildOutputs');
        expect(status).to.equal(200);
        expect(data).to.have.property('value');
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('GET /TransactionSubmissions - read TransactionSubmissions collection', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionSubmissions');
        expect(status).to.equal(200);
        expect(data).to.have.property('value');
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('GET /TransactionSubmissionErrors - read TransactionSubmissionErrors collection', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionSubmissionErrors');
        expect(status).to.equal(200);
        expect(data).to.have.property('value');
        expect(Array.isArray(data.value)).to.be.true;
      });
    });

    // ============================================================================
    // BuildSimpleAdaTransaction Action Tests
    // ============================================================================

    describe('BuildSimpleAdaTransaction Action', () => {
      it('POST /BuildSimpleAdaTransaction - successfully build ADA transaction', async () => {
        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
        
        expect(status).to.equal(200);
        expect(data).to.have.property('id'); // Build ID
        expect(data).to.have.property('unsignedTxCbor');
        expect(data).to.have.property('txBodyHash'); // Transaction body hash
        expect(data.network).to.equal(FIXTURE.network);
        expect(data.wasSubmitted).to.equal(false);
      });

      it('POST /BuildSimpleAdaTransaction - verify build is persisted in DB', async () => {
        const TxService = await cds.connect.to('CardanoTransactionService');
        const { TransactionBuilds } = TxService.entities;

        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        // Build transaction
        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
        expect(status).to.equal(200);

        // Verify persisted in DB
        const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
        expect(builds.length).to.equal(1);
        expect(builds[0].id).to.equal(data.id);
        expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
      });

      it('POST /BuildSimpleAdaTransaction - missing network parameter', async () => {
        const requestBody = {
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
        };

        const response = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
        expect(response.status).to.equal(400);
      });

      it('POST /BuildSimpleAdaTransaction - missing senderAddress parameter', async () => {
        const requestBody = {
          network: FIXTURE.network,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
        };

        const response = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
        expect(response.status).to.equal(400);
      });

      it('POST /BuildSimpleAdaTransaction - missing recipientAddress parameter', async () => {
        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
        };

        const response = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
        expect(response.status).to.equal(400);
      });

      it('POST /BuildSimpleAdaTransaction - invalid sender address format', async () => {
        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.invalidAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
        };

        const response = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
        expect(response.status).to.equal(400);
      });

      it('POST /BuildSimpleAdaTransaction - with inputs and outputs', async () => {
        const TxService = await cds.connect.to('CardanoTransactionService');
        const { TransactionBuildInputs, TransactionBuildOutputs } = TxService.entities;

        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
        expect(status).to.equal(200);

        // Verify inputs are persisted
        const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
        expect(inputs.length).to.be.greaterThan(0);

        // Verify outputs are persisted
        const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
        expect(outputs.length).to.be.greaterThan(0);
        
        // Should have at least 1 output (recipient)
        const recipientOutput = outputs.find((o: any) => o.address === FIXTURE.validRecipientAddress);
        expect(recipientOutput).to.exist;
        expect(recipientOutput.lovelace).to.equal(Number(FIXTURE.lovelaceAmount));
      });

      it('POST /BuildSimpleAdaTransaction - without change address (fallback to sender)', async () => {
        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          // No changeAddress provided - should default to senderAddress
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
        
        expect(status).to.equal(200);
        expect(data).to.have.property('id');
        expect(data).to.have.property('unsignedTxCbor');
        expect(data).to.have.property('txBodyHash');

        // Verify the transaction was built successfully
        const TxService = await cds.connect.to('CardanoTransactionService');
        const { TransactionBuildOutputs } = TxService.entities;
        const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
        
        // Should have at least recipient output
        const recipientOutput = outputs.find((o: any) => o.address === FIXTURE.validRecipientAddress);
        expect(recipientOutput).to.exist;
      });

      it('POST /BuildSimpleAdaTransaction - build transaction without assertions', async () => {
        const requestBody = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
        
        // Just verify the transaction builds successfully without detailed assertions
        expect(status).to.equal(200);
        expect(data.id).to.exist;
      });
    });

    // ============================================================================
    // GetBuildDetails Action Tests
    // ============================================================================

    describe('GetBuildDetails Action', () => {
      it('POST /GetBuildDetails - retrieve build details by buildId', async () => {
        // First, build a transaction
        const buildRequest = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        const buildResponse = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest);
        expect(buildResponse.status).to.equal(200);
        const buildId = buildResponse.data.id;

        // Now retrieve build details
        const { status, data } = await test.post('/odata/v4/cardano-transaction/GetBuildDetails', { buildId });
        
        expect(status).to.equal(200);
        expect(data.id).to.equal(buildId);
        expect(data).to.have.property('unsignedTxCbor');
        expect(data).to.have.property('txBodyHash');
      });

      it('POST /GetBuildDetails - missing buildId parameter', async () => {
        const response = await test.post('/odata/v4/cardano-transaction/GetBuildDetails', {}).catch(err => err.response);
        expect(response.status).to.equal(400);
      });

      it('POST /GetBuildDetails - non-existent buildId', async () => {
        const response = await test.post('/odata/v4/cardano-transaction/GetBuildDetails', {
          buildId: '00000000-0000-0000-0000-000000000000',
        }).catch(err => err.response);
        expect(response.status).to.equal(400);
      });
    });

    describe('CheckSubmissionStatus Action', () => {
      it('POST /CheckSubmissionStatus Action', async () => {
        // Verify the transaction was built successfully
        const TxService = await cds.connect.to('CardanoTransactionService');
        const { TransactionSubmissions } = TxService.entities;

        // save a dummy submission to check status
        const submission = await cds.run(INSERT.into(TransactionSubmissions).entries({
          id: '12345678-1234-1234-1234-1234567890ab',
          signedTxCbor: 'dummycbor',
          txHash: 'dummyhash',
          status: 'pending',
          validFrom: new Date(),
          validTo: new Date(Date.now() + 3600000), // +1 hour
        }));

          const { status, data } = await test.post('/odata/v4/cardano-transaction/CheckSubmissionStatus', {
          submissionId: '12345678-1234-1234-1234-1234567890ab',
        });
        expect(data.id).to.equal('12345678-1234-1234-1234-1234567890ab');
        expect(data.txHash).to.equal('dummyhash');
        expect(data.signedTxCbor).to.equal('dummycbor');
        expect(data.status).to.equal('pending');
        expect(status).to.equal(200);
      });
    });

    // ============================================================================
    // OData Query Features on TransactionBuilds
    // ============================================================================

    describe('OData Query Features on TransactionBuilds', () => {
      beforeEach(async () => {
        // Build multiple transactions for testing
        const buildRequest1 = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount, // Use valid 10 ADA
          changeAddress: FIXTURE.validSenderAddress,
        };

        const buildRequest2 = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: '15000000', // 15 ADA (above minimum)
          changeAddress: FIXTURE.validSenderAddress,
        };

        await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest1);
        await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest2);
      });

      it('GET /TransactionBuilds?$filter=network eq \'preview\' - filter by network', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$filter=network eq 'preview'`);
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        data.value.forEach((build: any) => {
          expect(build.network).to.equal('preview');
        });
      });

      it('GET /TransactionBuilds?$filter=wasSubmitted eq false - filter by wasSubmitted', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$filter=wasSubmitted eq false');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        data.value.forEach((build: any) => {
          expect(build.wasSubmitted).to.equal(false);
        });
      });

      it('GET /TransactionBuilds?$orderby=createdAt desc - order by createdAt', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$orderby=createdAt desc');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(1);
        
        // Verify descending order
        for (let i = 0; i < data.value.length - 1; i++) {
          const current = new Date(data.value[i].createdAt).getTime();
          const next = new Date(data.value[i + 1].createdAt).getTime();
          expect(current).to.be.greaterThanOrEqual(next);
        }
      });

      it('GET /TransactionBuilds?$top=1 - limit results to top 1', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$top=1');
        expect(status).to.equal(200);
        expect(data.value.length).to.equal(1);
      });

      it('GET /TransactionBuilds?$select=id,txBodyHash - select specific fields', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$select=id,txBodyHash');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        
        data.value.forEach((build: any) => {
          expect(build).to.have.property('id');
          expect(build).to.have.property('txBodyHash');
          expect(build).to.not.have.property('unsignedTxCbor');
        });
      });

      it('GET /TransactionBuilds?$count=true - include count in response', async () => {
        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$count=true');
        expect(status).to.equal(200);
        expect(data).to.have.property('@odata.count');
        expect(data['@odata.count']).to.be.greaterThan(0);
      });
    });

    // ============================================================================
    // Navigation & Expand Tests
    // ============================================================================

    describe('Navigation and $expand Tests', () => {
      it('GET /TransactionBuilds?$expand=inputs - expand inputs navigation', async () => {
        // Build a transaction first
        const buildRequest = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest);

        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$expand=inputs');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        
        const buildWithInputs = data.value[0];
        expect(buildWithInputs).to.have.property('inputs');
        expect(Array.isArray(buildWithInputs.inputs)).to.be.true;
      });

      it('GET /TransactionBuilds?$expand=outputs - expand outputs navigation', async () => {
        // Build a transaction first
        const buildRequest = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest);

        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$expand=outputs');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        
        const buildWithOutputs = data.value[0];
        expect(buildWithOutputs).to.have.property('outputs');
        expect(Array.isArray(buildWithOutputs.outputs)).to.be.true;
        expect(buildWithOutputs.outputs.length).to.be.greaterThan(0);
      });

      it('GET /TransactionBuilds?$expand=inputs,outputs - expand multiple navigations', async () => {
        // Build a transaction first
        const buildRequest = {
          network: FIXTURE.network,
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest);

        const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds?$expand=inputs,outputs');
        expect(status).to.equal(200);
        expect(data.value.length).to.be.greaterThan(0);
        
        const build = data.value[0];
        expect(build).to.have.property('inputs');
        expect(build).to.have.property('outputs');
        expect(Array.isArray(build.inputs)).to.be.true;
        expect(Array.isArray(build.outputs)).to.be.true;
      });
    });


  });
}

