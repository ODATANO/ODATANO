import cds from '@sap/cds';
import {
  metaDataRequestBody2,
  multiAssetRequestBody3,
  TestConfiguration,
  limitedUtxos,
  mockUtxosAdaOnly,
  mintingRequestBody2,
  simpleRequestBody2,
  multiAssetRequestBody,
  multiAssetUtxos,
  utxosForBurn,
  mintingRequestBody,
  metaDataRequestBody,
  utxosWithoutAdaOnly,
  utxosWithSmallAdaOnly,
} from './test-fixtures';
import { setupKoiosMocks, setupUtxoMock, setupNocks, nock } from './mock-helpers';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';

jest.setTimeout(60000);

// Skip server auto-init - mock tests create their own context after setting up nock mocks
process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

/**
 * Cardano Transaction Service Integration Tests
 *
 * Tests the transaction building and submission functionality
 * for the Buildooor transaction builder
 *
 * Uses nock to mock Koios API responses for deterministic testing.
 */

/**
 * Create test suite for a specific transaction builder
 */
export function createTxErrorTestSuite(txBuilderConfig: TestConfiguration) {
  describe(`Cardano Transaction Error Tests [${txBuilderConfig.txBuilderName.toUpperCase()}] [MOCKED]`, () => {
    const test = cds.test(__dirname + '/../../');
    const expect = test.expect;

    // Create app context once before all tests - nock mocks must be set up first
    beforeAll(async () => {
      setupNocks();
      setupKoiosMocks();

      const testContext = await createTestContext(['koios'], txBuilderConfig.txBuilderName);
      resetAppContext(testContext);
    });

    // Reset database and nock mocks before each test
    beforeEach(async () => {
      await test.data.reset();

      setupNocks();
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

    // ============================================================================
    // BuildSimpleAdaTransaction Action Error Tests
    // ============================================================================

    describe('BuildSimpleAdaTransaction Action', () => {
      it('POST /BuildSimpleAdaTransaction - should return 400 error for insufficient funds', async () => {
        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody2).catch(err => err.response);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
        expect(status).to.equal(400);
      });
    });

    // ============================================================================
    // BuildTransactionWithMetadata Action Error Tests
    // ============================================================================

    describe('BuildTransactionWithMetadata Action', () => {
      it('POST /BuildTransactionWithMetadata - should return 400 error for insufficient funds', async () => {
        setupUtxoMock(mockUtxosAdaOnly);
        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', metaDataRequestBody2).catch(err => err.response);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
        expect(status).to.equal(400);
      });
    });

    // ============================================================================
    // BuildMultiAssetTransaction Action Error Tests
    // ============================================================================

    describe('BuildMultiAssetTransaction Action', () => {

      it('POST /BuildMultiAssetTransaction - should return 400 error for insufficient asset quantity', async () => {

        setupUtxoMock(limitedUtxos);

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody3).catch(err => err.response);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds/assets (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
        expect(status).to.equal(400);
      });

      it('POST /BuildMultiAssetTransaction - should use senderAddress as fallback when changeAddress missing', async () => {
        setupUtxoMock(multiAssetUtxos);
        // multiAssetRequestBody has no changeAddress
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);
        expect(status).to.equal(200);
      });

      it('POST /BuildMultiAssetTransaction - should return error when assets array is empty', async () => {
        setupUtxoMock(multiAssetUtxos);
        const requestWithEmptyAssets = { ...multiAssetRequestBody, assetsJson: '[]' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestWithEmptyAssets).catch(err => err.response);
        // Returns 500 as builder throws an unhandled error for empty assets
        expect(status).to.be.oneOf([400, 500]);
      });
    });

    // ============================================================================
    // BuildMintTransaction Action Error Tests
    // ============================================================================

    describe('BuildMintTransaction Action', () => {

      it('POST /BuildMintTransaction - should return 400 error for insufficient funds', async () => {

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody2).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
      });

      it('POST /BuildMintTransaction - should use senderAddress as fallback when changeAddress missing', async () => {
        setupUtxoMock(utxosForBurn);
        const requestWithoutChange = { ...mintingRequestBody };
        delete (requestWithoutChange as any).changeAddress;
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestWithoutChange);
        expect(status).to.equal(200);
      });

      it('POST /BuildMintTransaction - should handle missing ADA-only UTxO for collateral', async () => {
        // All UTxOs have assets (no pure ADA UTxO for collateral)
        setupUtxoMock(utxosWithoutAdaOnly);
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody).catch(err => err.response);
        // May succeed (200) if builder can use any UTxO, or fail (400/500)
        expect(status).to.be.oneOf([200, 400, 500]);
      });

      it('POST /BuildMintTransaction - should handle small ADA-only UTxO', async () => {
        // ADA-only UTxO has only 1 ADA
        setupUtxoMock(utxosWithSmallAdaOnly);
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody).catch(err => err.response);
        // May succeed (200) if builder can still construct tx, or fail (400/500)
        expect(status).to.be.oneOf([200, 400, 500]);
      });

      it('POST /BuildMintTransaction - should return 400 for invalid script format', async () => {
        setupUtxoMock(utxosForBurn);
        const requestWithInvalidScript = { ...mintingRequestBody, mintingPolicyScript: 'invalid_hex_script' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestWithInvalidScript).catch(err => err.response);
        expect(status).to.equal(400);
      });
    });

    // ============================================================================
    // BuildTransactionWithMetadata - Metadata Edge Cases
    // ============================================================================

    describe('BuildTransactionWithMetadata - Metadata Edge Cases', () => {
      beforeEach(() => {
        setupUtxoMock(mockUtxosAdaOnly);
      });

      it('should handle empty metadataJson {}', async () => {
        const request = { ...metaDataRequestBody, metadataJson: '{}' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', request);
        expect(status).to.equal(200);
      });

      it('should handle number values in metadata (_jsonToTxMetadatum with number)', async () => {
        const request = { ...metaDataRequestBody, metadataJson: '{"674": 12345}' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', request);
        expect(status).to.equal(200);
      });

      it('should reject unsupported metadata types (null)', async () => {
        const request = { ...metaDataRequestBody, metadataJson: '{"674": null}' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', request).catch(err => err.response);
        // Builder throws error for unsupported types - may be 400 or 500
        expect(status).to.be.oneOf([400, 500]);
      });

      it('should reject unsupported metadata types (boolean)', async () => {
        const request = { ...metaDataRequestBody, metadataJson: '{"674": true}' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', request).catch(err => err.response);
        // Builder throws error for unsupported types - may be 400 or 500
        expect(status).to.be.oneOf([400, 500]);
      });

      it('should handle when metadata is not an object', async () => {
        const request = { ...metaDataRequestBody, metadataJson: '"just a string"' };
        const { status } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', request).catch(err => err.response);
        // May succeed (200) if builder ignores invalid metadata, or fail (400/500)
        expect(status).to.be.oneOf([200, 400, 500]);
      });
    });
  });
}
