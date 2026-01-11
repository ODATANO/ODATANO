
import cds from '@sap/cds';
jest.setTimeout(20000);
/**
 * Ogmios Backend Integration Tests
 * 
 * This test file runs the CardanoService integration tests specifically only with the Ogmios backend.
 * It ensures that Ogmios is tested independently without fallback to other backends masking failures.
 * 
 * NOTE: These tests require a running Ogmios instance at OGMIOS_WS_URL (default: ws://localhost:1337)
 */


// Configure environment to use only Ogmios backend
process.env.BACKENDS = 'ogmios';

process.env.OGMIOS_WS_URL = process.env.OGMIOS_WS_URL || 'ws://localhost:1337';

// Import and run the shared test suite

describe('ODATANO Milestone 2 - Specific Ogmios Backend Tests', () => {

  const { POST, expect } = cds.test(__dirname + '/../../');

  describe('Ogmios Backend Action Tests', () => {

    it('POST /GetNetworkInformation - get network information', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(data).to.have.property('network');
      expect(data).to.have.property('maxSupply');
      expect(data).to.have.property('circulatingSupply');
      expect(status).to.equal(200);
    });

    it('POST /GetUTxOsByAddress - read UTxOs for given address', async () => {
      const requestBody = {
        address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', requestBody);

      expect(status).to.be.equal(200);
      expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
    });

    it('POST /GetAddressByBech32 - get address information', async () => {
      const requestBody = {
        address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressByBech32', requestBody);
      expect(data).to.have.property('address');
      expect(data).to.have.property('totalLovelace');
      expect(status).to.equal(200);
    });

    it('POST /GetLatestBlock - get latest block information', async () => {
      const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestBlock`, {});
      expect(data).to.have.property('hash');
      expect(status).to.equal(200);
    });

    it('POST /GetLatestEpoch - get latest epoch information', async () => {
      const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestEpoch`, {});
      expect(data).to.have.property('epoch');
      expect(data).to.have.property('startTime');
      expect(status).to.equal(200);
    });

    it('POST /GetLedgerProtocolParameters - get protocol parameters', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(data).to.have.property('minFeeA');
      expect(status).to.equal(200);
    });

    it('POST /GetDrepById - get drep information', async () => {
      const requestBody = {
        drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0'
      };
      const response = await POST('/odata/v4/cardano-odata/GetDrepById', requestBody).catch(err => err.response);
     
      expect(response.status).to.equal(503); // Ogmios does not support Drep queries
      expect(response.data).to.have.property('error');
    });

    

  });

  // Test data fixtures for preview network  
  const OGMIOS_FIXTURE = {
    network: 'preview',
    addressWithFunds: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
    addressWithAssets: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
    emptyAddress: 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg',
    stakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
    poolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
  };

  describe('Ogmios Backend - Real Coverage Tests', () => {
    
    // Test convertOgmiosValue() with different UTxO types
    it('POST /GetUTxOsByAddress - verify convertOgmiosValue handles lovelace-only UTxOs', async () => {
      const requestBody = {
        address: OGMIOS_FIXTURE.addressWithFunds
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', requestBody);
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
      const requestBody = {
        address: OGMIOS_FIXTURE.emptyAddress
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', requestBody);
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;
    });

    // Test address with potential native assets
    it('POST /GetAddressByBech32 - verify totalLovelace calculation from convertOgmiosValue', async () => {
      const requestBody = {
        address: OGMIOS_FIXTURE.addressWithAssets
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressByBech32', requestBody);
      expect(status).to.equal(200);
      expect(data).to.have.property('totalLovelace');
      const lovelace = typeof data.totalLovelace === 'string' ? parseInt(data.totalLovelace) : data.totalLovelace;
      expect(lovelace).to.be.a('number');
      expect(lovelace).to.be.at.least(0);
    });

    // Test epoch calculation logic
    it('POST /GetLatestBlock - verify epoch calculation from slot (432000 slots per epoch)', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect(status).to.equal(200);
      expect(data).to.have.property('epochNumber');
      expect(data).to.have.property('epochSlot');
      // epochSlot should be < 432000
      expect(data.epochSlot).to.be.at.least(0);
      expect(data.epochSlot).to.be.below(432000);
    });

    // Test epoch boundary calculations
    it('POST /GetLatestEpoch - verify epoch time boundary calculations', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(status).to.equal(200);
      expect(data.endTime).to.be.greaterThan(data.startTime);
      // Epoch should be ~5 days (432000 seconds)
      const epochDuration = data.endTime - data.startTime;
      expect(epochDuration).to.be.greaterThan(400000); // At least ~4.6 days
      expect(epochDuration).to.be.lessThan(450000); // Less than ~5.2 days
    });

    // Test protocol parameters conversion
    it('POST /GetLedgerProtocolParameters - verify all plutus params present', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
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

    // Test network information (uses hardcoded max supply)
    it('POST /GetNetworkInformation - verify hardcoded cardano max supply', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(status).to.equal(200);
      const maxSupply = typeof data.maxSupply === 'string' ? data.maxSupply : data.maxSupply.toString();
      // Cardano max supply is 45 billion ADA = 45000000000000000 lovelace
      expect(maxSupply).to.equal('45000000000000000');
    });

    // Test current epoch query (getEpoch for current epoch should work)
    it('POST /GetEpochByNumber - current epoch should succeed', async () => {
      // First get current epoch
      const { data: latestEpoch } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      
      // Query that same epoch
      const requestBody = {
        epochNumber: latestEpoch.epoch
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetEpochByNumber', requestBody);
      expect(status).to.equal(200);
      expect(data.epoch).to.equal(latestEpoch.epoch);
    });

    // Test empty address (should return empty array, not error)
    it('POST /GetUTxOsByAddress - handle address with no UTxOs', async () => {
      // Use the OGMIOS_FIXTURE emptyAddress which is valid bech32
      const requestBody = {
        address: OGMIOS_FIXTURE.emptyAddress
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', requestBody);
      expect(status).to.equal(200);
      const utxos = data.value || data;
      expect(Array.isArray(utxos)).to.be.true;
    });
  });

  describe('Ogmios Backend - Protocol & Network Validation', () => {
    // Test protocol parameters completeness
    it('POST /GetLedgerProtocolParameters - verify all critical params present', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(status).to.equal(200);
      
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
    });

    // Test block height is incrementing
    it('POST /GetLatestBlock - verify block height is reasonable', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect(status).to.equal(200);
      
      // Preview testnet should have substantial block height
      expect(data.height).to.be.a('number');
      expect(data.height).to.be.greaterThan(0);
      
      // Verify epoch calculation is consistent
      expect(data.epochNumber).to.be.a('number');
      expect(data.epochSlot).to.be.a('number');
      expect(data.epochSlot).to.be.lessThan(432000); // Epoch slot should be < slots per epoch
    });

    // Test epoch time calculations
    it('POST /GetLatestEpoch - verify epoch time boundaries', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect(status).to.equal(200);
      
      expect(data.startTime).to.be.a('number');
      expect(data.endTime).to.be.a('number');
      expect(data.endTime).to.be.greaterThan(data.startTime);
      
      // Epoch duration should be reasonable (approx 5 days = 432000 seconds)
      const duration = data.endTime - data.startTime;
      expect(duration).to.be.greaterThan(400000); // At least close to expected duration
    });

    // Test network information completeness
    it('POST /GetNetworkInformation - verify network details', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect(status).to.equal(200);
      
      expect(data.network).to.equal('preview'); // Should match CONFIG.network
      expect(data).to.have.property('maxSupply');
      expect(data).to.have.property('circulatingSupply');
      
      // Max supply for Cardano is 45 billion ADA
      const maxSupplyNum = typeof data.maxSupply === 'string' 
        ? Number(data.maxSupply) 
        : data.maxSupply;
      expect(maxSupplyNum).to.be.greaterThan(0);
    });
  });

  describe('Ogmios Backend tests for not supported historic calls', () => {
    it('POST /GetTransactionByHash - unsupported operation should return error', async () => {
      const requestBody = {
        hash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83'
      };
      const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', requestBody).catch(err => err.response);
      expect(response.status).to.equal(404);
      expect(response.data).to.have.property('error');
    });

    it ('POST /GetMetadataByTxHash - unsupported operation should return error', async () => {
      const requestBody = {
        tx_hash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83'
      };
      const response = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', requestBody).catch(err => err.response);
      expect(response.status).to.equal(404);
      expect(response.data).to.have.property('error');
    });

    it('POST /GetBlockByHash - unsupported operation should return error', async () => {
      const requestBody = {
        hash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39'
      };
      const response = await POST('/odata/v4/cardano-odata/GetBlockByHash', requestBody).catch(err => err.response);
      expect(response.status).to.equal(404);
      expect(response.data).to.have.property('error');
    });

    it ('POST /GetEpochByNumber - unsupported operation should return error', async () => {
      const requestBody = {
        epochNumber: 100
      };
      const response = await POST('/odata/v4/cardano-odata/GetEpochByNumber', requestBody).catch(err => err.response);
      expect(response.status).to.equal(404); // Historic epoch not supported
      expect(response.data).to.have.property('error');
    });
  });
});
