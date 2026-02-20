/**
 * Integration tests for Signing Services
 *
 * Tests the external signing workflow with minimal tests for maximum coverage
 */

import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';
import { TEST_FIXTURES } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks } from './mock-helpers';

const { INSERT, UPDATE } = cds.ql;

jest.setTimeout(30000);

// Skip server auto-init - mock tests create their own context after setting up nock mocks
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'csl';

describe('Signing Services Integration Tests', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  let testBuildId: string;

  // Create app context once before all tests - nock mocks must be set up first
  beforeAll(async () => {
    setupNocks();
    setupKoiosMocks();

    const testContext = await createTestContext(['koios']);
    resetAppContext(testContext);
  });

  beforeEach(async () => {
    await test.data.reset();

    // Reactivate nock for each test
    setupNocks();
    setupKoiosMocks();

    // Create test build
    const now = Date.now();
    testBuildId = 'test-build-1234';
    await cds.run(
      INSERT.into('CardanoSignService.TransactionBuilds').entries({
        id: testBuildId,
        network: TEST_FIXTURES.network,
        senderAddress: TEST_FIXTURES.addressWithAssets,
        unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
        txBodyHash: TEST_FIXTURES.txBodyHash,
        status: 'built',
        builderType: 'csl',
        createdAt: now,
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 300000).toISOString(), // 5 minutes in future
      })
    );
  });

  afterEach(() => {
    resetKoiosMocks();
  });

  afterAll(async () => {
    // Cleanup nock
    teardownKoiosMocks();
    // Shutdown app context to close backend connections
    await shutdownAppContext();
  });

  // ==========================================================================
  // CreateSigningRequest Tests
  // ==========================================================================

  describe('CreateSigningRequest', () => {
    it('should create signing request with all required fields and return existing if duplicate', async () => {
      // Test creation
      const { status, data } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      expect(status).to.equal(200);
      expect(data).to.have.property('id');
      expect(data).to.have.property('txBodyHash', TEST_FIXTURES.txBodyHash);
      expect(data).to.have.property('unsignedTxCbor', TEST_FIXTURES.unsignedTxCbor);
      expect(data).to.have.property('status', 'pending');

      // Test duplicate returns same request
      const { data: duplicateData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      expect(duplicateData.id).to.equal(data.id);
    });

    it('should reject invalid inputs', async () => {
      // Missing buildId
      const { status: status1 } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {})
        .catch(err => err.response);
      expect(status1).to.equal(400);

      // Non-existent build
      const { status: status2, data: data2 } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: 'non-existent',
      }).catch(err => err.response);
      expect(status2).to.equal(400);
      expect(data2.error.message).to.include('Build not found');
    });
  });

  // ==========================================================================
  // GetSigningRequest Tests
  // ==========================================================================

  describe('GetSigningRequest', () => {
    it('should retrieve request and mark expired requests as expired', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Test retrieval
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId,
      });
      expect(status).to.equal(200);
      expect(data.id).to.equal(signingRequestId);

      // Test expiration handling
      await cds.run(
        UPDATE.entity('CardanoSignService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: signingRequestId })
      );

      const { data: expiredData } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId,
      });
      expect(expiredData.status).to.equal('expired');
    });

    it('should reject invalid signingRequestId', async () => {
      const { status } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: 'non-existent',
      }).catch(err => err.response);
      expect(status).to.equal(400);
    });
  });

  // ==========================================================================
  // VerifySignature Tests
  // ==========================================================================

  describe('VerifySignature', () => {
    let signingRequestId: string;

    beforeEach(async () => {
      const { data } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      signingRequestId = data.id;
    });

    it('should verify valid signature', async () => {
      const { status, data } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
        signerType: 'cardano-cli',
        signerInfo: 'Test',
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(true);
      expect(data.witnessCount).to.be.greaterThan(0);
    });

    it('should reject expired requests and missing signedTxCbor', async () => {
      // Test expired request
      await cds.run(
        UPDATE.entity('CardanoSignService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: signingRequestId })
      );

      const { status: status1, data: data1 } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch(err => err.response);
      expect(status1).to.equal(400);
      expect(data1.error.message).to.include('expired');

      // Test missing signedTxCbor (signingRequestId now comes from URL)
      const { data: newReq } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', { buildId: testBuildId });
      const { status: status2 } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${newReq.id})/CardanoSignService.VerifySignature`, {
      }).catch(err => err.response);
      expect(status2).to.equal(400);
    });

    it('should return isValid=false for invalid/missing signature (!isValidSig)', async () => {
      // Use unsignedTxCbor which has no witnesses - verification should fail
      const { status, data } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.unsignedTxCbor,
        signerType: 'cardano-cli',
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(false);
      expect(data.witnessCount).to.equal(0);
    });
  });

  // ==========================================================================
  // SubmitVerifiedTransaction Action
  // ==========================================================================

  describe('SubmitVerifiedTransaction Action', () => {
    let signingRequestId: string;

    beforeEach(async () => {
      const { data } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      signingRequestId = data.id;

      setupTxResponseMock();
    });

    it('should combine witness set and submit transaction', async () => {
      const { status, data } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.SubmitVerifiedTransaction`, {
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        signerType: 'browser-wallet',
        signerInfo: 'Nami',
      });

      expect(status).to.equal(200);
      expect(data.status).to.equal('submitted');
      expect(data).to.have.property('txHash');
    });

    it('should reject already-submitted requests with 409 (@flow.status)', async () => {
      // First submit succeeds
      await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.SubmitVerifiedTransaction`, {
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      });

      setupTxResponseMock();

      // Second submit: @flow.status rejects — status is 'submitted', @from only allows [#pending, #verified]
      const { status: status1 } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.SubmitVerifiedTransaction`, {
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch(err => err.response);
      expect(status1).to.equal(409);
    });

    it('should reject expired requests', async () => {
      // Create new request for expiration test
      const { data: newData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Expire it
      await cds.run(
        UPDATE.entity('CardanoSignService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: newData.id })
      );

      const { status: status2, data: data2 } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${newData.id})/CardanoSignService.SubmitVerifiedTransaction`, {
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch(err => err.response);
      expect(status2).to.equal(400);
      expect(data2.error.message).to.include('expired');
    });
  });

  describe('GetSigningRequestsByAddress Action', () => {
    it('should retrieve signing requests for a given address', async () => {
      // Create a signing request
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Retrieve by address
      const { status, data } = await test.get(`/odata/v4/cardano-sign/SigningRequests?$filter=build/senderAddress eq '${TEST_FIXTURES.addressWithAssets}'`);

      expect(status).to.equal(200);
      expect(data.value).to.be.an('array');
      expect(data.value.length).to.be.greaterThan(0);
      const found = data.value.find((req: any) => req.id === createData.id);
      expect(found).to.exist;
    });

    it('should return error for missing address parameter', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetSigningRequestsByAddress', {})
        .catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('address is required');
    });

    it('should return error for invalid bech32 address', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetSigningRequestsByAddress', {
        address: 'invalid_address'
      }).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.match(/bech32/i);
    });
  });

  // ==========================================================================
  // READ Entities Tests
  // ==========================================================================

  describe('READ SigningRequests and SignatureVerifications', () => {
    it('should read signing requests with filtering and expansion', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Test read all
      const { status: allStatus, data: allData } = await test.get('/odata/v4/cardano-sign/SigningRequests');
      expect(allStatus).to.equal(200);
      expect(allData.value).to.be.an('array');
      expect(allData.value.length).to.be.greaterThan(0);

      // Test read by ID
      const { status: byIdStatus, data: byIdData } = await test.get(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})`);
      expect(byIdStatus).to.equal(200);
      expect(byIdData.id).to.equal(signingRequestId);

      // Test filter by status
      const { status: filterStatus, data: filterData } = await test.get('/odata/v4/cardano-sign/SigningRequests?$filter=status eq \'pending\'');
      expect(filterStatus).to.equal(200);
      filterData.value.forEach((req: any) => expect(req.status).to.equal('pending'));

      // Test expand build
      const { status: expandStatus, data: expandData } = await test.get(`/odata/v4/cardano-sign/SigningRequests(${signingRequestId})?$expand=build`);
      expect(expandStatus).to.equal(200);
      expect(expandData.build).to.have.property('id', testBuildId);
    });

    it('should read signature verifications with filtering and expansion', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      const { data: verifyData } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${createData.id})/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
        signerType: 'cardano-cli',
      });
      const verificationId = verifyData.id;

      // Test read all
      const { status: allStatus, data: allData } = await test.get('/odata/v4/cardano-sign/SignatureVerifications');
      expect(allStatus).to.equal(200);
      expect(allData.value).to.be.an('array');
      expect(allData.value.length).to.be.greaterThan(0);

      // Test read by ID
      const { status: byIdStatus, data: byIdData } = await test.get(`/odata/v4/cardano-sign/SignatureVerifications(${verificationId})`);
      expect(byIdStatus).to.equal(200);
      expect(byIdData.id).to.equal(verificationId);

      // Test filter by isValid
      const { status: filterStatus, data: filterData } = await test.get('/odata/v4/cardano-sign/SignatureVerifications?$filter=isValid eq true');
      expect(filterStatus).to.equal(200);
      filterData.value.forEach((v: any) => expect(v.isValid).to.equal(true));

      // Test expand signingRequest
      const { status: expandStatus, data: expandData } = await test.get(`/odata/v4/cardano-sign/SignatureVerifications(${verificationId})?$expand=signingRequest`);
      expect(expandStatus).to.equal(200);
      expect(expandData.signingRequest).to.have.property('id', createData.id);
    });

    it ('should read AddressSigningRequests with Address filter', async () => {
      // Create a signing request (this also creates AddressSigningRequests association)
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Read AddressSigningRequests filtered by address
      const { status, data } = await test.get(`/odata/v4/cardano-sign/AddressSigningRequests?$filter=address_address eq '${TEST_FIXTURES.addressWithAssets}'`);

      expect(status).to.equal(200);
      expect(data.value).to.be.an('array');
      expect(data.value.length).to.be.greaterThan(0);
      const found = data.value.find((req: any) => req.signingRequest_id === signingRequestId);
      expect(found).to.exist;
    }); 
  });

  // ==========================================================================
  // Complete Workflow Test
  // ==========================================================================

  describe('Complete Signing Workflow', () => {
    it('should execute end-to-end workflow from creation to submission', async () => {
      // Step 1: Create signing request
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });
      expect(createData.status).to.equal('pending');

      // Step 2: Get signing request
      const { data: getData } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: createData.id,
      });
      expect(getData.id).to.equal(createData.id);

      // Step 3: Verify signature
      const { data: verifyData } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${createData.id})/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
        signerType: 'cardano-cli',
      });
      expect(verifyData.isValid).to.equal(true);

      // Step 4: Submit transaction
      setupTxResponseMock();

      const { data: submitData } = await test.post(`/odata/v4/cardano-sign/SigningRequests(${createData.id})/CardanoSignService.SubmitVerifiedTransaction`, {
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        signerType: 'browser-wallet',
      });
      expect(submitData.status).to.equal('submitted');
      expect(submitData.txHash).to.exist;

      // Step 5: Verify final state
      const { data: finalData } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: createData.id,
      });
      expect(finalData.status).to.equal('submitted');
    });
  });
});
