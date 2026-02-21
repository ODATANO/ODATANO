import cds from '@sap/cds';
import { createTestContext, resetAppContext, getCardanoClient, shutdownAppContext } from '../../srv/server';
import { TEST_FIXTURES, MOCK_EVALUATED_BUDGET, mockUtxosAdaOnly, multiAssetUtxos, utxosForBurn, mockUtxosWithAssets, simpleRequestBody, mintingRequestBody, metaDataRequestBody, burningRequestBody, multiAssetRequestBody, plutusSpendRequestBody, mockScriptTxInfo, mockScriptTxInfoWithAssets, TestConfiguration } from './test-fixtures';
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
 * across different transaction builders (Buildooor, CSL)
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
      nock.restore();
    });

    afterAll(async () => {
      nock.cleanAll();
      nock.restore();
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
          expect(data.fee).to.be.greaterThan(0);
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
          expect(data.fee).to.be.greaterThan(0);
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
          expect(data.fee).to.be.greaterThan(0);
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
          expect(data.fee).to.be.greaterThan(0);
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
          expect(data.fee).to.be.greaterThan(0);
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
      // lockOnScript Tests (BuildMintTransaction + BuildPlutusSpendTransaction)
      // ============================================================================

      describe('lockOnScript', () => {

        it('POST /BuildMintTransaction - lockOnScript=true without scriptParamsJson has no scriptAddress', async () => {
          const requestBody = {
            ...mintingRequestBody,
            lockOnScript: true
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data.scriptAddress).to.be.oneOf([null, undefined, '']);
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

        it('POST /SetCollateral - rejects 409 when collateral already available', async () => {
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

          const { status } = await test.post('/odata/v4/cardano-transaction/SetCollateral', {
            address: TEST_FIXTURES.addressWithFunds,
          }).catch(err => err.response);

          expect(status).to.equal(409);
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
    });
  });
}
