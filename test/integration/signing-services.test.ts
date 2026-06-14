/**
 * Integration tests for Signing Services
 *
 * Tests the external signing workflow with minimal tests for maximum coverage
 */

import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';
import { setHsmSigner } from '../../srv/blockchain/signing/hsm-signer';
import { TEST_FIXTURES } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks } from './mock-helpers';

const { INSERT, UPDATE } = cds.ql;

jest.setTimeout(30000);

// Skip server auto-init - mock tests create their own context after setting up nock mocks
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

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
        // Fee-payer key binding (resolveRequiredSigners) requires the senderAddress'
        // payment credential to match a witness. addressWithFunds' cred == the key the
        // signedTxCbor1/witnessSetCbor fixtures actually sign with (374610…0a1).
        senderAddress: TEST_FIXTURES.addressWithFunds,
        unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
        txBodyHash: TEST_FIXTURES.txBodyHash,
        status: 'built',
        builderType: 'buildooor',
        createdAt: now,
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 300000).toISOString(), // 5 minutes in future
      })
    );
  });

  afterEach(() => {
    resetKoiosMocks();
    setHsmSigner(null);
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
      const { status, data } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId,
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

      const { status: status1, data: data1 } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch(err => err.response);
      expect(status1).to.equal(400);
      expect(data1.error.message).to.include('expired');

      // Test missing signedTxCbor
      const { data: newReq } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', { buildId: testBuildId });
      const { status: status2 } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId: newReq.id,
      }).catch(err => err.response);
      expect(status2).to.equal(400);
    });

    it('should return isValid=false for invalid/missing signature (!isValidSig)', async () => {
      // Use unsignedTxCbor which has no witnesses - verification should fail
      const { status, data } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.unsignedTxCbor,
        signerType: 'cardano-cli',
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(false);
      expect(data.witnessCount).to.equal(0);
    });

    it('should reject when signing request does not exist', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const { status } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId: fakeId,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch(err => err.response);

      expect(status).to.equal(400);
    });

    it('should combine CIP-30 witness set with unsigned transaction', async () => {
      // Pass witness set CBOR (not a full signed tx) — triggers combineTransactionWithWitnesses path
      const { status, data } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        signerType: 'cip30-wallet',
        signerInfo: 'Nami',
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(true);
      expect(data.witnessCount).to.be.greaterThan(0);
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
      const { status, data } = await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        signerType: 'browser-wallet',
        signerInfo: 'Nami',
      });

      expect(status).to.equal(200);
      expect(data.status).to.equal('submitted');
      expect(data).to.have.property('txHash');
    });

    it('should reject already-submitted requests', async () => {
      // First submit succeeds
      await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      });

      setupTxResponseMock();

      // Second submit: status is 'submitted', handler rejects since only [pending, verified] allowed
      const { status: status1 } = await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch(err => err.response);
      expect(status1).to.equal(400);
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

      const { status: status2, data: data2 } = await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId: newData.id,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch(err => err.response);
      expect(status2).to.equal(400);
      expect(data2.error.message).to.include('expired');
    });
  });

  describe('GetSigningRequestsByAddress Action', () => {
    it('should retrieve signing requests for a given address via action', async () => {
      // Create a signing request first
      await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Call the actual GetSigningRequestsByAddress action
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetSigningRequestsByAddress', {
        address: TEST_FIXTURES.addressWithAssets,
      });

      expect(status).to.equal(200);
      expect(data.value).to.be.an('array');
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

      const { data: verifyData } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId: createData.id,
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
      const { status, data } = await test.get(`/odata/v4/cardano-sign/AddressSigningRequests?$filter=address_address eq '${TEST_FIXTURES.addressWithFunds}'`);

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
      const { data: verifyData } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId: createData.id,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
        signerType: 'cardano-cli',
      });
      expect(verifyData.isValid).to.equal(true);

      // Step 4: Submit transaction
      setupTxResponseMock();

      const { data: submitData } = await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId: createData.id,
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

  // ==========================================================================
  // Branch Coverage: Additional Edge Case Tests
  // ==========================================================================

  describe('Branch Coverage: verifyBuildOwnership address mismatch', () => {
    it('should reject when address does not match build owner', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-sign/SubmitVerifiedTransaction', {
        signingRequestId: createData.id,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
        address: 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg', // different from build sender
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('does not match build owner');
    });
  });

  describe('Branch Coverage: GetSigningRequest non-pending status', () => {
    it('should skip expiry check for non-pending status', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Manually set status to 'verified'
      await cds.run(
        UPDATE.entity('CardanoSignService.SigningRequests')
          .set({ status: 'verified' })
          .where({ id: createData.id })
      );

      const { status, data } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: createData.id,
      });
      expect(status).to.equal(200);
      expect(data.status).to.equal('verified');
    });
  });

  describe('Branch Coverage: VerifySignature edge cases', () => {
    it('should succeed without address parameter (skip ownership check)', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      const { status, data } = await test.post('/odata/v4/cardano-sign/VerifySignature', {
        signingRequestId: createData.id,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
        signerType: 'cardano-cli',
        // no address parameter
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(true);
    });

    it('should reject non-pending signing request', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-sign/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Set status to 'verified' so it's not 'pending'
      await cds.run(
        UPDATE.entity('CardanoSignService.SigningRequests')
          .set({ status: 'verified' })
          .where({ id: createData.id })
      );

      const { status, data } = await test.post('/odata/v4/cardano-sign/VerifySignature', {
        signingRequestId: createData.id,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include("expected 'pending'");
    });
  });

  describe('Branch Coverage: SubmitVerifiedTransaction edge cases', () => {
    it('should reject non-existent signing request', async () => {
      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-sign/SubmitVerifiedTransaction', {
        signingRequestId: '00000000-0000-0000-0000-000000000000',
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('not found');
    });

    it('should reject signing request with no associated build', async () => {
      // Insert signing request directly with no build_id
      const reqId = 'no-build-req-1234';
      await cds.run(
        INSERT.into('CardanoSignService.SigningRequests').entries({
          id: reqId,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          status: 'pending',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          validFrom: new Date().toISOString(),
          validTo: new Date(Date.now() + 300000).toISOString(),
        })
      );

      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-sign/SubmitVerifiedTransaction', {
        signingRequestId: reqId,
        signedTxCbor: TEST_FIXTURES.witnessSetCbor,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('no associated build');
    });
  });

  describe('Branch Coverage: SignWithHsm address mismatch', () => {
    it('should reject when build sender does not match HSM address', async () => {
      // Create a build with a different sender address
      const mismatchBuildId = 'mismatch-build-1234';
      await cds.run(
        INSERT.into('CardanoSignService.TransactionBuilds').entries({
          id: mismatchBuildId,
          network: TEST_FIXTURES.network,
          senderAddress: 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg', // different from HSM
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          status: 'built',
          builderType: 'buildooor',
          createdAt: Date.now(),
          validFrom: new Date().toISOString(),
          validTo: new Date(Date.now() + 300000).toISOString(),
        })
      );

      setHsmSigner(createMockHsmSigner());

      const { status, data } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: mismatchBuildId,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('does not match HSM address');
    });
  });

  describe('Branch Coverage: SignAndSubmitWithHsm edge cases', () => {
    it('should reject when build sender does not match HSM address', async () => {
      const mismatchBuildId = 'mismatch-build-5678';
      await cds.run(
        INSERT.into('CardanoSignService.TransactionBuilds').entries({
          id: mismatchBuildId,
          network: TEST_FIXTURES.network,
          senderAddress: 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg',
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          status: 'built',
          builderType: 'buildooor',
          createdAt: Date.now(),
          validFrom: new Date().toISOString(),
          validTo: new Date(Date.now() + 300000).toISOString(),
        })
      );

      setHsmSigner(createMockHsmSigner());
      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: mismatchBuildId,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('does not match HSM address');
    });

    it('should reject when HSM signature verification fails', async () => {
      // Create mock HSM that produces invalid signature (fake bytes)
      const { Cbor, CborArray, CborBytes, CborMap, CborUInt } = require('@harmoniclabs/cbor');
      const { fromHex, toHex } = require('@harmoniclabs/uint8array-utils');

      const badSigner = {
        isConnected: () => true,
        getAddress: () => TEST_FIXTURES.addressWithAssets,
        getPublicKeyHash: () => Buffer.alloc(28, 0xcc).toString('hex'),
        getStatus: () => ({
          connected: true,
          keyId: '0x0001',
          keyLabel: 'test-key',
          publicKeyHash: Buffer.alloc(28, 0xcc).toString('hex'),
          address: TEST_FIXTURES.addressWithAssets,
        }),
        sign: () => ({
          signatureHex: Buffer.alloc(64, 0xbb).toString('hex'),
          publicKeyHex: Buffer.alloc(32, 0xaa).toString('hex'),
          publicKeyHash: Buffer.alloc(28, 0xcc).toString('hex'),
        }),
        signTransaction: (unsignedTxCbor: string) => {
          // Produce CBOR with fake (invalid) signature
          const txObj = Cbor.parse(fromHex(unsignedTxCbor));
          const vkeyWitness = new CborArray([
            new CborBytes(Buffer.alloc(32, 0xaa)),
            new CborBytes(Buffer.alloc(64, 0xbb)),
          ]);
          const origWs = txObj.array[1];
          if (origWs instanceof CborMap) {
            const entries = origWs.map.filter(
              (e: any) => !(e.k instanceof CborUInt && Number(e.k.num) === 0)
            );
            entries.push({ k: new CborUInt(0), v: new CborArray([vkeyWitness]) });
            txObj.array[1] = new CborMap(entries, { indefinite: origWs.indefinite });
          }
          return toHex(Cbor.encode(new CborArray(txObj.array, { indefinite: txObj.indefinite })));
        },
        shutdown: jest.fn(),
      } as any;

      setHsmSigner(badSigner);
      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      }).catch((err: any) => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('verification failed');
    });
  });

  // ==========================================================================
  // HSM Signing Tests
  // ==========================================================================

  describe('GetHsmStatus', () => {
    it('should return connected status when HSM is configured', async () => {
      setHsmSigner(createMockHsmSigner());

      const { status, data } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});

      expect(status).to.equal(200);
      expect(data.connected).to.equal(true);
      expect(data.keyId).to.equal('0x0001');
      expect(data.keyLabel).to.equal('test-key');
      expect(data.publicKeyHash).to.exist;
      expect(data.cardanoAddress).to.equal(TEST_FIXTURES.addressWithAssets);
    });

    it('should return disconnected status when HSM is not configured', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});

      expect(status).to.equal(200);
      expect(data.connected).to.equal(false);
      expect(data.keyId).to.equal(null);
      expect(data.publicKeyHash).to.equal(null);
      expect(data.cardanoAddress).to.equal(null);
    });
  });

  describe('SignWithHsm', () => {
    beforeEach(() => {
      setHsmSigner(createMockHsmSigner());
    });

    it('should sign transaction and return verified signing request', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      });

      expect(status).to.equal(200);
      expect(data).to.have.property('id');
      expect(data).to.have.property('txBodyHash', TEST_FIXTURES.txBodyHash);
      expect(data).to.have.property('status');
      expect(data).to.have.property('signerType', 'hsm');
      expect(data).to.have.property('hsmKeyId', 'test-key');
    });

    it('should reject when HSM is not connected', async () => {
      setHsmSigner(null);

      const response = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      }).catch((err: any) => err.response);

      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('HSM');
    });

    it('should reject when HSM signer reports disconnected', async () => {
      setHsmSigner(createMockHsmSigner({ connected: false }));

      const response = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      }).catch((err: any) => err.response);

      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('not configured or not connected');
    });

    it('should reject missing buildId', async () => {
      const response = await test.post('/odata/v4/cardano-sign/SignWithHsm', {})
        .catch((err: any) => err.response);

      expect(response.status).to.equal(400);
    });

    it('should reject non-existent buildId', async () => {
      const response = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: '00000000-0000-0000-0000-000000000000',
      }).catch((err: any) => err.response);

      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Build not found');
    });

    it('should create a SigningRequest and SignatureVerification audit trail', async () => {
      const { data } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      });

      const signingRequests = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SigningRequests').where({ id: data.id })
      );
      expect(signingRequests).to.have.length(1);
      expect(signingRequests[0].signerType).to.equal('hsm');
      expect(signingRequests[0].hsmKeyId).to.equal('test-key');

      const verifications = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SignatureVerifications').where({ signingRequest_id: data.id })
      );
      expect(verifications).to.have.length(1);
    });
  });

  describe('SignAndSubmitWithHsm', () => {
    beforeEach(() => {
      setHsmSigner(createMockHsmSigner());
      setupTxResponseMock();
    });

    it('should sign and submit transaction in one step', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      });

      expect(status).to.equal(200);
      expect(data).to.have.property('id');
      expect(data).to.have.property('txHash');
      expect(data).to.have.property('status', 'submitted');
    });

    it('should reject when HSM is not connected', async () => {
      setHsmSigner(null);

      const response = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      }).catch((err: any) => err.response);

      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('HSM');
    });

    it('should reject missing buildId', async () => {
      const response = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {})
        .catch((err: any) => err.response);

      expect(response.status).to.equal(400);
    });

    it('should reject non-existent buildId', async () => {
      const response = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: '00000000-0000-0000-0000-000000000000',
      }).catch((err: any) => err.response);

      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Build not found');
    });

    it('should create full audit trail: SigningRequest + Verification + Submission', async () => {
      const { data: submission } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      });

      expect(submission.status).to.equal('submitted');
      expect(submission.txHash).to.exist;

      const signingRequests = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SigningRequests').where({ build_id: testBuildId })
      );
      expect(signingRequests).to.have.length(1);
      expect(signingRequests[0].signerType).to.equal('hsm');
      expect(signingRequests[0].hsmKeyId).to.equal('test-key');
      expect(signingRequests[0].submittedAt).to.exist;

      const builds = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.TransactionBuilds').where({ id: testBuildId })
      );
      expect(builds[0].wasSubmitted).to.equal(true);
    });
  });

  describe('Complete HSM Workflow', () => {
    it('should execute end-to-end: GetStatus → SignAndSubmit', async () => {
      setHsmSigner(createMockHsmSigner());
      setupTxResponseMock();

      const { data: statusData } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});
      expect(statusData.connected).to.equal(true);
      expect(statusData.cardanoAddress).to.exist;

      const { data: submitData } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      });
      expect(submitData.status).to.equal('submitted');
      expect(submitData.txHash).to.exist;
    });

    it('should execute: SignWithHsm → verify audit trail', async () => {
      setHsmSigner(createMockHsmSigner());

      const { data: signData } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      });

      expect(signData).to.have.property('id');
      expect(signData.signerType).to.equal('hsm');

      const { data: requestData } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: signData.id,
      });
      expect(requestData.hsmKeyId).to.equal('test-key');
    });
  });
});

