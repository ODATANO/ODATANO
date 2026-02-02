import cds from '@sap/cds';
import nock from 'nock';
import { TxBuilderTestConfig } from './backend-test-helper';
import { createTestContext, resetAppContext, getCardanoClient, shutdownAppContext } from '../../srv/server';

const { SELECT, INSERT } = cds.ql;
jest.setTimeout(60000);

/**
 * Cardano Transaction Service Integration Tests
 *
 * Tests the transaction building and submission functionality
 * across different transaction builders (Buildooor, CSL)
 *
 * Uses nock to mock Koios API responses for deterministic testing.
 */

// ============================================================================
// Mock Data Fixtures
// ============================================================================

// Test data fixtures for preview network
const FIXTURE = {
  validSenderAddress: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
  validRecipientAddress: 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622',
  lovelaceAmount: '5000000', // 5 ADA
  invalidAddress: 'invalid_address',
  invalidLovelaceAmount: 'not_a_number',
  policyId: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea',
  assetName: '546f6b656e4d', // "TokenM" in hex
  assetUnit: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea546f6b656e4d'
};

// Mock UTxOs with ADA only (Koios /address_utxos response format)
// Koios returns: value (lovelace as string), asset_list (array of native assets)
const mockUtxosAdaOnly = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '15000000', // 15 ADA (lovelace as string)
    asset_list: [],
    block_hash: 'a1b2c3d4e5f6',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 1,
    value: '10000000', // 10 ADA
    asset_list: [],
    block_hash: 'b2c3d4e5f6g7',
    datum_hash: null
  }
];

// Mock UTxOs with native assets (Koios /address_utxos response format)
const mockUtxosWithAssets = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '10000000', // 10 ADA (lovelace)
    asset_list: [
      { policy_id: FIXTURE.policyId, asset_name: FIXTURE.assetName, quantity: '1000' }
    ],
    block_hash: 'a1b2c3d4',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 0,
    value: '5000000', // 5 ADA
    asset_list: [
      { policy_id: FIXTURE.policyId, asset_name: FIXTURE.assetName, quantity: '500' }
    ],
    block_hash: 'e5f6g7h8',
    datum_hash: null
  }
];

// PlutusV3 cost model (297 parameters) - minimal valid values for testing
const PLUTUS_V3_COST_MODEL = Array(297).fill(1000);

// Mock protocol parameters (Koios /cli_protocol_params format)
const mockProtocolParams = {
  txFeePerByte: 44,
  txFeeFixed: 155381,
  maxTxSize: 16384,
  maxBlockHeaderSize: 1100,
  maxBlockBodySize: 65536,
  stakeAddressDeposit: 2000000,
  stakePoolDeposit: 500000000,
  poolRetireMaxEpoch: 18,
  stakePoolTargetNum: 500,
  poolPledgeInfluence: 0.3,
  monetaryExpansion: 0.003,
  treasuryCut: 0.2,
  minPoolCost: 340000000,
  protocolVersion: { major: 8, minor: 0 },
  executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
  maxTxExecutionUnits: { memory: 14000000, steps: 10000000000 },
  maxBlockExecutionUnits: { memory: 62000000, steps: 20000000000 },
  maxValueSize: 5000,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  utxoCostPerByte: 4310,
  costModels: {
    'PlutusV3': PLUTUS_V3_COST_MODEL
  }
};

// ============================================================================
// Nock Setup Helpers
// ============================================================================

/**
 * Setup nock interceptors for Koios API (persistent mocks for simple tests)
 */
function setupKoiosMocks(utxos = mockUtxosAdaOnly) {
  nock('https://preview.koios.rest')
    .get('/api/v1/cli_protocol_params')
    .reply(200, mockProtocolParams)
    .persist();

  nock('https://preview.koios.rest')
    .post('/api/v1/address_utxos', (body: any) => body._addresses !== undefined)
    .reply(200, utxos)
    .persist();
}

/**
 * Setup nock for a specific UTxO response (clears existing mocks and sets up fresh ones)
 */
