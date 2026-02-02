import cds from '@sap/cds';
import nock from 'nock';
import { TxBuilderTestConfig } from './backend-test-helper';
import { createTestContext, resetAppContext, shutdownAppContext } from '../../srv/server';

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
    value: '1500', // 0.0015 ADA (lovelace as string)
    asset_list: [],
    block_hash: 'a1b2c3d4e5f6',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 1,
    value: '1000', // 0.001 ADA
    asset_list: [],
    block_hash: 'b2c3d4e5f6g7',
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
export function createTxErrorTestSuite(txBuilderConfig: TxBuilderTestConfig) {
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
    // BuildSimpleAdaTransaction Action Error Tests
    // ============================================================================

    describe('BuildSimpleAdaTransaction Action', () => {
      it('POST /BuildSimpleAdaTransaction - should return 400 error for insufficient funds', async () => {
        const requestBody = {
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          changeAddress: FIXTURE.validSenderAddress,
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', requestBody).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
      });
    });

    // ============================================================================
    // BuildTransactionWithMetadata Action Error Tests
    // ============================================================================

    describe('BuildTransactionWithMetadata Action', () => {
      it('POST /BuildTransactionWithMetadata - should return 400 error for insufficient funds', async () => {
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

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildTransactionWithMetadata', requestBody).catch(err => err.response);
        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
      });
    });

    // ============================================================================
    // BuildMultiAssetTransaction Action Error Tests
    // ============================================================================

    describe('BuildMultiAssetTransaction Action', () => {

      it('POST /BuildMultiAssetTransaction - should return 500 error for insufficient asset quantity', async () => {
        const limitedUtxos = [{
          tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
          tx_index: 0,
          value: '10000000', // 10 ADA
          asset_list: [
            { policy_id: FIXTURE.policyId, asset_name: FIXTURE.assetName, quantity: '100' } // Only 100 tokens
          ],
          block_hash: 'limited123',
          datum_hash: null
        }];

        setupUtxoMock(limitedUtxos);

        const requestBody = {
          senderAddress: FIXTURE.validSenderAddress,
          recipientAddress: FIXTURE.validRecipientAddress,
          lovelaceAmount: FIXTURE.lovelaceAmount,
          assetsJson: JSON.stringify([
            { unit: FIXTURE.assetUnit, quantity: '500' } // Requesting more than available
          ])
        };

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMultiAssetTransaction', requestBody).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds/assets (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
      });
    });

    // ============================================================================
    // BuildMintTransaction Action Error Tests
    // ============================================================================

    describe('BuildMintTransaction Action', () => {
      // Valid Plutus Script CBOR (this is a real "always succeeds" minting policy)
      // The policyId is the hash of this script
      const VALID_PLUTUS_SCRIPT = "585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009";
      const POLICY_ID = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea'; // Hash of the script above

      it('POST /BuildMintTransaction - should return 400 error for insufficient funds', async () => {
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

        const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildMintTransaction', requestBody).catch(err => err.response);

        expect(status).to.equal(400);
        expect(data).to.have.property('error');
        expect(data.error).to.have.property('message');
        // Error message should indicate insufficient funds (mapped from builder error)
        expect(data.error.message).to.match(/Insufficient|not enough|balance/i);
      });
    });
  });
}