// ---------------------------------------------------------------------------
// Mock HSM Signer Helper
// ---------------------------------------------------------------------------

/**
 * Creates a mock HsmSigner that produces deterministic signed transaction CBOR.
 * Uses the real CBOR libraries for witness building (same approach as production).
 */
function createMockHsmSigner(options?: { connected?: boolean; signError?: Error }) {
  const connected = options?.connected ?? true;
  const signError = options?.signError;

  const { Cbor, CborArray, CborBytes, CborMap, CborUInt } = require('@harmoniclabs/cbor');
  const { fromHex, toHex } = require('@harmoniclabs/uint8array-utils');
  const { deriveEd25519PublicKey_sync, getEd25519Signature_sync, blake2b_224 } = require('@harmoniclabs/crypto');
  const { randomBytes } = require('crypto');

  // Generate a real Ed25519 keypair so signatures pass verification
  const privateKey = Uint8Array.from(randomBytes(32));
  const realPublicKeyBytes = deriveEd25519PublicKey_sync(privateKey);
  const realKeyHash = toHex(blake2b_224(realPublicKeyBytes));

  return {
    isConnected: () => connected,
    getAddress: () => TEST_FIXTURES.addressWithAssets,
    getPublicKeyHash: () => realKeyHash,
    getStatus: () => ({
      connected,
      keyId: '0x0001',
      keyLabel: 'test-key',
      publicKeyHash: connected ? realKeyHash : undefined,
      address: connected ? TEST_FIXTURES.addressWithAssets : undefined,
    }),
    sign: (txBodyHash: Buffer) => {
      if (signError) throw signError;
      const sigBytes = getEd25519Signature_sync(Uint8Array.from(txBodyHash), privateKey);
      return {
        signatureHex: toHex(sigBytes),
        publicKeyHex: toHex(realPublicKeyBytes),
        publicKeyHash: realKeyHash,
      };
    },
    signTransaction: (unsignedTxCbor: string, txBodyHash: string) => {
      if (signError) throw signError;

      // Sign the tx body hash with the real private key
      const sigBytes = getEd25519Signature_sync(fromHex(txBodyHash), privateKey);

      const txObj = Cbor.parse(fromHex(unsignedTxCbor));
      const vkeyWitness = new CborArray([
        new CborBytes(Uint8Array.from(realPublicKeyBytes)),
        new CborBytes(Uint8Array.from(sigBytes)),
      ]);

      const origWs = txObj.array[1];
      if (origWs instanceof CborMap) {
        const entries = origWs.map.filter(
          (e: any) => !(e.k instanceof CborUInt && Number(e.k.num) === 0)
        );
        entries.push({ k: new CborUInt(0), v: new CborArray([vkeyWitness]) });
        txObj.array[1] = new CborMap(entries, { indefinite: origWs.indefinite });
      }

      return toHex(Cbor.encode(
        new CborArray(txObj.array, { indefinite: txObj.indefinite })
      ));
    },
    shutdown: jest.fn(),
  } as any;
}
