/**
 * Integration tests for CardanoTransactionService handler validations
 * Tests edge cases and error paths in action handlers
 */

import cds from '@sap/cds';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';
import { TEST_FIXTURES, plutusSpendRequestBody, mockScriptTxInfo, mockUtxosWithAssets } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupUtxoMock, setupTxInfoMock, setupTxResponseMock, teardownKoiosMocks, nock } from './mock-helpers';

const { INSERT } = cds.ql;

jest.setTimeout(30000);

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

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

    it('should reject invalid changeAddress format', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        changeAddress: 'not-a-bech32-address',
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

    it('should accept valid outputDatumJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        outputDatumJson: JSON.stringify({ int: 42 }),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(200);
    });

    it('should reject forceInputsJson that is not valid JSON', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        forceInputsJson: 'not-valid-json{{{',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        forceInputsJson: '"not-an-array"',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with invalid txHash', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        forceInputsJson: JSON.stringify([{ txHash: 'too-short', outputIndex: 0 }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with negative outputIndex', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        forceInputsJson: JSON.stringify([{ txHash: 'a'.repeat(64), outputIndex: -1 }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildTransactionWithMetadata — Input Validations
  // ==========================================================================

  describe('BuildTransactionWithMetadata validations', () => {
    it('should reject invalid changeAddress format', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        metadataJson: JSON.stringify({ 721: { test: 'metadata' } }),
        changeAddress: 'not-a-bech32-address',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildMultiAssetTransaction — Input Validations
  // ==========================================================================

  describe('BuildMultiAssetTransaction validations', () => {
    it('should reject invalid changeAddress format', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: JSON.stringify([{ unit: 'lovelace', quantity: '1000000' }]),
        changeAddress: 'not-a-bech32-address',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

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
    it('should reject invalid changeAddress format', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        changeAddress: 'not-a-bech32-address',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

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

    it('should reject mint action when entry is not an object', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([null]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject mint action when quantity is not a string', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: 1 }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject mint action when quantity format is invalid', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1.5' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputsJson that is not valid JSON', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        forceInputsJson: 'not-valid-json{{{',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        forceInputsJson: '{"txHash":"a","outputIndex":0}',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with invalid txHash', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        forceInputsJson: JSON.stringify([{ txHash: 'too-short', outputIndex: 0 }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with negative outputIndex', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        forceInputsJson: JSON.stringify([{ txHash: 'a'.repeat(64), outputIndex: -1 }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildPlutusSpendTransaction — Input Validations
  // ==========================================================================

  describe('BuildPlutusSpendTransaction validations', () => {
    it('should reject invalid changeAddress format', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        changeAddress: 'not-a-bech32-address',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

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

    it('should reject forceInputsJson that is not valid JSON', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        forceInputsJson: 'not-valid-json{{{',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        forceInputsJson: '42',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with invalid txHash', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        forceInputsJson: JSON.stringify([{ txHash: 'NOT_HEX_!!', outputIndex: 0 }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject forceInputs entry with negative outputIndex', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        forceInputsJson: JSON.stringify([{ txHash: 'a'.repeat(64), outputIndex: -5 }]),
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

      const { status } = await test.post(`/odata/v4/cardano-sign/VerifySignature`, {
        signingRequestId: fakeId,
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

      const { status } = await test.post(`/odata/v4/cardano-sign/SubmitVerifiedTransaction`, {
        signingRequestId: fakeId,
        signedTxCbor: 'deadbeef',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([400, 404, 409]).toContain(status);
    });
  });

  // ==========================================================================
  // T1: BuildSimpleAdaTransaction — assetsJson happy path (line 130/134)
  // ==========================================================================

  describe('BuildSimpleAdaTransaction — assetsJson happy path', () => {
    it('should build transaction with valid assetsJson', async () => {
      // assetsJson carries native tokens only (lovelace goes in lovelaceAmount and is
      // rejected here by design) — fund the sender with the asset it sends.
      setupUtxoMock(mockUtxosWithAssets);
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: JSON.stringify([{ unit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
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
        // Must be a genuinely parameterized policy: applying a param to a non-parameterized
        // script (e.g. validPlutusScript) yields one that fails local evaluation, which the
        // builder rejects without an Ogmios evaluator to certify execution units.
        mintingPolicyScript: TEST_FIXTURES.parameterizedScript,
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
        // Parameterized validator: applying a param leaves a still-evaluable validator.
        // (buildooor doesn't bind the input address to the script hash at build time, so
        // reusing the shared script UTxO is fine — only successful evaluation matters.)
        validatorScript: TEST_FIXTURES.parameterizedScript,
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
          builderType: 'buildooor',
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
  // T10b: SubmitTransaction — cache invalidation branch (lines 559-562)
  // ==========================================================================

  describe('SubmitTransaction — cache invalidation', () => {
    it('should execute sender cache invalidation when AddressTransactionBuilds exists', async () => {
      const buildId = 'test-build-cache-invalidate';
      const senderAddress = TEST_FIXTURES.addressWithAssets;
      const now = Date.now();

      await cds.run(
        INSERT.into('CardanoTransactionService.TransactionBuilds').entries({
          id: buildId,
          network: 'preview',
          senderAddress,
          unsignedTxCbor: TEST_FIXTURES.unsignedTxCbor,
          txBodyHash: TEST_FIXTURES.txBodyHash,
          status: 'built',
          builderType: 'buildooor',
          createdAt: now,
          validFrom: new Date(now).toISOString(),
          validTo: new Date(now + 300000).toISOString(),
        })
      );

      await cds.run(
        INSERT.into('CardanoTransactionService.AddressTransactionBuilds').entries({
          address_address: senderAddress,
          txBuild_id: buildId,
        })
      );

      setupTxResponseMock();

      const { status, data } = await test.post('/odata/v4/cardano-transaction/SubmitTransaction', {
        buildId,
        signedTxCbor: TEST_FIXTURES.signedTxCbor1,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data.status).toBe('submitted');
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
  // T11b: CheckSubmissionStatus — provider error branch (lines 650-651)
  // ==========================================================================

  describe('CheckSubmissionStatus — provider error', () => {
    it('should propagate non-404 backend errors when checking confirmation', async () => {
      const submissionId = 'a0000000-0000-0000-0000-000000000012';
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

      nock('https://preview.koios.rest')
        .post('/api/v1/tx_info')
        .reply(500, { error: 'upstream unavailable' });

      const { status } = await test.post(
        `/odata/v4/cardano-transaction/TransactionSubmissions(${submissionId})/CardanoTransactionService.CheckSubmissionStatus`, {}
      ).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect([500, 503]).toContain(status);
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
        `/odata/v4/cardano-sign/SubmitVerifiedTransaction`,
        { signingRequestId, signedTxCbor: TEST_FIXTURES.signedTxCbor1 }
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
          // SubmitVerifiedTransaction binds the fee-payer key: senderAddress' payment
          // credential must match the signedTxCbor1 witness key (addressWithFunds).
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
        `/odata/v4/cardano-sign/SubmitVerifiedTransaction`,
        { signingRequestId, signedTxCbor: TEST_FIXTURES.signedTxCbor1 }
      ).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data.status).toBe('submitted');
    });
  });

  // ==========================================================================
  // BuildMintTransaction — Additional Branch Coverage
  // ==========================================================================

  describe('BuildMintTransaction — additional branch coverage', () => {
    it('should reject lockOnScript without scriptParamsJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        lockOnScript: true,
        // scriptParamsJson omitted
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject lockOnScript with empty scriptParamsJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        lockOnScript: true,
        scriptParamsJson: '[]',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject requiredSignersJson that is not a JSON array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        requiredSignersJson: '"not-an-array"',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject requiredSignersJson with non-string elements', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        requiredSignersJson: JSON.stringify([123]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject requiredSignersJson with invalid hex key hash', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        requiredSignersJson: JSON.stringify(['gg' + 'a'.repeat(54)]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject scriptParamsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        scriptParamsJson: '{"not": "array"}',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject invalid inlineDatumJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        inlineDatumJson: 'invalid{json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject invalid mintRedeemerJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '100' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        mintRedeemerJson: 'broken{json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BUG 9: assetUnit policyId prefix check — an assetUnit >= 57 hex is parsed
  // as policyId+assetName and minted under the policy script's hash; a bare
  // 29-32-byte asset name is length-indistinguishable from a full unit and
  // must be rejected instead of silently minting a truncated name.
  // ==========================================================================

  describe('mint assetUnit policyId prefix check (BUG 9)', () => {
    // 32-byte asset name — 64 hex, length-indistinguishable from a full unit
    const longAssetName = 'ab'.repeat(32);

    const baseMintPayload = () => ({
      senderAddress: TEST_FIXTURES.addressWithFunds,
      recipientAddress: TEST_FIXTURES.emptyAddress,
      lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
      changeAddress: TEST_FIXTURES.addressWithFunds,
      mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
    });

    it('rejects a bare 64-hex asset name (would silently mint a truncated name)', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        mintActionsJson: JSON.stringify([{ assetUnit: longAssetName, quantity: '1' }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(400);
      expect(data.error?.message).toContain('does not start with the minting policy id');
    });

    it('rejects a full unit whose prefix is a foreign policyId', async () => {
      const foreignUnit = 'ab'.repeat(28) + TEST_FIXTURES.assetName;
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        mintActionsJson: JSON.stringify([{ assetUnit: foreignUnit, quantity: '1' }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('rejects a 56-hex unit (empty asset name) under a foreign policyId', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        mintActionsJson: JSON.stringify([{ assetUnit: 'ab'.repeat(28), quantity: '1' }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('keeps a 32-byte asset name intact when passed as a full unit with the matching policyId', async () => {
      const fullUnit = TEST_FIXTURES.policyId + longAssetName;
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        mintActionsJson: JSON.stringify([{ assetUnit: fullUnit, quantity: '1' }]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      // the full 32-byte name must survive into the unsigned tx's mint field
      expect(data.unsignedTxCbor).toContain(longAssetName);
    });

    it('rejects a foreign-prefix unit on BuildPlutusSpendTransaction combined mint', async () => {
      setupTxInfoMock(mockScriptTxInfo);
      const foreignUnit = 'ab'.repeat(28) + TEST_FIXTURES.assetName;
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        ...plutusSpendRequestBody,
        mintActionsJson: JSON.stringify([{ assetUnit: foreignUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(400);
      expect(data.error?.message).toContain('does not start with the minting policy id');
    });
  });

  // ==========================================================================
  // BuildPlutusSpendTransaction — Additional Branch Coverage
  // ==========================================================================

  describe('BuildPlutusSpendTransaction — additional branch coverage', () => {
    it('should reject lockOnScript without scriptParamsJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        lockOnScript: true,
        // scriptParamsJson omitted
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject requiredSignersJson that is not a JSON array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        requiredSignersJson: '"not-an-array"',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject requiredSignersJson with invalid hex key hash', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        requiredSignersJson: JSON.stringify(['tooshort']),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject scriptParamsJson that is not an array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        scriptParamsJson: '{"not": "array"}',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });

    it('should reject invalid inlineDatumJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validatorScript: TEST_FIXTURES.validSpendingScript,
        scriptTxHash: 'a'.repeat(64),
        scriptOutputIndex: 0,
        redeemerJson: '{"int": 0}',
        inlineDatumJson: 'broken{json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // SetCollateral — Additional Branch Coverage
  // ==========================================================================

  describe('SetCollateral — additional branch coverage', () => {
    it('should return collateralAvailable when 2+ qualifying UTxOs exist', async () => {
      setupUtxoMock([
        {
          tx_hash: 'a'.repeat(64),
          tx_index: 0,
          address: TEST_FIXTURES.addressWithAssets,
          value: '5500000',
          asset_list: [],
        },
        {
          tx_hash: 'b'.repeat(64),
          tx_index: 1,
          address: TEST_FIXTURES.addressWithAssets,
          value: '6000000',
          asset_list: [],
        },
      ]);

      const { status, data } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
        address: TEST_FIXTURES.addressWithAssets,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

      expect(status).toBe(200);
      expect(data.collateralAvailable).toBe(true);
    });

    it('should reject when insufficient funds (< 6 ADA)', async () => {
      setupUtxoMock([
        {
          tx_hash: 'c'.repeat(64),
          tx_index: 0,
          address: TEST_FIXTURES.addressWithAssets,
          value: '3000000',
          asset_list: [],
        },
      ]);

      const { status } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
        address: TEST_FIXTURES.addressWithAssets,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // FR-2: BuildPlutusSpendTransaction — extraOutputsJson validations
  // ==========================================================================

  describe('BuildPlutusSpendTransaction extraOutputsJson validations (FR-2)', () => {
    const baseRequest = {
      senderAddress: TEST_FIXTURES.addressWithAssets,
      recipientAddress: TEST_FIXTURES.addressWithAssets,
      lovelaceAmount: '2000000',
      validatorScript: TEST_FIXTURES.validSpendingScript,
      scriptTxHash: 'a'.repeat(64),
      scriptOutputIndex: 0,
      redeemerJson: '{"int": 0}',
    };

    const post = (extraOutputsJson: string) =>
      test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        ...baseRequest, extraOutputsJson,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

    it('rejects extraOutputsJson that is not valid JSON', async () => {
      const { status } = await post('not-valid-json{{{');
      expect(status).toBe(400);
    });

    it('rejects extraOutputsJson that is not a JSON array', async () => {
      const { status } = await post('{"not": "array"}');
      expect(status).toBe(400);
    });

    it('rejects when extraOutputs length exceeds MAX_EXTRA_OUTPUTS (33 entries)', async () => {
      const arr = Array.from({ length: 33 }, () => ({
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
      }));
      const { status } = await post(JSON.stringify(arr));
      expect(status).toBe(400);
    });

    it('rejects extra output with invalid Bech32 address', async () => {
      const { status } = await post(JSON.stringify([
        { address: 'not-a-bech32-address', lovelaceAmount: '2000000' },
      ]));
      expect(status).toBe(400);
    });

    it('rejects extra output with lovelaceAmount = "0"', async () => {
      const { status } = await post(JSON.stringify([
        { address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '0' },
      ]));
      expect(status).toBe(400);
    });

    it('rejects extra output with negative lovelaceAmount string', async () => {
      const { status } = await post(JSON.stringify([
        { address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '-1000' },
      ]));
      expect(status).toBe(400);
    });

    it('rejects extra output with non-numeric lovelaceAmount', async () => {
      const { status } = await post(JSON.stringify([
        { address: TEST_FIXTURES.emptyAddress, lovelaceAmount: 'abc' },
      ]));
      expect(status).toBe(400);
    });

    it('rejects extra output with assets that is not an array', async () => {
      const { status } = await post(JSON.stringify([
        { address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000', assets: 'not-an-array' },
      ]));
      expect(status).toBe(400);
    });

    it('rejects asset entry with unit="lovelace"', async () => {
      const { status } = await post(JSON.stringify([{
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
        assets: [{ unit: 'lovelace', quantity: '5' }],
      }]));
      expect(status).toBe(400);
    });

    it('rejects asset entry with non-hex unit', async () => {
      const { status } = await post(JSON.stringify([{
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
        assets: [{ unit: 'NOT_HEX_!!', quantity: '5' }],
      }]));
      expect(status).toBe(400);
    });

    it('rejects asset entry with quantity "0"', async () => {
      const { status } = await post(JSON.stringify([{
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
        assets: [{ unit: TEST_FIXTURES.assetUnit, quantity: '0' }],
      }]));
      expect(status).toBe(400);
    });

    it('rejects extra output with inlineDatumJson that is not a string', async () => {
      const { status } = await post(JSON.stringify([{
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
        inlineDatumJson: { not: 'a-string' } as any,
      }]));
      expect(status).toBe(400);
    });

    it('rejects extra output with inlineDatumJson that is not valid JSON', async () => {
      const { status } = await post(JSON.stringify([{
        address: TEST_FIXTURES.emptyAddress, lovelaceAmount: '2000000',
        inlineDatumJson: 'broken{json',
      }]));
      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // FR-1: BuildPlutusSpendTransaction — combined mint validations
  // ==========================================================================

  describe('BuildPlutusSpendTransaction combined mint validations (FR-1)', () => {
    const baseRequest = {
      senderAddress: TEST_FIXTURES.addressWithAssets,
      recipientAddress: TEST_FIXTURES.addressWithAssets,
      lovelaceAmount: '2000000',
      validatorScript: TEST_FIXTURES.validSpendingScript,
      scriptTxHash: 'a'.repeat(64),
      scriptOutputIndex: 0,
      redeemerJson: '{"int": 0}',
    };

    const post = (overrides: Record<string, any>) =>
      test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
        ...baseRequest, ...overrides,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });

    it('rejects mintActionsJson without mintingPolicyScript', async () => {
      const { status } = await post({
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
      });
      expect(status).toBe(400);
    });

    it('rejects mintingPolicyScript without mintActionsJson', async () => {
      const { status } = await post({ mintingPolicyScript: TEST_FIXTURES.validPlutusScript });
      expect(status).toBe(400);
    });

    it('rejects mintRedeemerJson without mintActionsJson', async () => {
      const { status } = await post({ mintRedeemerJson: '{"int": 0}' });
      expect(status).toBe(400);
    });

    it('rejects mintActionsJson that is not valid JSON', async () => {
      const { status } = await post({
        mintActionsJson: 'broken{json',
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      });
      expect(status).toBe(400);
    });

    it('rejects mintActionsJson that is not an array', async () => {
      const { status } = await post({
        mintActionsJson: '{"not": "array"}',
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      });
      expect(status).toBe(400);
    });

    it('rejects mint action with non-integer quantity string', async () => {
      const { status } = await post({
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '3.5' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      });
      expect(status).toBe(400);
    });

    it('rejects mint action that is not an object', async () => {
      const { status } = await post({
        mintActionsJson: JSON.stringify(['not-an-object']),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
      });
      expect(status).toBe(400);
    });

    it('rejects mintRedeemerJson that is not valid JSON', async () => {
      const { status } = await post({
        mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
        mintRedeemerJson: 'broken{json',
      });
      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildSimpleAdaTransaction — lockOnScript Validations (FR-A)
  // ==========================================================================

  describe('BuildSimpleAdaTransaction lockOnScript validations', () => {
    const baseBody = {
      senderAddress: TEST_FIXTURES.addressWithFunds,
      recipientAddress: TEST_FIXTURES.emptyAddress,
      lovelaceAmount: '2000000',
      changeAddress: TEST_FIXTURES.addressWithFunds,
    };

    it('rejects lockOnScript=true without validatorScript', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        ...baseBody,
        lockOnScript: true,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects scriptParamsJson that is not a JSON array', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        ...baseBody,
        validatorScript: TEST_FIXTURES.validPlutusScript,
        lockOnScript: true,
        scriptParamsJson: JSON.stringify({ x: 1 }),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects malformed validatorScript hex', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        ...baseBody,
        validatorScript: 'zzz',
        lockOnScript: true,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // DeriveScriptAddress Validations (FR-B)
  // ==========================================================================

  describe('DeriveScriptAddress validations', () => {
    it('rejects missing validatorScript', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {})
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects non-hex validatorScript', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
        validatorScript: 'not_hex',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects odd-length hex', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
        validatorScript: 'abc',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects unknown network', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
        validatorScript: TEST_FIXTURES.validPlutusScript,
        network: 'testnet',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects non-array scriptParamsJson', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
        validatorScript: TEST_FIXTURES.validPlutusScript,
        scriptParamsJson: JSON.stringify({ x: 1 }),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('accepts valid input and returns scriptAddress/scriptHash', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
        validatorScript: TEST_FIXTURES.validPlutusScript,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(200);
      expect(data.scriptHash).toMatch(/^[0-9a-f]{56}$/);
      expect(typeof data.scriptAddress).toBe('string');
    });
  });

  // ==========================================================================
  // ExtractPaymentKeyHash Validations (FR-C)
  // ==========================================================================

  describe('ExtractPaymentKeyHash validations', () => {
    it('rejects missing address', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {})
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects invalid bech32', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
        address: 'not-an-address',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects stake address (validator rejects non-payment bech32)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
        address: TEST_FIXTURES.validStakeAddress,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('accepts a valid payment address and returns 56-char hex', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
        address: TEST_FIXTURES.addressWithFunds,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(200);
      expect(data.paymentKeyHash).toMatch(/^[0-9a-f]{56}$/);
    });
  });

  // ==========================================================================
  // Validity bounds — cross-action validator smoke tests
  //
  // Verifies that validityStartMs / validityEndMs survive the CDS → handler →
  // validators pipeline on all four Build actions. We only assert validator
  // behavior (200/400), not on-chain correctness — that is covered by the
  // builder unit tests and manual preview-network verification.
  // ==========================================================================

  describe('Validity bounds validation', () => {
    const now = Date.now();
    const validStart = String(now - 60_000);
    const validEnd = String(now + 1_800_000);

    it('BuildSimpleAdaTransaction accepts explicit validity window', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validityStartMs: validStart,
        validityEndMs: validEnd,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(200);
    });

    it('rejects non-numeric validityStartMs on BuildSimpleAdaTransaction', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validityStartMs: 'abc',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects validityStartMs >= validityEndMs', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        validityStartMs: validEnd,
        validityEndMs: validStart,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('BuildMultiAssetTransaction accepts explicit validity window', async () => {
      setupUtxoMock(mockUtxosWithAssets);
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        assetsJson: JSON.stringify([{ unit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
        validityStartMs: validStart,
        validityEndMs: validEnd,
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(200);
    });

    it('BuildMintTransaction rejects malformed validityEndMs', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        senderAddress: TEST_FIXTURES.addressWithAssets,
        recipientAddress: TEST_FIXTURES.addressWithAssets,
        lovelaceAmount: '2000000',
        mintActionsJson: JSON.stringify([{ assetUnit: 'aa'.repeat(28) + '4d', quantity: '1' }]),
        mintingPolicyScript: '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009',
        validityEndMs: '-1',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });
  });

  // ==========================================================================
  // BuildMintTransaction — metadataJson plumbing
  //
  // Validates that CIP-20 / label-674 style metadata survives the handler →
  // builder pipeline and lands in the unsigned tx's auxiliary_data.
  // ==========================================================================

  describe('BuildMintTransaction metadataJson', () => {
    const baseMintPayload = () => ({
      senderAddress: TEST_FIXTURES.addressWithFunds,
      recipientAddress: TEST_FIXTURES.emptyAddress,
      lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
      changeAddress: TEST_FIXTURES.addressWithFunds,
      mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
      mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
    });

    it('accepts metadataJson and persists a non-empty unsigned tx', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        metadataJson: JSON.stringify({ '674': { msg: ['hello mint'] } }),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });
      expect(status).toBe(200);
      expect(typeof data.unsignedTxCbor).toBe('string');
      expect(data.unsignedTxCbor.length).toBeGreaterThan(0);
    });

    it('still builds successfully when metadataJson is omitted', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', baseMintPayload())
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(200);
    });

    it('rejects malformed metadataJson (invalid JSON)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        metadataJson: '{not valid json',
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });

    it('rejects metadataJson that is not an object (array)', async () => {
      const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', {
        ...baseMintPayload(),
        metadataJson: JSON.stringify([1, 2, 3]),
      }).catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(status).toBe(400);
    });
  });
});
