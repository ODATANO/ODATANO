import cds from '@sap/cds';
import { TEST_FIXTURES } from './test-fixtures';
import { simpleRequestBody } from './test-fixtures';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

/**
 * CardanoService integration tests against Ogmios only, so no other backend masks a
 * failure. Requires a running Ogmios at OGMIOS_URL (default ws://localhost:1337).
 */

// Set before cds.test(): the served hook builds the app context from these.
process.env.BACKENDS = 'ogmios';
process.env.OGMIOS_URL = process.env.OGMIOS_URL || 'ws://localhost:1337';


describe('ODATANO Milestone 2 - Specific Ogmios Backend Tests', () => {

  // cds.test() starts the server which triggers cds.on('served') → creates AppContext automatically
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  beforeEach(async () => {
    await test.data.reset();
  });

  describe('Ogmios Backend Action Tests', () => {

    it('POST /GetNetworkInformation - treasury and reserves from the ledger state', async () => {
      // Ogmios answers queryLedgerState/treasuryAndReserves; total = max supply - reserves
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(status).to.equal(200);
      expect(BigInt(data.treasurySupply) > 0n).to.be.true;
      expect(BigInt(data.reservesSupply) > 0n).to.be.true;
      expect(BigInt(data.totalSupply)).to.equal(BigInt(data.maxSupply) - BigInt(data.reservesSupply));
    });

    // First cold UTxO query: a full Ogmios ledger-state scan plus WS warm-up can take
    // 20s+ on a live preview node, so it gets its own timeout.
    it('POST /GetUTxOsByAddress - read UTxOs for given address', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });
      expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
      expect(status).to.be.equal(200);
    }, 90000);

    it('POST /GetAddressByBech32 - unsupported on Ogmios (delegate to Blockfrost/Koios)', async () => {
      // Address detail (type/script/stake) is not derivable from Ogmios state queries →
      // getAddress is in unsupportedMethods → 503 when Ogmios is the only backend.
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

      // Served from the live ledger state (queryLedgerState/delegateRepresentatives,
      // Ogmios >= 6.4). Only REGISTERED DReps are listed: a retired one is a 404.
      const response = await test.post('/odata/v4/cardano-odata/GetDrepById', {
        drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0'
      }).catch(err => err.response);

      expect([200, 404]).to.include(response.status);
      if (response.status === 200) {
        expect(response.data).to.have.property('drepId', 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0');
        expect(response.data).to.have.property('hasScript');
        expect(response.data).to.have.property('expired');
      } else {
        expect(response.data).to.have.property('error');
      }
    });

    it('POST /GetPoolById - get stake pool information', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetPoolById', { poolId: TEST_FIXTURES.validPoolId });
      expect(data).to.have.property('poolId');
      expect(status).to.equal(200);
    });

  });

  describe('Ogmios Backend - Gernal Data Conversion Tests', () => {

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

    it('POST /GetLatestBlock - verify epoch calculation from slot (432000 slots per epoch)', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect(status).to.equal(200);
      expect(data).to.have.property('epochNumber');
      expect(data).to.have.property('epochSlot');
      expect(data.epochSlot).to.be.at.least(0);
      expect(data.epochSlot).to.be.below(432000);
    });

    it('POST /GetLatestEpoch - verify epoch time boundary calculations', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(status).to.equal(200);
      expect(data.endTime).to.be.greaterThan(data.startTime);
      // Preview epoch is ~1 day (86400 slots * 1s = 86400 seconds), not mainnet's 5 days
      const epochDuration = data.endTime - data.startTime;
      expect(epochDuration).to.be.greaterThan(80000); // ~1 day
      expect(epochDuration).to.be.lessThan(90000);
    });

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
      const costModels = JSON.parse(data.costModels);
      expect(costModels).to.be.an('object');
    });

    // Circulation and stake totals are not in the ledger state
    it('POST /GetNetworkInformation - circulating and stake totals stay 0 on Ogmios', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(status).to.equal(200);
      expect(String(data.circulatingSupply)).to.equal('0');
      expect(String(data.liveStake)).to.equal('0');
      expect(String(data.activeStake)).to.equal('0');
    });

    it('POST /GetEpochByNumber - current epoch should succeed', async () => {
      const { data: latestEpoch } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: latestEpoch.epoch });
      expect(status).to.equal(200);
      expect(data.epoch).to.equal(latestEpoch.epoch);
    });

    it('POST /GetUTxOsByAddress - handle address with no UTxOs', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.emptyAddress });
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;
    });
  });

  describe('Ogmios Backend - Protocol & Network Validation', () => {
    it('POST /GetLedgerProtocolParameters - verify all critical params present', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});

      expect(data).to.have.property('minFeeA');
      expect(data).to.have.property('minFeeB');
      expect(data).to.have.property('maxTxSize');
      expect(data).to.have.property('coinsPerUtxoSize');
      expect(data).to.have.property('maxTxExMem');
      expect(data).to.have.property('maxTxExSteps');
      expect(data).to.have.property('collateralPercent');

      expect(Number(data.minFeeA)).to.be.greaterThan(0);
      expect(Number(data.minFeeB)).to.be.greaterThan(0);
      expect(Number(data.maxTxSize)).to.be.greaterThan(0);

      expect(status).to.equal(200);
    });

    it('POST /GetLatestBlock - verify block height is reasonable', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect(data.height).to.be.a('number');
      expect(data.height).to.be.greaterThan(0);

      expect(data.epochNumber).to.be.a('number');
      expect(data.epochSlot).to.be.a('number');
      expect(data.epochSlot).to.be.lessThan(432000); // Epoch slot should be < slots per epoch
      expect(status).to.equal(200);
    });

    it('POST /GetLatestEpoch - verify epoch time boundaries', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(data.startTime).to.be.a('number');
      expect(data.endTime).to.be.a('number');
      expect(data.endTime).to.be.greaterThan(data.startTime);
      const duration = data.endTime - data.startTime;
      expect(duration).to.be.greaterThan(80000); // preview epoch ≈ 86400s (~1 day)
      expect(status).to.equal(200);
    });

    it('POST /GetNetworkInformation - max supply is the protocol constant', async () => {
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(status).to.equal(200);
      expect(String(data.maxSupply)).to.equal('45000000000000000');
    });
  });

  describe('Ogmios Backend tests for not supported historic calls', () => {
    it('POST /GetTransactionByHash - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.txHash }).catch(err => err.response);
      expect(response.status).to.equal(503); // getTransaction is in Ogmios unsupportedMethods → no provider available
      expect(response.data).to.have.property('error');
    });

    it('POST /GetMetadataByTxHash - unsupported operation should return error', async () => {
      const response = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.txHash }).catch(err => err.response);
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
