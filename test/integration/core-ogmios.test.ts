import cds from '@sap/cds';
import { TEST_FIXTURES } from './test-fixtures';
import { simpleRequestBody } from './test-fixtures';

// 60s, not the usual 20s: this suite forces BACKENDS=ogmios (no fallback), so
// app-context bootstrap depends solely on Ogmios's init. Under CI CPU contention
// the node can momentarily cut the /health probe ("Premature close"), and the
// orchestrator now rides that out with exponential-backoff retries (up to ~35s —
// see CardanoClient.initBackendWithRetry). The bootstrap (cds.served) runs inside
// this hook budget, so it must comfortably exceed the retry window.
jest.setTimeout(60000);

/**
 * Ogmios Backend Integration Tests
 *
 * This test file runs the CardanoService integration tests specifically only with the Ogmios backend.
 * It ensures that Ogmios is tested independently without fallback to other backends masking failures.
 *
 * NOTE: These tests require a running Ogmios instance at OGMIOS_WS_URL (default: ws://localhost:1337)
 */

// Configure environment BEFORE cds.test() - the server will use these to create the context automatically
process.env.BACKENDS = 'ogmios';
process.env.OGMIOS_URL = process.env.OGMIOS_URL || 'ws://localhost:1337';


describe('ODATANO Milestone 2 - Specific Ogmios Backend Tests', () => {

  // cds.test() starts the server which triggers cds.on('served') → creates AppContext automatically
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  // Only reset database before each test - AppContext is already created by server bootstrap
  beforeEach(async () => {
    await test.data.reset();
  });

  describe('Ogmios Backend Action Tests', () => {

    it('POST /GetNetworkInformation - unsupported on Ogmios (delegate to Blockfrost/Koios)', async () => {
      // Ogmios can't serve network aggregates (max/circulating supply); it's declared in
      // unsupportedMethods so the orchestrator skips it. Ogmios-only → no provider → 503.
      const response = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {}).catch(err => err.response);
      expect(response.status).to.equal(503);
      expect(response.data).to.have.property('error');
    });

    it('POST /GetUTxOsByAddress - read UTxOs for given address', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });
      expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
      expect(status).to.be.equal(200);
    });

    it('POST /GetAddressByBech32 - unsupported on Ogmios (delegate to Blockfrost/Koios)', async () => {
      // Ogmios can't aggregate address detail (type/script/stake) → getAddress is in
      // unsupportedMethods. Ogmios-only → no provider → 503. (UTxOs remain available
      // via GetUTxOsByAddress, which falls back to getAddressUtxos.)
      const response = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds }).catch(err => err.response);
      expect(response.status).to.equal(503);
      expect(response.data).to.have.property('error');
    });

    it('POST /GetLatestBlock - get latest block information', async () => {
      const { status, data } = await test.post(`/odata/v4/cardano-odata/GetLatestBlock`, {});
      expect(data).to.have.property('hash');
      expect(status).to.equal(200);
    });

    it('POST /GetLatestEpoch - get latest epoch information', async () => {
      const { status, data } = await test.post(`/odata/v4/cardano-odata/GetLatestEpoch`, {});
      expect(data).to.have.property('epoch');
      expect(data).to.have.property('startTime');
      expect(status).to.equal(200);
    });

    it('POST /GetLedgerProtocolParameters - get protocol parameters', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(data).to.have.property('minFeeA');
      expect(status).to.equal(200);
    });

    it('POST /GetDrepById - get drep information', async () => {

      const response = await test.post('/odata/v4/cardano-odata/GetDrepById', {
        drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0'
      }).catch(err => err.response);

      expect(response.status).to.equal(503); // Ogmios does not support Drep queries
      expect(response.data).to.have.property('error');
    });

    it('POST /GetPoolById - get stake pool information', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetPoolById', { poolId: TEST_FIXTURES.validPoolId });
      expect(data).to.have.property('poolId');
      expect(status).to.equal(200);
    });

  });

  describe('Ogmios Backend - Gernal Data Conversion Tests', () => {

    // Test convertOgmiosValue() with different UTxO types
    it('POST /GetUTxOsByAddress - verify convertOgmiosValue handles lovelace-only UTxOs', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;

      if (utxos.length > 0) {
        const utxo = utxos[0];
        expect(utxo).to.have.property('hash');
        expect(utxo).to.have.property('index');
        expect(utxo.index).to.be.a('number');
      }
    });

    // Test empty address (edge case)
    it('POST /GetUTxOsByAddress - empty address returns empty array without error', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.emptyAddress });
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;
    });

    // Address detail is not derivable from Ogmios state queries (delegated to Blockfrost/Koios)
    it('POST /GetAddressByBech32 - unsupported on Ogmios (address detail not derivable)', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithAssets }).catch(err => err.response);
      expect(response.status).to.equal(503);
      expect(response.data).to.have.property('error');
    });

    // Test epoch calculation logic
    it('POST /GetLatestBlock - verify epoch calculation from slot (432000 slots per epoch)', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect(status).to.equal(200);
      expect(data).to.have.property('epochNumber');
      expect(data).to.have.property('epochSlot');
      // epochSlot should be < 432000
      expect(data.epochSlot).to.be.at.least(0);
      expect(data.epochSlot).to.be.below(432000);
    });

    // Test epoch boundary calculations
    it('POST /GetLatestEpoch - verify epoch time boundary calculations', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(status).to.equal(200);
      expect(data.endTime).to.be.greaterThan(data.startTime);
      // Preview epoch is ~1 day (86400 slots * 1s = 86400 seconds), not mainnet's 5 days
      const epochDuration = data.endTime - data.startTime;
      expect(epochDuration).to.be.greaterThan(80000); // ~1 day
      expect(epochDuration).to.be.lessThan(90000);
    });

    // Test protocol parameters conversion
    it('POST /GetLedgerProtocolParameters - verify all plutus params present', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(status).to.equal(200);
      // Transaction building essentials
      expect(data).to.have.property('minFeeA');
      expect(data).to.have.property('minFeeB');
      expect(data).to.have.property('coinsPerUtxoSize');
      // Plutus execution limits
      expect(data).to.have.property('maxTxExMem');
      expect(data).to.have.property('maxTxExSteps');
      expect(data).to.have.property('costModels');
      // Verify costModels is parseable JSON
      const costModels = JSON.parse(data.costModels);
      expect(costModels).to.be.an('object');
    });

    // Network information is unsupported on Ogmios (delegated to Blockfrost/Koios)
    it('POST /GetNetworkInformation - unsupported on Ogmios', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {}).catch(err => err.response);
      expect(response.status).to.equal(503);
      expect(response.data).to.have.property('error');
    });

    // Test current epoch query
    it('POST /GetEpochByNumber - current epoch should succeed', async () => {
      // first get current epoch
      const { data: latestEpoch } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: latestEpoch.epoch });
      expect(status).to.equal(200);
      expect(data.epoch).to.equal(latestEpoch.epoch);
    });

    // Test empty address (should return empty array, not error)
    it('POST /GetUTxOsByAddress - handle address with no UTxOs', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.emptyAddress });
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;
    });
  });

  describe('Ogmios Backend - Protocol & Network Validation', () => {
    // Test protocol parameters completeness
    it('POST /GetLedgerProtocolParameters - verify all critical params present', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});

      // Check critical parameters for transaction building
      expect(data).to.have.property('minFeeA');
      expect(data).to.have.property('minFeeB');
      expect(data).to.have.property('maxTxSize');
      expect(data).to.have.property('coinsPerUtxoSize');
      expect(data).to.have.property('maxTxExMem');
      expect(data).to.have.property('maxTxExSteps');
      expect(data).to.have.property('collateralPercent');

      // Verify they are valid numbers/strings
      expect(Number(data.minFeeA)).to.be.greaterThan(0);
      expect(Number(data.minFeeB)).to.be.greaterThan(0);
      expect(Number(data.maxTxSize)).to.be.greaterThan(0);

      expect(status).to.equal(200);
    });

    // Test block height is incrementing
    it('POST /GetLatestBlock - verify block height is reasonable', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestBlock', {});
      // Preview testnet should have substantial block height
      expect(data.height).to.be.a('number');
      expect(data.height).to.be.greaterThan(0);

      // Verify epoch calculation is consistent
      expect(data.epochNumber).to.be.a('number');
      expect(data.epochSlot).to.be.a('number');
      expect(data.epochSlot).to.be.lessThan(432000); // Epoch slot should be < slots per epoch
      expect(status).to.equal(200);
    });

    // Test epoch time calculations
    it('POST /GetLatestEpoch - verify epoch time boundaries', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(data.startTime).to.be.a('number');
      expect(data.endTime).to.be.a('number');
      expect(data.endTime).to.be.greaterThan(data.startTime);
      const duration = data.endTime - data.startTime;
      expect(duration).to.be.greaterThan(80000); // preview epoch ≈ 86400s (~1 day)
      expect(status).to.equal(200);
    });

    // Network information is unsupported on Ogmios (delegated to Blockfrost/Koios)
    it('POST /GetNetworkInformation - unsupported on Ogmios (network details)', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {}).catch(err => err.response);
      expect(response.status).to.equal(503);
      expect(response.data).to.have.property('error');
    });
  });

  describe('Ogmios Backend tests for not supported historic calls', () => {
    it('POST /GetTransactionByHash - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.txHash }).catch(err => err.response);
      expect(response.status).to.equal(503); // getTransaction is in Ogmios unsupportedMethods → no provider available
      expect(response.data).to.have.property('error');
    });

    it('POST /GetMetadataByTxHash - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { tx_hash: TEST_FIXTURES.txHash }).catch(err => err.response);
      expect(response.status).to.equal(503); // getTransactionMetadata is in Ogmios unsupportedMethods → no provider available
      expect(response.data).to.have.property('error');
    });

    it('POST /GetBlockByHash - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetBlockByHash', { hash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39' }).catch(err => err.response);
      expect(response.status).to.equal(503); // getBlock is in Ogmios unsupportedMethods → no provider available
      expect(response.data).to.have.property('error');
    });

    it('POST /GetEpochByNumber - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: 100 }).catch(err => err.response);
      expect(response.status).to.equal(404); // Historic epoch not supported
      expect(response.data).to.have.property('error');
    });
  });

  describe('Ogimos Backend - Transaction Building Related Tests', () => {
    // Test that collateralPercent is present and valid
    it('POST /GetLedgerProtocolParameters - verify collateralPercent is valid', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(status).to.equal(200);
      expect(data).to.have.property('collateralPercent');
      const collateralPercent = Number(data.collateralPercent);
      expect(collateralPercent).to.be.a('number');
      expect(collateralPercent).to.be.greaterThan(0);
    });

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
  });
});
