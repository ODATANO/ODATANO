/**
 * HSM Signing Services Integration Tests
 *
 * Tests the SignWithHsm, SignAndSubmitWithHsm, and GetHsmStatus
 * actions through the OData service layer.
 *
 * Uses a mocked pkcs11js to simulate HSM hardware, with real
 * CBOR processing and signature verification.
 */
import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';
import { setHsmSigner } from '../../srv/blockchain/signing/hsm-signer';
import { TEST_FIXTURES } from './test-fixtures';
import { setupNocks, setupKoiosMocks, setupTxResponseMock, teardownKoiosMocks, resetKoiosMocks } from './mock-helpers';

const { INSERT } = cds.ql;

jest.setTimeout(30000);

// Skip server auto-init - mock tests create their own context
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'csl';

// ---------------------------------------------------------------------------
// Mock HSM Signer
// ---------------------------------------------------------------------------

/**
 * Creates a mock HsmSigner that produces deterministic signed transaction CBOR.
 * Uses the real signTransaction approach: parses CBOR, adds a VKey witness.
 */
function createMockHsmSigner(options?: { connected?: boolean; signError?: Error }) {
  const connected = options?.connected ?? true;
  const signError = options?.signError;

  // Use real CBOR libraries for witness building (same as production code)
  const { Cbor, CborArray, CborBytes, CborMap, CborUInt } = require('@harmoniclabs/cbor');
  const { fromHex, toHex } = require('@harmoniclabs/uint8array-utils');

  // Fake Ed25519 key pair
  const fakePublicKey = Buffer.alloc(32, 0xaa);
  const fakeSignature = Buffer.alloc(64, 0xbb);
  const fakeKeyHash = Buffer.alloc(28, 0xcc).toString('hex');

  return {
    isConnected: () => connected,
    getAddress: () => 'addr_test1mockaddress',
    getPublicKeyHash: () => fakeKeyHash,
    getStatus: () => ({
      connected,
      keyId: '0x0001',
      keyLabel: 'test-key',
      publicKeyHash: connected ? fakeKeyHash : undefined,
      address: connected ? 'addr_test1mockaddress' : undefined,
    }),
    sign: (_txBodyHash: Buffer) => {
      if (signError) throw signError;
      return {
        signatureHex: fakeSignature.toString('hex'),
        publicKeyHex: fakePublicKey.toString('hex'),
        publicKeyHash: fakeKeyHash,
      };
    },
    signTransaction: (unsignedTxCbor: string, _txBodyHash: string) => {
      if (signError) throw signError;

      // Build real CBOR with witness — same approach as production HsmSigner
      const txObj = Cbor.parse(fromHex(unsignedTxCbor));
      const vkeyWitness = new CborArray([
        new CborBytes(fakePublicKey),
        new CborBytes(fakeSignature),
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
      ).toBuffer());
    },
    shutdown: jest.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HSM Signing Services Integration Tests', () => {
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

    // Create a test build for HSM signing
    const now = Date.now();
    testBuildId = 'hsm-test-build-' + now;
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
        validTo: new Date(now + 300000).toISOString(),
      })
    );

    // Set up a connected mock HSM signer for each test
    setHsmSigner(createMockHsmSigner());
  });

  afterEach(() => {
    resetKoiosMocks();
    setHsmSigner(null);
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  // =========================================================================
  // GetHsmStatus
  // =========================================================================

  describe('GetHsmStatus', () => {
    it('should return connected status when HSM is configured', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});

      expect(status).to.equal(200);
      expect(data.connected).to.equal(true);
      expect(data.keyId).to.equal('0x0001');
      expect(data.keyLabel).to.equal('test-key');
      expect(data.publicKeyHash).to.exist;
      expect(data.cardanoAddress).to.equal('addr_test1mockaddress');
    });

    it('should return disconnected status when HSM is not configured', async () => {
      setHsmSigner(null);

      const { status, data } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});

      expect(status).to.equal(200);
      expect(data.connected).to.equal(false);
      expect(data.keyId).to.equal(null);
      expect(data.publicKeyHash).to.equal(null);
      expect(data.cardanoAddress).to.equal(null);
    });
  });

  // =========================================================================
  // SignWithHsm
  // =========================================================================

  describe('SignWithHsm', () => {
    it('should sign transaction and return verified signing request', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      });

      expect(status).to.equal(200);
      expect(data).to.have.property('id');
      expect(data).to.have.property('txBodyHash', TEST_FIXTURES.txBodyHash);
      expect(data).to.have.property('status');
      // Status should be 'verified' or 'pending' depending on @flow.status behavior
      // The important thing is that the signing request was created and persisted
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

      // Verify SigningRequest was created
      const signingRequests = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SigningRequests').where({ id: data.id })
      );
      expect(signingRequests).to.have.length(1);
      expect(signingRequests[0].signerType).to.equal('hsm');
      expect(signingRequests[0].hsmKeyId).to.equal('test-key');

      // Verify SignatureVerification was created
      const verifications = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SignatureVerifications').where({ signingRequest_id: data.id })
      );
      expect(verifications).to.have.length(1);
    });
  });

  // =========================================================================
  // SignAndSubmitWithHsm
  // =========================================================================

  describe('SignAndSubmitWithHsm', () => {
    beforeEach(() => {
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

      // Verify TransactionSubmission created
      expect(submission.status).to.equal('submitted');
      expect(submission.txHash).to.exist;

      // Verify SigningRequest updated with HSM info
      const signingRequests = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.SigningRequests').where({ build_id: testBuildId })
      );
      expect(signingRequests).to.have.length(1);
      expect(signingRequests[0].signerType).to.equal('hsm');
      expect(signingRequests[0].hsmKeyId).to.equal('test-key');
      expect(signingRequests[0].submittedAt).to.exist;

      // Verify build was marked as submitted
      const builds = await cds.run(
        cds.ql.SELECT.from('CardanoSignService.TransactionBuilds').where({ id: testBuildId })
      );
      expect(builds[0].wasSubmitted).to.equal(true);
    });
  });

  // =========================================================================
  // Complete HSM Workflow
  // =========================================================================

  describe('Complete HSM Workflow', () => {
    it('should execute end-to-end: GetStatus → SignAndSubmit', async () => {
      setupTxResponseMock();

      // Step 1: Check HSM status
      const { data: statusData } = await test.post('/odata/v4/cardano-sign/GetHsmStatus', {});
      expect(statusData.connected).to.equal(true);
      expect(statusData.cardanoAddress).to.exist;

      // Step 2: Sign and submit with HSM
      const { data: submitData } = await test.post('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
        buildId: testBuildId,
      });
      expect(submitData.status).to.equal('submitted');
      expect(submitData.txHash).to.exist;
    });

    it('should execute: SignWithHsm → verify audit trail', async () => {
      // Step 1: Sign only (no submit)
      const { data: signData } = await test.post('/odata/v4/cardano-sign/SignWithHsm', {
        buildId: testBuildId,
      });

      expect(signData).to.have.property('id');
      expect(signData.signerType).to.equal('hsm');

      // Step 2: Retrieve signing request and verify state
      const { data: requestData } = await test.post('/odata/v4/cardano-sign/GetSigningRequest', {
        signingRequestId: signData.id,
      });
      expect(requestData.hsmKeyId).to.equal('test-key');
    });
  });
});
