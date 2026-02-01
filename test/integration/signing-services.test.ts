/**
 * Integration tests for Signing Services
 *
 * Tests the external signing workflow with minimal tests for maximum coverage
 */

import cds from '@sap/cds';
import nock from 'nock';
import { resetTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { resetCardanoClient } from '../../srv/blockchain/cardano-client';

const { INSERT, UPDATE } = cds.ql;

jest.setTimeout(30000);

// Configure environment
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'csl';

// ============================================================================
// Test Fixtures
// ============================================================================

const FIXTURE = {
  network: 'preview',
  validSenderAddress: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
  unsignedTxCbor: '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6',
  signedTxCbor: '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206f5f6',
  witnessSetCbor: 'a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206',
  txHash: '4a066f70b5e478f7564311fb2762025fa449246e5bdb035d233a8aadb004abc7',
  txBodyHash: '4a066f70b5e478f7564311fb2762025fa449246e5bdb035d233a8aadb004abc7', // Same as txHash
};

describe('Signing Services Integration Tests', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  let testBuildId: string;

  beforeEach(async () => {
    await test.data.reset();

    // IMPORTANT: Setup nock FIRST before creating any axios instances
    // nock needs to be active before axios.create() is called
    nock.cleanAll();
    nock.restore();
    nock.activate();
    nock.disableNetConnect();
    nock.enableNetConnect(/localhost/);

    // NOW reset CardanoClient - this creates new axios instances that nock can intercept
    resetCardanoClient();
    await resetTransactionBuilder('csl');

    // Create test build
    const now = Date.now();
    testBuildId = 'test-build-1234';
    await cds.run(
      INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
        id: testBuildId,
        network: FIXTURE.network,
        senderAddress: FIXTURE.validSenderAddress,
        unsignedTxCbor: FIXTURE.unsignedTxCbor,
        txBodyHash: FIXTURE.txBodyHash,
        status: 'built',
        builderType: 'csl',
        createdAt: now,
        validFrom: new Date(now).toISOString(),
        validTo: new Date(now + 300000).toISOString(), // 5 minutes in future
      })
    );
  });

  afterEach(() => {
    nock.cleanAll();
    nock.restore();
  });

  afterAll(async () => {
    // Cleanup nock
    nock.cleanAll();
    nock.restore();
    nock.enableNetConnect();
  });

  // ==========================================================================
  // CreateSigningRequest Tests
  // ==========================================================================

  describe('CreateSigningRequest', () => {
    it('should create signing request with all required fields and return existing if duplicate', async () => {
      // Test creation
      const { status, data } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });

      expect(status).to.equal(200);
      expect(data).to.have.property('id');
      expect(data).to.have.property('txBodyHash', FIXTURE.txBodyHash);
      expect(data).to.have.property('unsignedTxCbor', FIXTURE.unsignedTxCbor);
      expect(data).to.have.property('status', 'pending');

      // Test duplicate returns same request
      const { data: duplicateData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      expect(duplicateData.id).to.equal(data.id);
    });

    it('should reject invalid inputs', async () => {
      // Missing buildId
      const { status: status1 } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {})
        .catch(err => err.response);
      expect(status1).to.equal(400);

      // Non-existent build
      const { status: status2, data: data2 } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
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
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Test retrieval
      const { status, data } = await test.post('/odata/v4/cardano-transaction/GetSigningRequest', {
        signingRequestId,
      });
      expect(status).to.equal(200);
      expect(data.id).to.equal(signingRequestId);

      // Test expiration handling
      await cds.run(
        UPDATE.entity('CardanoTransactionService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: signingRequestId })
      );

      const { data: expiredData } = await test.post('/odata/v4/cardano-transaction/GetSigningRequest', {
        signingRequestId,
      });
      expect(expiredData.status).to.equal('expired');
    });

    it('should reject invalid signingRequestId', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/GetSigningRequest', {
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
      const { data } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      signingRequestId = data.id;
    });

    it('should verify valid signature and reject invalid/unsigned transactions', async () => {
      // Test valid signature
      const { status, data } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signingRequestId,
        signedTxCbor: FIXTURE.signedTxCbor,
        signerType: 'cardano-cli',
        signerInfo: 'Test',
      });

      expect(status).to.equal(200);
      expect(data.isValid).to.equal(true);
      expect(data.witnessCount).to.be.greaterThan(0);

      // Test unsigned transaction (should fail verification)
      const { data: invalidData } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signingRequestId,
        signedTxCbor: FIXTURE.unsignedTxCbor,
      });
      expect(invalidData.isValid).to.equal(false);
    });

    it('should reject expired requests and missing parameters', async () => {
      // Test expired request
      await cds.run(
        UPDATE.entity('CardanoTransactionService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: signingRequestId })
      );

      const { status: status1, data: data1 } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signingRequestId,
        signedTxCbor: FIXTURE.signedTxCbor,
      }).catch(err => err.response);
      expect(status1).to.equal(400);
      expect(data1.error.message).to.include('expired');

      // Test missing parameters
      const { status: status2 } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signedTxCbor: FIXTURE.signedTxCbor,
      }).catch(err => err.response);
      expect(status2).to.equal(400);
    });
  });

  // ==========================================================================
  // SubmitVerifiedTransaction Action
  // ==========================================================================

  describe('SubmitVerifiedTransaction Action', () => {
    let signingRequestId: string;

    beforeEach(async () => {
      const { data } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      signingRequestId = data.id;

      nock('https://preview.koios.rest')
        .post('/api/v1/submit_tx')
        .reply(200, [{ tx_hash: FIXTURE.txHash }]);
    });

    it('should combine witness set and submit transaction', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: FIXTURE.witnessSetCbor,
        signerType: 'browser-wallet',
        signerInfo: 'Nami',
      });

      expect(status).to.equal(200);
      expect(data.status).to.equal('submitted');
      expect(data).to.have.property('txHash');
    });

    it('should reject expired, non-existent, and already-submitted requests', async () => {
      // Test already submitted
      await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: FIXTURE.witnessSetCbor,
      });

      nock('https://preview.koios.rest')
        .post('/api/v1/submit_tx')
        .reply(200, [{ tx_hash: FIXTURE.txHash }]);

      const { status: status1, data: data1 } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId,
        signedTxCbor: FIXTURE.witnessSetCbor,
      }).catch(err => err.response);
      expect(status1).to.equal(400);
      expect(data1.error.message).to.include('already submitted');

      // Create new request for expiration test
      const { data: newData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });

      // Test expired request
      await cds.run(
        UPDATE.entity('CardanoTransactionService.SigningRequests')
          .set({ expiresAt: new Date(Date.now() - 60000).toISOString() })
          .where({ id: newData.id })
      );

      const { status: status2, data: data2 } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId: newData.id,
        signedTxCbor: FIXTURE.witnessSetCbor,
      }).catch(err => err.response);
      expect(status2).to.equal(400);
      expect(data2.error.message).to.include('expired');

      // Test non-existent request
      const { status: status3 } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId: 'non-existent',
        signedTxCbor: FIXTURE.witnessSetCbor,
      }).catch(err => err.response);
      expect(status3).to.equal(400);

      // Test missing signingRequestId
      const { status: status4 } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signedTxCbor: FIXTURE.witnessSetCbor,
      }).catch(err => err.response);
      expect(status4).to.equal(400);
    });
  });

  describe('GetSigningRequestsByAddress Action', () => {
    it('should retrieve signing requests for a given address', async () => {
      // Create a signing request
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      
      // Retrieve by address
      const { status, data } = await test.get(`/odata/v4/cardano-transaction/SigningRequests?$filter=build/senderAddress eq '${FIXTURE.validSenderAddress}'`);

      expect(status).to.equal(200);
      expect(data.value).to.be.an('array');
      expect(data.value.length).to.be.greaterThan(0);
      const found = data.value.find((req: any) => req.id === createData.id);
      expect(found).to.exist;
    });
  });

  // ==========================================================================
  // READ Entities Tests
  // ==========================================================================

  describe('READ SigningRequests and SignatureVerifications', () => {
    it('should read signing requests with filtering and expansion', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Test read all
      const { status: allStatus, data: allData } = await test.get('/odata/v4/cardano-transaction/SigningRequests');
      expect(allStatus).to.equal(200);
      expect(allData.value).to.be.an('array');
      expect(allData.value.length).to.be.greaterThan(0);

      // Test read by ID
      const { status: byIdStatus, data: byIdData } = await test.get(`/odata/v4/cardano-transaction/SigningRequests(${signingRequestId})`);
      expect(byIdStatus).to.equal(200);
      expect(byIdData.id).to.equal(signingRequestId);

      // Test filter by status
      const { status: filterStatus, data: filterData } = await test.get('/odata/v4/cardano-transaction/SigningRequests?$filter=status eq \'pending\'');
      expect(filterStatus).to.equal(200);
      filterData.value.forEach((req: any) => expect(req.status).to.equal('pending'));

      // Test expand build
      const { status: expandStatus, data: expandData } = await test.get(`/odata/v4/cardano-transaction/SigningRequests(${signingRequestId})?$expand=build`);
      expect(expandStatus).to.equal(200);
      expect(expandData.build).to.have.property('id', testBuildId);
    });

    it('should read signature verifications with filtering and expansion', async () => {
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });

      const { data: verifyData } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signingRequestId: createData.id,
        signedTxCbor: FIXTURE.signedTxCbor,
        signerType: 'cardano-cli',
      });
      const verificationId = verifyData.id;

      // Test read all
      const { status: allStatus, data: allData } = await test.get('/odata/v4/cardano-transaction/SignatureVerifications');
      expect(allStatus).to.equal(200);
      expect(allData.value).to.be.an('array');
      expect(allData.value.length).to.be.greaterThan(0);

      // Test read by ID
      const { status: byIdStatus, data: byIdData } = await test.get(`/odata/v4/cardano-transaction/SignatureVerifications(${verificationId})`);
      expect(byIdStatus).to.equal(200);
      expect(byIdData.id).to.equal(verificationId);

      // Test filter by isValid
      const { status: filterStatus, data: filterData } = await test.get('/odata/v4/cardano-transaction/SignatureVerifications?$filter=isValid eq true');
      expect(filterStatus).to.equal(200);
      filterData.value.forEach((v: any) => expect(v.isValid).to.equal(true));

      // Test expand signingRequest
      const { status: expandStatus, data: expandData } = await test.get(`/odata/v4/cardano-transaction/SignatureVerifications(${verificationId})?$expand=signingRequest`);
      expect(expandStatus).to.equal(200);
      expect(expandData.signingRequest).to.have.property('id', createData.id);
    });

    it ('should read AddressSigningRequests with Address filter', async () => {
      // Create a signing request (this also creates AddressSigningRequests association)
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      const signingRequestId = createData.id;

      // Read AddressSigningRequests filtered by address
      const { status, data } = await test.get(`/odata/v4/cardano-transaction/AddressSigningRequests?$filter=address_address eq '${FIXTURE.validSenderAddress}'`);

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
      const { data: createData } = await test.post('/odata/v4/cardano-transaction/CreateSigningRequest', {
        buildId: testBuildId,
      });
      expect(createData.status).to.equal('pending');

      // Step 2: Get signing request
      const { data: getData } = await test.post('/odata/v4/cardano-transaction/GetSigningRequest', {
        signingRequestId: createData.id,
      });
      expect(getData.id).to.equal(createData.id);

      // Step 3: Verify signature
      const { data: verifyData } = await test.post('/odata/v4/cardano-transaction/VerifySignature', {
        signingRequestId: createData.id,
        signedTxCbor: FIXTURE.signedTxCbor,
        signerType: 'cardano-cli',
      });
      expect(verifyData.isValid).to.equal(true);

      // Step 4: Submit transaction
      nock('https://preview.koios.rest')
        .post('/api/v1/submit_tx')
        .reply(200, [{ tx_hash: FIXTURE.txHash }]);

      const { data: submitData } = await test.post('/odata/v4/cardano-transaction/SubmitVerifiedTransaction', {
        signingRequestId: createData.id,
        signedTxCbor: FIXTURE.witnessSetCbor,
        signerType: 'browser-wallet',
      });
      expect(submitData.status).to.equal('submitted');
      expect(submitData.txHash).to.exist;

      // Step 5: Verify final state
      const { data: finalData } = await test.post('/odata/v4/cardano-transaction/GetSigningRequest', {
        signingRequestId: createData.id,
      });
      expect(finalData.status).to.equal('submitted');
    });
  });
});
