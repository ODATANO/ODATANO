
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

describe('ODATANO Milestone 1 - OData Query Features', () => {

  const { GET, POST, expect } = cds.test(__dirname + '/../../');

  describe('Ogmios Backend Specific Tests', () => {

    it('POST /GetUTxOsByAddress - read UTxOs for given address', async () => {
      const requestBody = {
        address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      }; 
      const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', requestBody);

      expect(status).to.be.equal(200);
      expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
    }); 

    it ('POST /GetAddressByBech32 - get address information', async () => {
          const requestBody = {
            address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp'
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressByBech32', requestBody);
      expect(data).to.have.property('address');
      expect(data).to.have.property('totalLovelace');
      expect(status).to.equal(200);
    });

    it('POST /GetLatest Block - get latest block information', async () => {
      const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestBlock`, {});
      expect(data).to.have.property('hash');
      expect(status).to.equal(200);
    })

    it('POST /GetLatestEpoch - get latest epoch information', async () => {
      const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestEpoch`, {});
      expect(data).to.have.property('epoch');
      expect(data).to.have.property('startTime');
      expect(status).to.equal(200);
    });

    it ('POST /GetLedgerProtocolParameters - get protocol parameters', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLedgerProtocolParameters', {});
      expect(data).to.have.property('minFeeA');
      expect(status).to.equal(200);
    });
  });
});