function setupUtxoMock(utxos: any[]) {
  // Clear existing mocks but keep nock active
  nock.cleanAll();

  // Re-enable network blocking after cleanAll (cleanAll doesn't reset this, but be safe)
  nock.disableNetConnect();
  nock.enableNetConnect(/localhost/);

  // Setup fresh mocks
  nock('https://preview.koios.rest')
    .get('/api/v1/cli_protocol_params')
    .reply(200, mockProtocolParams)
    .persist();

  nock('https://preview.koios.rest')
    .post('/api/v1/address_utxos', (body: any) => body._addresses !== undefined)
    .reply(200, utxos)
    .persist();
}

// ============================================================================
// Test Suite Factory
// ============================================================================

/**
 * Create test suite for a specific transaction builder
 */
export function createTxServiceTestSuite(txBuilderConfig: TxBuilderTestConfig) {
  describe(`Cardano Transaction Service Tests [${txBuilderConfig.name.toUpperCase()}] [MOCKED]`, () => {
    const test = cds.test(__dirname + '/../../');
    const expect = test.expect;

    // Reset the database, CardanoClient, transaction builder, and nock before each test
    beforeEach(async () => {
      await test.data.reset();

      // IMPORTANT: Setup nock FIRST before creating any axios instances
      // nock needs to be active before axios.create() is called
      nock.cleanAll();
      nock.restore();
      nock.activate();
      nock.disableNetConnect();
      nock.enableNetConnect(/localhost/);

      // Setup default mocks (protocol params + ADA-only UTxOs)
      setupKoiosMocks();

      // NOW reset app context - this creates new instances that nock can intercept
      // Pass the specific builder type for this test configuration
      const testContext = await createTestContext(['koios'], txBuilderConfig.name);
      resetAppContext(testContext);
    });

    afterEach(() => {
      nock.cleanAll();
      nock.restore();
    });

    afterAll(async () => {
      nock.cleanAll();
      nock.restore();
      nock.enableNetConnect();
      // Shutdown app context to close backend connections
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
          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);

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

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
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

          const requestBody = {
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

          // Should have recipient output
          const recipientOutput = outputs.find((o: any) => o.address === FIXTURE.validRecipientAddress);
          expect(recipientOutput).to.exist;
          expect(recipientOutput.lovelace).to.equal(Number(FIXTURE.lovelaceAmount));
        });

        it('POST /BuildSimpleAdaTransaction - without change address (fallback to sender)', async () => {
          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
        });
      });

      // ============================================================================
      // BuildTransactionWithMetadata Action Tests
      // ============================================================================

      describe('BuildTransactionWithMetadata Action', () => {
        it('POST /BuildTransactionWithMetadata - successfully build ADA transaction with metadata', async () => {
          setupUtxoMock(mockUtxosAdaOnly);

          const METADATA = {
            "674": {
              "msg": ["Hello", "from", "ODATANO"]
            }
          };

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            metadataJson: JSON.stringify(METADATA),
          };
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', requestBody);
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

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '500' }
            ]),
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);

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

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '500' }
            ]),
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);
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

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '1200' } // Requires both UTxOs
            ])
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);
          expect(status).to.equal(200);
          expect(data.hasInputs).to.equal(true);

          const inputs = await cds.run(SELECT.from(TransactionBuildInputs).where({ build_id: data.id }));
          expect(inputs.length).to.be.greaterThan(0);
        });

        it('POST /BuildMultiAssetTransaction - handles change calculation with remaining assets', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuildOutputs } = TxService.entities;

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '100' }
            ])
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);
          expect(status).to.equal(200);
          expect(data.hasOutputs).to.equal(true);

          const outputs = await cds.run(SELECT.from(TransactionBuildOutputs).where({ build_id: data.id }));
          expect(outputs.length).to.be.greaterThanOrEqual(1);
        });

        it('POST /BuildMultiAssetTransaction - handles multiple different assets', async () => {
          const multiAssetUtxos = [{
            tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
            tx_index: 0,
            value: '15000000', // 15 ADA
            asset_list: [
              { policy_id: FIXTURE.policyId, asset_name: FIXTURE.assetName, quantity: '1000' },
              { policy_id: FIXTURE.policyId, asset_name: '416e6f74686572', quantity: '2000' } // Another asset
            ],
            block_hash: 'multi123',
            datum_hash: null
          }];

          setupUtxoMock(multiAssetUtxos);

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '500' },
              { unit: FIXTURE.policyId + '416e6f74686572', quantity: '1000' }
            ])
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);
          expect(status).to.equal(200);
          expect(data.unsignedTxCbor).to.exist;
        });

        it('POST /BuildMultiAssetTransaction - generates valid CBOR hex string', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '500' }
            ])
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data.unsignedTxCbor).to.match(/^[0-9a-f]+$/i);
          expect(data.unsignedTxCbor.startsWith('84')).to.be.true; // CBOR array marker
        });

        it('POST /BuildMultiAssetTransaction - uses senderAddress as changeAddress when not provided', async () => {
          setupUtxoMock(mockUtxosWithAssets);

          // Request WITHOUT changeAddress - should fall back to senderAddress
          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            assetsJson: JSON.stringify([
              { unit: FIXTURE.assetUnit, quantity: '100' } // Send less than available to get change
            ])
            // changeAddress intentionally omitted
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('unsignedTxCbor');
          // Transaction should build successfully with change going to senderAddress
          expect(data.fee).to.be.greaterThan(0);
        });
      });

      // ============================================================================
      // BuildMintTransaction Action Tests
      // ============================================================================

      describe('BuildMintTransaction Action', () => {
        // Valid Plutus Script CBOR (this is a real "always succeeds" minting policy)
        // The policyId is the hash of this script
        const VALID_PLUTUS_SCRIPT = "585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009";
        const POLICY_ID = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea'; // Hash of the script above

        it('POST /BuildMintTransaction - successfully build minting transaction', async () => {
          const MINT_ACTIONS = [
            {
              assetUnit: `${POLICY_ID}546f6b656e4d`, // policyId + "TokenM" in hex
              quantity: "1000"
            }
          ];

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            mintActionsJson: JSON.stringify(MINT_ACTIONS),
            mintingPolicyScript: VALID_PLUTUS_SCRIPT,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
          expect(data).to.have.property('txBodyHash');
          expect(data.wasSubmitted).to.equal(false);
        });

        it('POST /BuildMintTransaction - verify build is persisted in DB', async () => {
          const TxService = await cds.connect.to('CardanoTransactionService');
          const { TransactionBuilds } = TxService.entities;

          const MINT_ACTIONS = [
            {
              assetUnit: `${POLICY_ID}546f6b656e4e`, // policyId + assetName
              quantity: "2000"
            }
          ];

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            mintActionsJson: JSON.stringify(MINT_ACTIONS),
            mintingPolicyScript: VALID_PLUTUS_SCRIPT,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);
          expect(status).to.equal(200);

          const builds = await cds.run(SELECT.from(TransactionBuilds).where({ id: data.id }));
          expect(builds.length).to.equal(1);
          expect(builds[0].id).to.equal(data.id);
          expect(builds[0].txBodyHash).to.equal(data.txBodyHash);
        });

        it('POST /BuildMintTransaction - burn tokens (negative quantity)', async () => {
          // For burning, we need:
          // 1. A UTxO with the tokens being burned
          // 2. An ADA-only UTxO for collateral (Plutus requirement)
          const utxosForBurn = [
            {
              tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
              tx_index: 0,
              value: '10000000', // 10 ADA
              asset_list: [
                { policy_id: POLICY_ID, asset_name: '546f6b656e42', quantity: '1000' } // TokenB - has tokens to burn
              ],
              block_hash: 'burn123',
              datum_hash: null
            },
            {
              tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
              tx_index: 0,
              value: '10000000', // 10 ADA - ADA-only UTxO for collateral
              asset_list: [],
              block_hash: 'collateral123',
              datum_hash: null
            }
          ];
          setupUtxoMock(utxosForBurn);

          // Use the same valid Plutus Script for burning (negative quantity)
          const MINT_ACTIONS = [
            {
              assetUnit: `${POLICY_ID}546f6b656e42`, // policyId + "TokenB" in hex
              quantity: "-500"
            }
          ];

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            mintActionsJson: JSON.stringify(MINT_ACTIONS),
            mintingPolicyScript: VALID_PLUTUS_SCRIPT,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

          expect(status).to.equal(200);
          expect(data).to.have.property('id');
          expect(data).to.have.property('unsignedTxCbor');
        });

        it('POST /BuildMintTransaction - uses evaluated execution units when Ogmios available', async () => {
          // Mock evaluated execution units (much lower than defaults)
          const MOCK_EVALUATED_BUDGET = {
            memory: 200000,  // 200K - much lower than default 14M
            cpu: 100000000   // 100M - much lower than default 10B
          };

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

          const MINT_ACTIONS = [
            {
              assetUnit: `${POLICY_ID}546f6b656e4d`,
              quantity: "1000"
            }
          ];

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            mintActionsJson: JSON.stringify(MINT_ACTIONS),
            mintingPolicyScript: VALID_PLUTUS_SCRIPT,
          };

          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

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

          const MINT_ACTIONS = [
            {
              assetUnit: `${POLICY_ID}546f6b656e4d`,
              quantity: "1000"
            }
          ];

          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
            mintActionsJson: JSON.stringify(MINT_ACTIONS),
            mintingPolicyScript: VALID_PLUTUS_SCRIPT,
          };

          // Should still succeed - falls back to default execution units
          const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody);

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
      // GetBuildDetails Action Tests
      // ============================================================================

      describe('GetBuildDetails Action', () => {
        it('POST /GetBuildDetails - retrieve build details by buildId', async () => {
          const buildRequest = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
          };

          const buildResponse = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', buildRequest);
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
            status: 'pending',
            validFrom: new Date(),
            validTo: new Date(Date.now() + 3600000),
          }));

          const { status, data } = await test.post('/odata/v4/cardano-transaction/CheckSubmissionStatus', {
            submissionId: '12345678-1234-1234-1234-1234567890ab',
          });

          expect(status).to.equal(200);
          expect(data.id).to.equal('12345678-1234-1234-1234-1234567890ab');
          expect(data.txHash).to.equal('dummyhash');
          expect(data.signedTxCbor).to.equal('dummycbor');
          expect(data.status).to.equal('pending');
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
          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
          };

          const { status: buildStatus, data: buildData } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
          expect(buildStatus).to.equal(200);
          const buildId = buildData.id;

          // Verify AddressTransactionBuilds association was created
          const { status, data } = await test.get(`/odata/v4/cardano-transaction/AddressTransactionBuilds?$filter=address_address eq '${FIXTURE.validSenderAddress}'`);

          expect(status).to.equal(200);
          expect(data.value).to.be.an('array');
          expect(data.value.length).to.be.greaterThan(0);
          const found = data.value.find((b: any) => b.txBuild_id === buildId);
          expect(found).to.exist;
          expect(found.address_address).to.equal(FIXTURE.validSenderAddress);
        });
      });

      // ============================================================================
      // GetTransactionBuildsByAddress Action Tests
      // ============================================================================

      describe('GetTransactionBuildsByAddress Action', () => {
        it('should retrieve transaction builds for a given address', async () => {
          // Build a transaction first - this creates the AddressTransactionBuilds association
          const requestBody = {
            senderAddress: FIXTURE.validSenderAddress,
            recipientAddress: FIXTURE.validRecipientAddress,
            lovelaceAmount: FIXTURE.lovelaceAmount,
            changeAddress: FIXTURE.validSenderAddress,
          };

          const { status: buildStatus, data: buildData } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody);
          expect(buildStatus).to.equal(200);
          const buildId = buildData.id;

          // Retrieve builds by address using the action
          const { status, data } = await test.post('/odata/v4/cardano-transaction/GetTransactionBuildsByAddress', {
            address: FIXTURE.validSenderAddress,
          });

          expect(status).to.equal(200);
          // OData returns collection as { value: [...] }
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
