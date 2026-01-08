import cds from '@sap/cds';
jest.setTimeout(20000);
/**
 * Ogmios Backend Integration Tests
 * 
 * This test file runs the CardanoService integration tests specifically only with the Blockfrost backend.
 * It ensures that Blockfrost is tested independently without fallback to Koios masking failures.
 */

// Configure environment to use only Ogmios backend
process.env.BACKENDS = 'ogmios';

process.env.OGMIOS_WS_URL = process.env.OGMIOS_WS_URL || 'ws://localhost:1337';
// Import and run the shared test suite

describe('ODATANO Milestone 1 - OData Query Features', () => {

  const { GET, POST, expect } = cds.test(__dirname + '/../../');

  describe('Ogmios Backend Specific Tests', () => {

    it('POST /GetAddress UTxOs - read UTxOs for given address', async () => {
      const requestBody = {
        address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8'
      }; 
      const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressUTxOs', requestBody);
      expect(data.value.length).to.be.greaterThan(0);
      expect(data.value[0]).to.have.property('txHash');
      expect(status).to.equal(200);
    });

    it ('POST /GetAddress - get address information', async () => {
      const requestBody = {
        address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8'
      };
      const { status, data } = await POST('/odata/v4/cardano-odata/GetAddress', requestBody);
      expect(data).to.have.property('address');
      expect(data).to.have.property('totalLovelace');
      expect(status).to.equal(200);
    });

    it('POST /GetLatest Block - get latest block information', async () => {
      const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestBlock`, {});
      expect(data.value.length).to.be.greaterThan(0);
      expect(data.value[0]).to.have.property('blockHash');
      expect(status).to.equal(200);
    })

    it('GET /Latest Epoch - read Blocks collection', async () => {
      const { status, data } = await GET(`/odata/v4/cardano-odata/GetLatestEpoch`);
      expect(data.value.length).to.be.greaterThan(0);
      expect(data.value[0]).to.have.property('blockHash');
      expect(status).to.equal(200);
    });

    it ('GET /Protocol Parameters - read Protocol Parameters', async () => {
      const { status, data } = await GET('/odata/v4/cardano-odata/ProtocolParameters');
      expect(data.value.length).to.be.greaterThan(0);
      expect(data.value[0]).to.have.property('minUtxoValue');
      expect(status).to.equal(200);
    });

  });
});
