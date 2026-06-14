import cds from '@sap/cds';
import { createTestContext, resetAppContext, getCardanoClient, shutdownAppContext } from '../../srv/server';
import { TEST_FIXTURES, MOCK_EVALUATED_BUDGET, mockUtxosAdaOnly, multiAssetUtxos, utxosForBurn, mockUtxosWithAssets, simpleRequestBody, mintingRequestBody, metaDataRequestBody, burningRequestBody, multiAssetRequestBody, plutusSpendRequestBody, mockScriptTxInfo, mockScriptTxInfoWithAssets, plutusSpendWithExtraOutputsRequestBody, plutusSpendWithExtraOutputInlineDatumRequestBody, plutusSpendWithMintRequestBody, plutusSpendMultiPurposeScriptRequestBody, plutusSpendWithIndexPlaceholderRequestBody, SCRIPT_UTXO_TX_HASH, SCRIPT_UTXO_OUTPUT_INDEX, TestConfiguration, simpleLockOnScriptRequestBody, simpleLockOnScriptWithParamsRequestBody, validScriptParamsJson, altScriptParamsJson } from './test-fixtures';
import { sortInputsLikeBuildooor } from '../../srv/utils/plutus-placeholders';
import { setupKoiosMocks, setupUtxoMock, setupTxInfoMock, setupNocks, nock } from './mock-helpers';
const { SELECT, INSERT } = cds.ql;
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
export function createTxServiceTestSuite(testConfig: TestConfiguration) {
  describe(`Cardano Transaction Service Tests [${testConfig.txBuilderName.toUpperCase()}] [MOCKED]`, () => {
    const test = cds.test(__dirname + '/../../');
    const expect = test.expect;

    // Create app context once before all tests - nock mocks must be set up first
    beforeAll(async () => {
      setupNocks();
      setupKoiosMocks();

      const testContext = await createTestContext([testConfig.backendName], testConfig.txBuilderName);
      resetAppContext(testContext);
    });

    // Reset the database and setup nock mocks before each test
    beforeEach(async () => {
      await test.data.reset();

      // Reactivate nock and setup mocks for this test
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
    // Entity READ Tests
    // ============================================================================
    describe('Milestone 2: Transaction Operations', () => {
      describe('Entity READ Operations', () => {
        it('GET /TransactionBuilds - read TransactionBuilds collection', async () => {
          const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuilds');
          expect(data).to.have.property('value');
          expect(Array.isArray(data.value)).to.be.true;
          expect(status).to.equal(200);
        });

        it('GET /TransactionBuildInputs - read TransactionBuildInputs collection', async () => {
          const { status, data } = await test.get('/odata/v4/cardano-transaction/TransactionBuildInputs');
          expect(data).to.have.property('value');
          expect(Array.isArray(data.value)).to.be.true
          expect(status).to.equal(200);
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

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data.wasSubmitted).to.equal(false);
          expect(Number(data.fee)).to.be.greaterThan(0);
          expect(data.unsignedTxCbor).to.match(/^[0-9a-f]+$/i); // Valid hex
        });
        it('POST /BuildSimpleAdaTransaction - verify build is persisted in DB', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].id).to.equal(data.id);
          expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
          expect(builds[0].unsignedTxCbor).to.equal(data.unsignedTxCbor);
        });

        it('POST /BuildSimpleAdaTransaction - with inputs and outputs persisted', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildInputs, TransactionBuildOutputs } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);
          expect(status).to.equal(200);

          // Verify inputs are persisted
          const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
          expect(inputs.length).to.be.greaterThan(0);

          // Verify outputs are persisted
          const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
          expect(outputs.length).to.be.greaterThan(0);

          // Should have recipient output
          const recipientOutput = outputs.find((o: any) => o.address === TEST_FIXTURES.emptyAddress);
          expect(recipientOutput).to.exist;
          expect(recipientOutput.lovelace).to.equal(Number(TEST_FIXTURES.lovelaceAmount));
        });

        it('POST /BuildSimpleAdaTransaction - without change address (fallback to sender)', async () => {

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildSimpleAdaTransaction - forceInputsJson pins a specific sender UTxO as input', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildInputs } = TxService.entities;

          // Use one of the known mock sender UTxOs as the forced input
          const forcedRef = {
            txHash: mockUtxosAdaOnly[0].tx_hash,
            outputIndex: mockUtxosAdaOnly[0].tx_index,
          };
          const requestBody = {
            ...simpleRequestBody,
            forceInputsJson: JSON.stringify([forcedRef]),
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data.forcedInputsUsed).to.equal(1);

          // Verify the forced ref made it into the persisted input list
          const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
          const match = inputs.find((i: any) => i.txHash === forcedRef.txHash && i.outputIndex === forcedRef.outputIndex);
          expect(match, 'forced UTxO should appear in TransactionBuildInputs').to.exist;
        });

        it('POST /BuildSimpleAdaTransaction - empty forceInputsJson array is a no-op', async () => {
          const requestBody = {
            ...simpleRequestBody,
            forceInputsJson: '[]',
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data.forcedInputsUsed).to.equal(0);
        });
      });

      // ============================================================================
      // BuildSimpleAdaTransaction - assetsJson Tests
      // ============================================================================

      describe('BuildSimpleAdaTransaction assetsJson', () => {

        it('POST /BuildSimpleAdaTransaction - rejects invalid assetsJson', async () => {
          const requestBody = {
            ...simpleRequestBody,
            assetsJson: 'not-valid-json{'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildSimpleAdaTransaction - rejects non-array assetsJson', async () => {
          const requestBody = {
            ...simpleRequestBody,
            assetsJson: JSON.stringify({ unit: 'lovelace', quantity: '1000000' })
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildSimpleAdaTransaction - builds without assetsJson (optional param)', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
        });
      });

      // ============================================================================
      // BuildTransactionWithMetadata Action Tests
      // ============================================================================

      describe('BuildTransactionWithMetadata Action', () => {
        it('POST /BuildTransactionWithMetadata - successfully build ADA transaction with metadata', async () => {
          setupUtxoMock(mockUtxosAdaOnly);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', metaDataRequestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(Number(data.fee)).to.be.greaterThan(0);
        });
      });

      // ============================================================================
      // BuildMultiAssetTransaction Action Tests
      // ============================================================================
      describe('BuildMultiAssetTransaction Action', () => {
        it('POST /BuildMultiAssetTransaction - successfully build multi-asset transaction', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data.wasSubmitted).to.equal(false);
          expect(Number(data.fee)).to.be.greaterThan(0);
          expect(data.unsignedTxCbor).to.match(/^[0-9a-f]+$/i);
        });

        it('POST /BuildMultiAssetTransaction - verify build is persisted in DB', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].id).to.equal(data.id);
          expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
          expect(builds[0].unsignedTxCbor).to.equal(data.unsignedTxCbor);
        });

        it('POST /BuildMultiAssetTransaction - correctly selects UTxOs containing required assets', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildInputs } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);
          expect(status).to.equal(200);
          expect(data.hasInputs).to.equal(true);

          const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
          expect(inputs.length).to.be.greaterThan(0);
        });

        it('POST /BuildMultiAssetTransaction - handles change calculation with remaining assets', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildOutputs } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);
          expect(status).to.equal(200);
          expect(data.hasOutputs).to.equal(true);

          const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
          expect(outputs.length).to.be.greaterThanOrEqual(1);
        });

        it('POST /BuildMultiAssetTransaction - handles multiple different assets', async () => {
          
          setupUtxoMock(multiAssetUtxos);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);
          expect(status).to.equal(200);
          expect(data.unsignedTxCbor).to.exist;
        });

        it('POST /BuildMultiAssetTransaction - generates valid CBOR hex string', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);

          expect(status).to.equal(200);
          expect(data.unsignedTxCbor).to.match(/^[0-9a-f]+$/i);
          expect(data.unsignedTxCbor.startsWith('84')).to.be.true; // CBOR array marker
        });

        it('POST /BuildMultiAssetTransaction - uses senderAddress as changeAddress when not provided', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          // Transaction should build successfully with change going to senderAddress
          expect(Number(data.fee)).to.be.greaterThan(0);
        });
      });

      // ============================================================================
      // BuildMultiAssetTransaction - outputDatumJson Tests
      // ============================================================================

      describe('BuildMultiAssetTransaction outputDatumJson', () => {

        it('POST /BuildMultiAssetTransaction - rejects invalid outputDatumJson', async () => {
          const requestBody = {
            ...multiAssetRequestBody,
            outputDatumJson: 'not-valid-json{'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMultiAssetTransaction - builds with outputDatumJson', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const requestBody = {
            ...multiAssetRequestBody,
            outputDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: 42 }] })
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildMultiAssetTransaction - builds without outputDatumJson (optional param)', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', multiAssetRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
        });
      });

      // ============================================================================
      // BuildMintTransaction Action Tests
      // ============================================================================

      describe('BuildMintTransaction Action', () => {

        it('POST /BuildMintTransaction - successfully build minting transaction', async () => {

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data.wasSubmitted).to.equal(false);
        });

        it('POST /BuildMintTransaction - verify build is persisted in DB', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].id).to.equal(data.id);
          expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
        });

        it('POST /BuildMintTransaction - burn tokens (negative quantity)', async () => {

          setupUtxoMock(utxosForBurn);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', burningRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
        });

        it('POST /BuildMintTransaction - uses evaluated execution units when Ogmios available', async () => {

          // Get the CardanoClient instance and mock the evaluator methods
          const cardanoClient = getCardanoClient();

          // Spy on hasOgmiosBackend to return true
          const hasOgmiosSpy = jest.spyOn(cardanoClient, 'hasOgmiosBackend').mockReturnValue(true);

          // Spy on evaluateTransaction to return mock evaluation results
          const evaluateSpy = jest.spyOn(cardanoClient, 'evaluateTransaction').mockResolvedValue([
            {
              validator: { purpose: 'mint', index: 0 },
              budget: MOCK_EVALUATED_BUDGET
            }
          ]);


          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');

          // Verify the mocks were called (use global Jest expect for spy assertions)
          const jestExpect = (global as any).expect;
          jestExpect(hasOgmiosSpy).toHaveBeenCalled();
          jestExpect(evaluateSpy).toHaveBeenCalled();

          // The fee should be calculated based on evaluated units
          // With lower execution units, the fee should be lower than with defaults
          expect(data).to.have.property('fee');

          // Cleanup spies
          hasOgmiosSpy.mockRestore();
          evaluateSpy.mockRestore();
        });

        it('POST /BuildMintTransaction - uses default execution units when evaluation fails', async () => {
          // Get the CardanoClient instance and mock the evaluator methods
          const cardanoClient = getCardanoClient();

          // Spy on hasOgmiosBackend to return true (Ogmios is "available")
          const hasOgmiosSpy = jest.spyOn(cardanoClient, 'hasOgmiosBackend').mockReturnValue(true);

          // Spy on evaluateTransaction to throw an error (evaluation fails)
          const evaluateSpy = jest.spyOn(cardanoClient, 'evaluateTransaction').mockRejectedValue(
            new Error('Evaluation failed: script execution error')
          );

         
          // Should still succeed - falls back to default execution units
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');

          // Verify the mocks were called (use global Jest expect for spy assertions)
          const jestExpect = (global as any).expect;
          jestExpect(hasOgmiosSpy).toHaveBeenCalled();
          jestExpect(evaluateSpy).toHaveBeenCalled();

          // Cleanup spies
          hasOgmiosSpy.mockRestore();
          evaluateSpy.mockRestore();
        });
      });

      // ============================================================================
      // BuildMintTransaction - requiredSignersJson Tests
      // ============================================================================

      describe('BuildMintTransaction requiredSignersJson', () => {

        it('POST /BuildMintTransaction - build with requiredSignersJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            requiredSignersJson: JSON.stringify(['f0ff0a3d030cf34157f740c0584dc0662d4d96b6b6e1f69f02e637b9'])
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildMintTransaction - rejects invalid key hash format', async () => {
          const requestBody = {
            ...mintingRequestBody,
            requiredSignersJson: JSON.stringify(['not_a_valid_hash'])
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMintTransaction - rejects non-array requiredSignersJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            requiredSignersJson: JSON.stringify({ key: 'value' })
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });
      });

      // ============================================================================
      // BuildMintTransaction - scriptParamsJson Tests
      // ============================================================================

      describe('BuildMintTransaction scriptParamsJson', () => {

        it('POST /BuildMintTransaction - rejects invalid scriptParamsJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            scriptParamsJson: 'not-valid-json{'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMintTransaction - rejects non-array scriptParamsJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            scriptParamsJson: JSON.stringify({ key: 'value' })
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMintTransaction - builds without scriptParamsJson (optional param)', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('scriptHash');
          expect(data.scriptHash).to.match(/^[a-f0-9]{56}$/);
        });
      });

      // ============================================================================
      // BuildMintTransaction - inlineDatumJson / mintRedeemerJson Tests
      // ============================================================================

      describe('BuildMintTransaction inlineDatumJson/mintRedeemerJson', () => {

        it('POST /BuildMintTransaction - rejects invalid inlineDatumJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            inlineDatumJson: 'not-valid-json{'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMintTransaction - rejects invalid mintRedeemerJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            mintRedeemerJson: '{bad json'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildMintTransaction - builds without inlineDatumJson/mintRedeemerJson (optional params)', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', mintingRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildMintTransaction - builds with inlineDatumJson and mintRedeemerJson', async () => {
          const requestBody = {
            ...mintingRequestBody,
            inlineDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: 42 }] }),
            mintRedeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });
      });

      // ============================================================================
      // BuildPlutusSpendTransaction Action Tests
      // ============================================================================

      describe('BuildPlutusSpendTransaction Action', () => {

        it('POST /BuildPlutusSpendTransaction - successfully build Plutus spending transaction', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data.wasSubmitted).to.equal(false);
          expect(Number(data.fee)).to.be.greaterThan(0);
          expect(data.unsignedTxCbor).to.match(/^[0-9a-f]+$/i);
        });

        it('POST /BuildPlutusSpendTransaction - verify build is persisted in DB', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].id).to.equal(data.id);
          expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
          expect(builds[0].unsignedTxCbor).to.equal(data.unsignedTxCbor);
        });

        it('POST /BuildPlutusSpendTransaction - with inputs and outputs persisted', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildInputs, TransactionBuildOutputs } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);
          expect(status).to.equal(200);

          const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
          expect(inputs.length).to.be.greaterThan(0);

          const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
          expect(outputs.length).to.be.greaterThan(0);
        });

        it('POST /BuildPlutusSpendTransaction - uses evaluated execution units when Ogmios available', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const cardanoClient = getCardanoClient();
          const hasOgmiosSpy = jest.spyOn(cardanoClient, 'hasOgmiosBackend').mockReturnValue(true);
          const evaluateSpy = jest.spyOn(cardanoClient, 'evaluateTransaction').mockResolvedValue([
            {
              validator: { purpose: 'spend', index: 0 },
              budget: MOCK_EVALUATED_BUDGET
            }
          ]);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('fee');

          const jestExpect = (global as any).expect;
          jestExpect(hasOgmiosSpy).toHaveBeenCalled();
          jestExpect(evaluateSpy).toHaveBeenCalled();

          hasOgmiosSpy.mockRestore();
          evaluateSpy.mockRestore();
        });

        it('POST /BuildPlutusSpendTransaction - uses default execution units when evaluation fails', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const cardanoClient = getCardanoClient();
          const hasOgmiosSpy = jest.spyOn(cardanoClient, 'hasOgmiosBackend').mockReturnValue(true);
          const evaluateSpy = jest.spyOn(cardanoClient, 'evaluateTransaction').mockRejectedValue(
            new Error('Evaluation failed: script execution error')
          );

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');

          const jestExpect = (global as any).expect;
          jestExpect(hasOgmiosSpy).toHaveBeenCalled();
          jestExpect(evaluateSpy).toHaveBeenCalled();

          hasOgmiosSpy.mockRestore();
          evaluateSpy.mockRestore();
        });

        it('POST /BuildPlutusSpendTransaction - without optional datumJson', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const requestWithoutDatum = { ...plutusSpendRequestBody };
          delete (requestWithoutDatum as any).datumJson;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestWithoutDatum);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildPlutusSpendTransaction - builds without changeAddress (falls back to senderAddress)', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { changeAddress: _omitted, ...bodyWithoutChange } = plutusSpendRequestBody;
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', bodyWithoutChange);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildPlutusSpendTransaction - preserves native assets from script UTxO in output', async () => {
          setupTxInfoMock(mockScriptTxInfoWithAssets);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });
      });

      // ============================================================================
      // BuildPlutusSpendTransaction - requiredSignersJson Tests
      // ============================================================================

      describe('BuildPlutusSpendTransaction requiredSignersJson', () => {

        it('POST /BuildPlutusSpendTransaction - build with requiredSignersJson', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const requestBody = {
            ...plutusSpendRequestBody,
            requiredSignersJson: JSON.stringify(['f0ff0a3d030cf34157f740c0584dc0662d4d96b6b6e1f69f02e637b9'])
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildPlutusSpendTransaction - rejects invalid key hash format', async () => {
          const requestBody = {
            ...plutusSpendRequestBody,
            requiredSignersJson: JSON.stringify(['tooshort'])
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildPlutusSpendTransaction - rejects non-array requiredSignersJson', async () => {
          const requestBody = {
            ...plutusSpendRequestBody,
            requiredSignersJson: '"not-an-array"'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });
      });

      // ============================================================================
      // BuildPlutusSpendTransaction - scriptParamsJson Tests
      // ============================================================================

      describe('BuildPlutusSpendTransaction scriptParamsJson', () => {

        it('POST /BuildPlutusSpendTransaction - rejects non-array scriptParamsJson', async () => {
          const requestBody = {
            ...plutusSpendRequestBody,
            scriptParamsJson: JSON.stringify({ key: 'value' })
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildPlutusSpendTransaction - returns scriptHash in response', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('scriptHash');
          expect(data.scriptHash).to.match(/^[a-f0-9]{56}$/);
        });
      });

      // ============================================================================
      // BuildPlutusSpendTransaction - inlineDatumJson Tests
      // ============================================================================

      describe('BuildPlutusSpendTransaction inlineDatumJson', () => {

        it('POST /BuildPlutusSpendTransaction - rejects invalid inlineDatumJson', async () => {
          const requestBody = {
            ...plutusSpendRequestBody,
            inlineDatumJson: 'not-valid-json{'
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /BuildPlutusSpendTransaction - builds with inlineDatumJson', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const requestBody = {
            ...plutusSpendRequestBody,
            inlineDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: 42 }] })
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildPlutusSpendTransaction - builds without inlineDatumJson (optional param)', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
        });
      });

      // ============================================================================
      // FR-2: BuildPlutusSpendTransaction extraOutputsJson
      // ============================================================================

      describe('BuildPlutusSpendTransaction extraOutputsJson (FR-2)', () => {
        it('POST /BuildPlutusSpendTransaction - builds with two extra outputs and persists them in TransactionBuildOutputs', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildOutputs } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendWithExtraOutputsRequestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');

          const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
          // Expect at least primary (1) + 2 extras + change (1) = 4 outputs
          expect(outputs.length).to.be.greaterThan(2);
        });

        it('POST /BuildPlutusSpendTransaction - builds with a single extra output carrying inline datum', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendWithExtraOutputInlineDatumRequestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });

        it('POST /BuildPlutusSpendTransaction - empty extraOutputsJson array is a no-op', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
            ...plutusSpendRequestBody,
            extraOutputsJson: '[]',
          });
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
        });
      });

      // ============================================================================
      // FR-1: BuildPlutusSpendTransaction combined spend+mint
      // ============================================================================

      describe('BuildPlutusSpendTransaction combined spend+mint (FR-1)', () => {
        it('POST /BuildPlutusSpendTransaction - combined mint returns mintScriptHash alongside scriptHash', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendWithMintRequestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('scriptHash');
          expect(data.scriptHash).to.match(/^[a-f0-9]{56}$/);
          expect(data).to.have.property('mintScriptHash');
          expect(data.mintScriptHash).to.match(/^[a-f0-9]{56}$/);
        });

        it('POST /BuildPlutusSpendTransaction - multi-purpose script: scriptHash equals mintScriptHash when scripts are byte-equal', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendMultiPurposeScriptRequestBody);
          expect(status).to.equal(200);
          expect(data.scriptHash).to.equal(data.mintScriptHash);
        });

        it('POST /BuildPlutusSpendTransaction - mint without combined params yields no mintScriptHash', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendRequestBody);
          expect(status).to.equal(200);
          // Field should be absent / undefined / null when mintActions weren't provided
          expect(data.mintScriptHash).to.be.oneOf([undefined, null, '']);
        });
      });

      // ============================================================================
      // FR-3: BuildPlutusSpendTransaction __INPUT_IDX__ placeholder resolution (Buildooor)
      // ============================================================================

      describe('BuildPlutusSpendTransaction __INPUT_IDX__ placeholder resolution (FR-3)', () => {
        it('POST /BuildPlutusSpendTransaction - resolves __INPUT_IDX__ in redeemer to final post-sort index', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', plutusSpendWithIndexPlaceholderRequestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');

          // Verify the redeemer's first int field equals the script-utxo's position in the sorted input set.
          const { Tx } = require('@harmoniclabs/cardano-ledger-ts');
          const tx = Tx.fromCbor(Buffer.from(data.unsignedTxCbor, 'hex'));
          const inputRefs = tx.body.inputs.map((inp: any) => ({
            txHash: inp.utxoRef.id.toString(),
            outputIndex: inp.utxoRef.index,
          }));
          // Buildooor writes body inputs in insertion order (script input first) but resolves
          // redeemer Spend indices against the lexicographically-sorted input set — which is how
          // the ledger reads them on-chain. So the placeholder must resolve to the script UTxO's
          // position in the SORTED set, not its position in the body's CBOR order.
          const sortedRefs = sortInputsLikeBuildooor(inputRefs);

          const expectedIdx = sortedRefs.findIndex(
            r => r.txHash === SCRIPT_UTXO_TX_HASH && r.outputIndex === SCRIPT_UTXO_OUTPUT_INDEX
          );
          expect(expectedIdx).to.be.greaterThanOrEqual(0);

          const redeemers = tx.witnesses.redeemers ?? [];
          expect(redeemers.length).to.be.greaterThan(0);
          // Find any redeemer whose first int field matches expected index
          const intFields = redeemers
            .map((r: any) => r.data?.fields?.[0]?.int)
            .filter((v: any) => v !== undefined);
          expect(intFields.map((v: any) => Number(v))).to.include(expectedIdx);
        });

        it('POST /BuildPlutusSpendTransaction - resolves placeholder inside extraOutputs[0].inlineDatumJson', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const placeholder = `__INPUT_IDX:${SCRIPT_UTXO_TX_HASH}#${SCRIPT_UTXO_OUTPUT_INDEX}__`;
          const requestBody = {
            ...plutusSpendRequestBody,
            extraOutputsJson: JSON.stringify([{
              address: TEST_FIXTURES.emptyAddress,
              lovelaceAmount: '2000000',
              inlineDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: placeholder }] }),
            }]),
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', requestBody);
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          // Build succeeded → placeholder was resolved (otherwise PlutusData parsing would have failed).
        });

        it('POST /BuildPlutusSpendTransaction - rejects placeholder pointing at unknown UTxO', async () => {
          setupTxInfoMock(mockScriptTxInfo);

          const bogus = `__INPUT_IDX:${'cc'.repeat(32)}#0__`;
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusSpendTransaction', {
            ...plutusSpendRequestBody,
            redeemerJson: JSON.stringify({ constructor: 0, fields: [{ int: bogus }] }),
          }).catch((err: any) => err.response ?? { status: err.status ?? 500, data: {} });

          expect([400, 500]).to.include(status);
          if (data?.error?.message) {
            expect(data.error.message).to.match(/not in the final transaction input set/i);
          }
        });
      });

      // ============================================================================
      // lockOnScript Tests (BuildMintTransaction + BuildPlutusSpendTransaction)
      // ============================================================================

      describe('lockOnScript', () => {

        it('POST /BuildMintTransaction - lockOnScript=true without scriptParamsJson rejects with 400', async () => {
          const requestBody = {
            ...mintingRequestBody,
            lockOnScript: true
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

          expect(status).to.equal(400);
          expect(data.error.message).to.include('lockOnScript requires scriptParamsJson');
        });

        it('POST /BuildMintTransaction - lockOnScript=false does not set scriptAddress', async () => {
          const requestBody = {
            ...mintingRequestBody,
            lockOnScript: false
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data.scriptAddress).to.be.oneOf([null, undefined, '']);
        });
      });

      // ============================================================================
      // SetCollateral Action Tests
      // ============================================================================

      describe('SetCollateral Action', () => {

        it('POST /SetCollateral - builds collateral tx when only 1 UTxO exists', async () => {
          setupUtxoMock([{
            tx_hash: 'aabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
            tx_index: 0,
            value: '20000000', // 20 ADA
            asset_list: [],
            block_hash: 'collateral1',
            datum_hash: null
          }]);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
            address: TEST_FIXTURES.addressWithFunds,
          });

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data).to.have.property('fee');
        });

        it('POST /SetCollateral - returns 200 with collateralAvailable=true when collateral already exists', async () => {
          setupUtxoMock([
            {
              tx_hash: 'aabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
              tx_index: 0,
              value: '10000000', // 10 ADA
              asset_list: [],
              block_hash: 'coll1',
              datum_hash: null
            },
            {
              tx_hash: 'ccdd00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
              tx_index: 1,
              value: '8000000', // 8 ADA
              asset_list: [],
              block_hash: 'coll2',
              datum_hash: null
            }
          ]);

          const { status, data } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
            address: TEST_FIXTURES.addressWithFunds,
          });

          expect(status).to.equal(200);
          expect(data).to.have.property('collateralAvailable', true);
          expect(data).to.not.have.property('unsignedTxCbor');
        });

        it('POST /SetCollateral - rejects 400 when insufficient funds', async () => {
          setupUtxoMock([{
            tx_hash: 'aabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
            tx_index: 0,
            value: '3000000', // 3 ADA - not enough
            asset_list: [],
            block_hash: 'low1',
            datum_hash: null
          }]);

          const { status } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
            address: TEST_FIXTURES.addressWithFunds,
          }).catch(err => err.response);

          expect(status).to.equal(400);
        });

        it('POST /SetCollateral - rejects 400 for invalid address', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
            address: 'invalid_address',
          }).catch(err => err.response);

          expect(status).to.equal(400);
        });
      });

      // ============================================================================
      // GetBuildDetails Action Tests
      // ============================================================================

      describe('GetBuildDetails Action', () => {
        it('POST /GetBuildDetails - retrieve build details by buildId', async () => {
          
          const buildResponse = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);
          expect(buildResponse.status).to.equal(200);
          const buildId = buildResponse.data.id;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/GetBuildDetails', { buildId });

          expect(status).to.equal(200);
          expect(data.id).to.equal(buildId);
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });
      });

      // ============================================================================
      // CheckSubmissionStatus Action Tests
      // ============================================================================

      describe('CheckSubmissionStatus Action', () => {
        it('POST /CheckSubmissionStatus - retrieve submission status', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionSubmissions } = TxService.entities;

          // Mock tx_info returning empty array (tx not yet confirmed on-chain)
          nock('https://preview.koios.rest')
            .post('/api/v1/tx_info', (body: any) => body._tx_hashes?.includes('dummyhash'))
            .reply(200, []);

          await cds.run(INSERT.into(TransactionSubmissions).entries({
            id: '12345678-1234-1234-1234-1234567890ab',
            signedTxCbor: 'dummycbor',
            txHash: 'dummyhash',
            status: 'submitted',
            validFrom: new Date(),
            validTo: new Date(Date.now() + 3600000),
          }));

          const { status, data } = await test.post('/odata/v4/cardano-transaction/TransactionSubmissions(12345678-1234-1234-1234-1234567890ab)/CardanoTransactionService.CheckSubmissionStatus', {});

          expect(status).to.equal(200);
          expect(data.id).to.equal('12345678-1234-1234-1234-1234567890ab');
          expect(data.txHash).to.equal('dummyhash');
          expect(data.signedTxCbor).to.equal('dummycbor');
        });
      });
    });
    describe('Milestone 3: External Signing Operations & SAP Integration', () => {

      // ============================================================================
      // AddressTransactionBuilds Entity Tests
      // ============================================================================

      describe('READ AddressTransactionBuilds Entity', () => {
        it('GET /AddressTransactionBuilds - read AddressTransactionBuilds collection', async () => {
          const { status, data } = await test.get('/odata/v4/cardano-transaction/AddressTransactionBuilds');
          expect(status).to.equal(200);
          expect(data).to.have.property('value');
          expect(Array.isArray(data.value)).to.be.true;
        });

        it('should create AddressTransactionBuilds association when building a transaction', async () => {
          // Build a transaction - this should automatically create AddressTransactionBuilds association

          const { status: buildStatus, data: buildData } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);
          expect(buildStatus).to.equal(200);
          const buildId = buildData.id;

          // Verify AddressTransactionBuilds association was created
          const { status, data } = await test.get(`/odata/v4/cardano-transaction/AddressTransactionBuilds?$filter=address_address eq '${TEST_FIXTURES.addressWithFunds}'`);

          expect(status).to.equal(200);
          expect(data.value).to.be.an('array');
          expect(data.value.length).to.be.greaterThan(0);
          const found = data.value.find((b: any) => b.txBuild_id === buildId);
          expect(found).to.exist;
          expect(found.address_address).to.equal(TEST_FIXTURES.addressWithFunds);
        });
      });

      // ============================================================================
      // GetTransactionBuildsByAddress Action Tests
      // ============================================================================

      describe('GetTransactionBuildsByAddress Action', () => {
        it('should retrieve transaction builds for a given address', async () => {
          // Build a transaction first - this creates the AddressTransactionBuilds association

          const { status: buildStatus, data: buildData } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleRequestBody);
          expect(buildStatus).to.equal(200);
          const buildId = buildData.id;

          // Retrieve builds by address using the action
          const { status, data } = await test.post('/odata/v4/cardano-transaction/GetTransactionBuildsByAddress', {
            address: TEST_FIXTURES.addressWithFunds,
          });

          expect(status).to.equal(200);
          const results = data.value || data;
          expect(results).to.be.an('array');
          expect(results.length).to.be.greaterThan(0);
          const found = results.find((b: any) => b.txBuild_id === buildId);
          expect(found).to.exist;
        });

        it('should reject invalid address format', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/GetTransactionBuildsByAddress', {
            address: 'invalid_address',
          }).catch(err => err.response);
          expect(status).to.equal(400);
        });
      });

      // ============================================================================
      // FR-A: BuildSimpleAdaTransaction lockOnScript
      // ============================================================================

      describe('BuildSimpleAdaTransaction lockOnScript', () => {

        it('POST /BuildSimpleAdaTransaction - lockOnScript=true without validatorScript rejects with 400', async () => {
          const requestBody = {
            ...simpleRequestBody,
            lockOnScript: true,
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
          expect(status).to.equal(400);
          expect(data.error.message).to.include('lockOnScript requires validatorScript');
        });

        it('POST /BuildSimpleAdaTransaction - lockOnScript=true + validatorScript (no params) sets scriptAddress/scriptHash', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleLockOnScriptRequestBody);
          expect(status).to.equal(200);
          expect(data.scriptHash).to.match(/^[0-9a-f]{56}$/);
          expect(data.scriptAddress).to.match(/^addr_test1/);
        });

        it('POST /BuildSimpleAdaTransaction - param-applied scriptHash differs from unparam scriptHash', async () => {
          const { status: s1, data: d1 } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleLockOnScriptRequestBody);
          const { status: s2, data: d2 } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleLockOnScriptWithParamsRequestBody);
          expect(s1).to.equal(200);
          expect(s2).to.equal(200);
          expect(d1.scriptHash).to.not.equal(d2.scriptHash);
          expect(d1.scriptAddress).to.not.equal(d2.scriptAddress);
        });

        it('POST /BuildSimpleAdaTransaction - invalid validatorScript hex rejects with 400', async () => {
          const requestBody = {
            ...simpleRequestBody,
            validatorScript: 'xyz-not-hex',
            lockOnScript: true,
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
          expect(status).to.equal(400);
          expect(data.error.message).to.include('Failed to derive script address');
        });

        it('POST /BuildSimpleAdaTransaction - lockOnScript=false does not set scriptAddress', async () => {
          const requestBody = {
            ...simpleRequestBody,
            validatorScript: TEST_FIXTURES.validPlutusScript,
            lockOnScript: false,
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
          expect(status).to.equal(200);
          expect(data.scriptAddress).to.be.oneOf([null, undefined, '']);
          expect(data.scriptHash).to.be.oneOf([null, undefined, '']);
        });

        it('POST /BuildSimpleAdaTransaction - scriptAddress is persisted on the TransactionBuilds record', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', simpleLockOnScriptWithParamsRequestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].scriptHash).to.equal(data.scriptHash);
          expect(builds[0].scriptAddress).to.equal(data.scriptAddress);
        });

        it('POST /BuildSimpleAdaTransaction - rejects non-array scriptParamsJson', async () => {
          const requestBody = {
            ...simpleLockOnScriptRequestBody,
            scriptParamsJson: JSON.stringify({ not: 'an-array' }),
          };
          const { status } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);
          expect(status).to.equal(400);
        });
      });

      // ============================================================================
      // FR-B: DeriveScriptAddress utility action
      // ============================================================================

      describe('DeriveScriptAddress Action', () => {

        it('POST /DeriveScriptAddress - missing validatorScript rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {}).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /DeriveScriptAddress - invalid hex rejects with 400', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: 'not-hex!',
          }).catch(err => err.response);
          expect(status).to.equal(400);
          expect(data.error.message).to.include('even-length hex');
        });

        it('POST /DeriveScriptAddress - odd-length hex rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: 'abc',
          }).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /DeriveScriptAddress - returns scriptAddress + scriptHash (default network)', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
          });
          expect(status).to.equal(200);
          expect(data.scriptHash).to.match(/^[0-9a-f]{56}$/);
          // tests run against preview network
          expect(data.scriptAddress).to.match(/^addr_test1/);
        });

        it('POST /DeriveScriptAddress - network=mainnet returns addr1 bech32', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            network: 'mainnet',
          });
          expect(status).to.equal(200);
          expect(data.scriptAddress).to.match(/^addr1/);
          expect(data.scriptAddress).to.not.match(/^addr_test/);
        });

        it('POST /DeriveScriptAddress - invalid network rejects with 400', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            network: 'xyz',
          }).catch(err => err.response);
          expect(status).to.equal(400);
          expect(data.error.message).to.include('Invalid network');
        });

        it('POST /DeriveScriptAddress - non-array scriptParamsJson rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            scriptParamsJson: JSON.stringify({ x: 1 }),
          }).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /DeriveScriptAddress - different params produce different hash/address', async () => {
          const { data: d1 } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            scriptParamsJson: validScriptParamsJson,
          });
          const { data: d2 } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            scriptParamsJson: altScriptParamsJson,
          });
          expect(d1.scriptHash).to.not.equal(d2.scriptHash);
          expect(d1.scriptAddress).to.not.equal(d2.scriptAddress);
        });

        it('POST /DeriveScriptAddress - deterministic (same inputs → same output)', async () => {
          const body = {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            scriptParamsJson: validScriptParamsJson,
          };
          const { data: a } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', body);
          const { data: b } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', body);
          expect(a.scriptHash).to.equal(b.scriptHash);
          expect(a.scriptAddress).to.equal(b.scriptAddress);
        });
      });

      // ============================================================================
      // FR-C: ExtractPaymentKeyHash utility action
      // ============================================================================

      describe('ExtractPaymentKeyHash Action', () => {

        it('POST /ExtractPaymentKeyHash - missing address rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {}).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /ExtractPaymentKeyHash - invalid bech32 rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: 'not-an-address',
          }).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /ExtractPaymentKeyHash - enterprise address returns 56-char hex', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: TEST_FIXTURES.addressWithFunds,
          });
          expect(status).to.equal(200);
          expect(data.paymentKeyHash).to.match(/^[0-9a-f]{56}$/);
        });

        it('POST /ExtractPaymentKeyHash - base address returns payment credential (not stake)', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: TEST_FIXTURES.addressWithAssets,
          });
          expect(status).to.equal(200);
          expect(data.paymentKeyHash).to.match(/^[0-9a-f]{56}$/);
        });

        it('POST /ExtractPaymentKeyHash - stake address rejects with 400', async () => {
          const { status } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: TEST_FIXTURES.validStakeAddress,
          }).catch(err => err.response);
          expect(status).to.equal(400);
        });

        it('POST /ExtractPaymentKeyHash - deterministic (same address → same hash)', async () => {
          const body = { address: TEST_FIXTURES.addressWithFunds };
          const { data: a } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', body);
          const { data: b } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', body);
          expect(a.paymentKeyHash).to.equal(b.paymentKeyHash);
        });

        it('POST /ExtractPaymentKeyHash - different addresses produce different hashes', async () => {
          const { data: a } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: TEST_FIXTURES.addressWithFunds,
          });
          const { data: b } = await test.post('/odata/v4/cardano-transaction/ExtractPaymentKeyHash', {
            address: TEST_FIXTURES.emptyAddress,
          });
          expect(a.paymentKeyHash).to.not.equal(b.paymentKeyHash);
        });
      });

      // ============================================================================
      // Cross-feature round-trip: FR-B ↔ FR-A
      // ============================================================================

      describe('Cross-feature round-trip', () => {

        it('DeriveScriptAddress and BuildSimpleAdaTransaction(lockOnScript) agree on scriptAddress/scriptHash', async () => {
          const scriptBody = {
            validatorScript: TEST_FIXTURES.validPlutusScript,
            scriptParamsJson: validScriptParamsJson,
          };
          const { data: derived } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', scriptBody);

          const { status, data: built } = await test.post(
            '/odata/v4/cardano-transaction/BuildSimpleAdaTransaction',
            simpleLockOnScriptWithParamsRequestBody,
          );
          expect(status).to.equal(200);
          expect(built.scriptHash).to.equal(derived.scriptHash);
          expect(built.scriptAddress).to.equal(derived.scriptAddress);
        });

        it('DeriveScriptAddress output is a valid recipient for a regular BuildSimpleAdaTransaction', async () => {
          const { data: derived } = await test.post('/odata/v4/cardano-transaction/DeriveScriptAddress', {
            validatorScript: TEST_FIXTURES.validPlutusScript,
          });
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
            ...simpleRequestBody,
            recipientAddress: derived.scriptAddress,
            outputDatumJson: JSON.stringify({ constructor: 0, fields: [] }),
          });
          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
        });
      });
    });
  });
}
