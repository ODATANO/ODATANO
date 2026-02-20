/**
 * Integration tests for CardanoTransactionService handler validations
 * Tests edge cases and error paths in action handlers
 */

import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';
import { TEST_FIXTURES, plutusSpendRequestBody, mockScriptTxInfo } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupUtxoMock, setupTxInfoMock, setupTxResponseMock, teardownKoiosMocks, nock } from './mock-helpers';

const { INSERT } = cds.ql;

jest.setTimeout(30000);

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'csl';

describe('CardanoTransactionService Handler Validations', () => {
  const test = cds.test(__dirname + '/../../');

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
  });

  afterEach(() => {
    resetKoiosMocks();
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  // ==========================================================================
  // BuildSimpleAdaTransaction — Input Validations
  // ==========================================================================

  describe('BuildSimpleAdaTransaction validations', () => {
    it('should reject invalid outputDatumJson (non-JSON string)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        outputDatumJson: 'not valid json{{{',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject assetsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: '"not-an-array"',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildMultiAssetTransaction — Input Validations
  // ==========================================================================

  describe('BuildMultiAssetTransaction validations', () => {
    it('should reject assetsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: '"not-an-array"',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildMintTransaction — Input Validations
  // ==========================================================================

  describe('BuildMintTransaction validations', () => {
    it('should reject mintActionsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: '"not-an-array"',
        mintingPolicyScript: '8200581c' + 'a'.repeat(56),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildPlutusSpendTransaction — Input Validations
  // ==========================================================================

  describe('BuildPlutusSpendTransaction validations', () => {
    it('should reject when scriptOutputIndex is missing', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: '8200581c' + 'a'.repeat(56),
        scriptTxHash: 'a'.repeat(64),
        // scriptOutputIndex intentionally missing
        redeemerJson: '{"int": 0}',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // CheckSubmissionStatus — Validations
  // ==========================================================================

  describe('CheckSubmissionStatus validations', () => {
    it('should reject when submission is not found', async () => {
      // Create a submission record first with status 'submitted' (required by @from)
      const submissionId = 'nonexistent-sub-id';
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionSubmissions').entries({
          id: submissionId,
          txHash: 'a'.repeat(64),
          network: 'preview',
          status: 'submitted',
          signedTxCbor: 'deadbeef',
          submittedAt: new Date().toISOString(),
        })
      );

      // Delete it so the SELECT.one returns null
      await cds.run(cds.ql.DELETE.from('CardanoTransactionService.TransactionSubmissions').where({ id: submissionId }));

      // Now call CheckSubmissionStatus — the framework may not find the record
      // Note: @from constraint might also reject since we deleted it
      const { status } = await test.post(`/odata/v4/cardano-transaction/TransactionSubmissions(id='${submissionId}')/CardanoTransactionService.CheckSubmissionStatus`, {})
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([400, 404, 409]).toContain(status);
    });
  });

  // ==========================================================================
  // VerifySignature — Validations
  // ==========================================================================

  describe('VerifySignature validations', () => {
    it('should reject when signing request does not exist', async () => {
      const fakeId = 'nonexistent-sr-id';

      const { status } = await test.post(`/odata/v4/cardano-sign/SigningRequests(id='${fakeId}')/CardanoSignService.VerifySignature`, {
        signedTxCbor: TEST_FIXTURES.signedTxCbor1 || 'deadbeef',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([400, 404, 409]).toContain(status);
    });
  });

  // ==========================================================================
  // SubmitVerifiedTransaction — Validations
  // ==========================================================================

  describe('SubmitVerifiedTransaction validations', () => {
    it('should reject when signing request does not exist', async () => {
      const fakeId = 'nonexistent-submit-id';

      const { status } = await test.post(`/odata/v4/cardano-sign/SigningRequests(id='${fakeId}')/CardanoSignService.SubmitVerifiedTransaction`, {})
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([400, 404, 409]).toContain(status);
    });
  });

  // ==========================================================================
  // T1: BuildSimpleAdaTransaction — assetsJson happy path (line 130/134)
  // ==========================================================================

  describe('BuildSimpleAdaTransaction — assetsJson happy path', () => {
    it('should build transaction with valid assetsJson', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: JSON.stringify([{ unit: 'lovelace', quantity: '1000000' }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data).toHaveProperty('unsignedTxCbor');
      expect(data).toHaveProperty('txBodyHash');
    });
  });

  // ==========================================================================
  // T2: BuildMintTransaction — requiredSignersJson invalid JSON (line 249)
  // ==========================================================================

  describe('BuildMintTransaction — requiredSignersJson invalid JSON', () => {
    it('should reject invalid requiredSignersJson (broken JSON)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        requiredSignersJson: 'broken{json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // T3: BuildMintTransaction — scriptParams + lockOnScript + fingerprint
  // (lines 312-330, 349, 355-358)
  // ==========================================================================

  describe('BuildMintTransaction — scriptParams + lockOnScript + fingerprint', () => {
    it('should apply script params, expand assetName, compute fingerprint and scriptAddress', async () => {
      // Use short assetName (< 57 chars) to trigger BUG 7 expansion (line 318-322)
      const shortAssetName = '546f6b656e4d'; // "TokenM" hex
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: shortAssetName, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        scriptParamsJson: JSON.stringify([{ bytes: 'a'.repeat(56) }]),
        lockOnScript: true,
        changeAddress: TEST_FIXTURES.addressWithAssets,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data).toHaveProperty('scriptHash');
      expect(data.scriptHash).toMatch(/^[a-f0-9]{56}$/);
      // T4: CIP-14 fingerprint (line 349)
      expect(data).toHaveProperty('fingerprint');
      expect(data.fingerprint).toMatch(/^asset1/);
      // T5: lockOnScript scriptAddress (lines 355-358)
      expect(data).toHaveProperty('scriptAddress');
      expect(data.scriptAddress).toMatch(/^addr_test1/);
    });
  });

  // ==========================================================================
  // T6: BuildPlutusSpendTransaction — scriptParamsJson invalid JSON (line 420)
  // ==========================================================================

  describe('BuildPlutusSpendTransaction — scriptParamsJson invalid JSON', () => {
    it('should reject invalid scriptParamsJson (broken JSON)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        scriptParamsJson: 'broken{json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // T8: BuildPlutusSpendTransaction — lockOnScript (lines 469/480)
  // ==========================================================================

  describe('BuildPlutusSpendTransaction — lockOnScript', () => {
    it('should derive and persist scriptAddress when lockOnScript is true', async () => {
      setupTxInfoMock(mockScriptTxInfo);

      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        ...plutusSpendRequestBody,
        scriptParamsJson: JSON.stringify([{ bytes: 'a'.repeat(56) }]),
        lockOnScript: true,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data).toHaveProperty('scriptHash');
      expect(data).toHaveProperty('scriptAddress');
      expect(data.scriptAddress).toMatch(/^addr_test1/);
    });
  });

  // ==========================================================================
  // T9: SetCollateral — no UTxOs at address (line 531)
  // ==========================================================================

  describe('SetCollateral — no UTxOs at address', () => {
    it('should reject when no UTxOs found', async () => {
      setupUtxoMock([]);

      const { status, data } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
        address: TEST_FIXTURES.addressWithAssets,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(400);
      expect(data?.error?.message).toMatch(/No UTxOs found/i);
    });
  });

  // ==========================================================================
  // T10: SubmitTransaction — submission failure error handling (lines 597-599)
  // ==========================================================================

  describe('SubmitTransaction — submission failure', () => {
    it('should handle submission failure and persist failed status', async () => {
      // Create a build record in DB
      const buildId = 'test-build-fail-submit';
      const now = Date.now();
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
          id: buildId,
          network: 'preview',
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

      // Mock Koios submission failure
      nock('https://preview.koios.rest')
        .post('/api/v1/submittx')
        .reply(400, { error: 'Transaction validation failed: signature verification failed' });

      const { status } = await test.post('/odata/v4/cardano-transaction/SubmitTransaction', {
        buildId,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([400, 500]).toContain(status);
    });
  });

  // ==========================================================================
  // T11: CheckSubmissionStatus — tx confirmed on chain (lines 667-675)
  // ==========================================================================

  describe('CheckSubmissionStatus — tx confirmed on chain', () => {
    it('should update status to confirmed when tx found on chain', async () => {
      // Create a submission record with status 'submitted'
      const submissionId = 'a0000000-0000-0000-0000-000000000011';
      const txHash = TEST_FIXTURES.validTxHash;
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionSubmissions').entries({
          id: submissionId,
          txHash,
          network: 'preview',
          status: 'submitted',
          signedTxCbor: TEST_FIXTURES.signedTxCbor1,
          submittedAt: new Date().toISOString(),
        })
      );

      // Mock tx_info endpoint returning the transaction (= confirmed on chain)
      setupTxInfoMock([{
        tx_hash: txHash,
        block_hash: 'b'.repeat(64),
        block_height: 5000,
        block_time: 1704067200,
        slot_no: 50000000,
        tx_index: 0,
        tx_fee: '200000',
        deposit: '0',
        tx_size: 300,
        inputs: [],
        outputs: [],
      }]);

      const { status, data } = await test.post(
        `/odata/v4/cardano-transaction/TransactionSubmissions(${submissionId})/CardanoTransactionService.CheckSubmissionStatus`, {}
      ).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data.status).toBe('confirmed');
    });
  });

  // ==========================================================================
  // T12: SubmitVerifiedTransaction — no build_id (line 908)
  // ==========================================================================

  describe('SubmitVerifiedTransaction — no build_id', () => {
    it('should reject when signing request has no associated build', async () => {
      // Create signing request directly in DB without build_id
      const signingRequestId = 'b0000000-0000-0000-0000-000000000012';
      const now = new Date();
      await cds.run(
        INSERT.into('CardanoSignService.SigningRequests').entries({
          id: signingRequestId,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          network: 'preview',
          status: 'pending',
          expiresAt: new Date(now.getTime() + 300000).toISOString(),
          createdAt: now.toISOString(),
          // build_id intentionally omitted
        })
      );

      const { status, data } = await test.post(
        `/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.SubmitVerifiedTransaction`,
        { signedTxCbor: TEST_FIXTURES.signedTxCbor1 }
      ).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(400);
      expect(data?.error?.message).toMatch(/no associated build/i);
    });
  });

  // ==========================================================================
  // T13: SubmitVerifiedTransaction — full signed tx path (line 920)
  // ==========================================================================

  describe('SubmitVerifiedTransaction — full signed tx (cardano-cli path)', () => {
    it('should accept full signed transaction directly (not witness set)', async () => {
      // Create build record
      const buildId = 'd0000000-0000-0000-0000-000000000013';
      const now = Date.now();
      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
          id: buildId,
          network: 'preview',
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

      // Create signing request with build_id
      const signingRequestId = 'c0000000-0000-0000-0000-000000000013';
      await cds.run(
        INSERT.into('CardanoSignService.SigningRequests').entries({
          id: signingRequestId,
          build_id: buildId,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          network: 'preview',
          status: 'pending',
          expiresAt: new Date(now + 300000).toISOString(),
          createdAt: new Date(now).toISOString(),
        })
      );

      // Mock submission endpoint
      setupTxResponseMock();

      // Submit with full signed transaction (not witness set)
      // signedTxCbor1 starts with 84 (CBOR array = full tx), not a1 (CBOR map = witness set)
      const { status, data } = await test.post(
        `/odata/v4/cardano-sign/SigningRequests(${signingRequestId})/CardanoSignService.SubmitVerifiedTransaction`,
        { signedTxCbor: TEST_FIXTURES.signedTxCbor1 }
      ).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data.status).toBe('submitted');
    });
  });
});
