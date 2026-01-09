/*
import cds from '@sap/cds';
import { 
  BackendTestConfig,
  configureBackendForTest,
} from './backend-test-helper';

const { SELECT, INSERT } = cds.ql;
jest.setTimeout(200000);
// Helper function to create test suite for a specific backend
export function createBackendTestSuite(backendConfig: BackendTestConfig) {

  // configure environment to use this specific backend
  configureBackendForTest(backendConfig);

  describe(`ODATANO Milestone 2 - Complete Service Tests [${backendConfig.name.toUpperCase()}]`, () => {
  // Initialize the test suite
  const { GET, POST, expect } = cds.test(__dirname + '/../../');
  
  // Test data fixtures for preview network
  const FIXTURE = {
    validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
    txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
    validAddress: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
    validBlockHash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39',
    validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
    validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
    transactionMetadataLabel: '1990',
    validPoolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
    validUnit: 'eadc69a5d2d1357acc9b9d49ec5390fcdf6e080c7a40139917223dcba971c6765a1acab1d7849f4f032195cf69c4ab486ac6dedec9533103',
  }

  // Reset the database before each test to ensure a clean state
  beforeEach (async()=>{
     // await test.data.reset()   
  });
  // ============================================================================
  // New M2 Entities Tests
  // ============================================================================
  describe('New M2 Entitys READ Tests', () => {

    describe('Cardano Service GET', () => {
      
     /* it('POST /latestBlock - get latest block information', async () => {

        const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestBlock`, {});
        expect(data.value.length).to.be.greaterThan(0);
        expect(data.value[0]).to.have.property('blockHash');
        expect(status).to.equal(200);
      });
      it('POST /protocolParameters - get protocol parameters', async () => {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetProtocolParameters', {});
        expect(data.value.length).to.be.greaterThan(0);
        expect(data.value[0]).to.have.property('minUtxoValue');
        expect(status).to.equal(200);
      });
      it('POST /latestEpoch - get epoch statistics', async () => {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
        expect(data.value.length).to.be.greaterThan(0);
        expect(data.value[0]).to.have.property('epochNumber');
        expect(status).to.equal(200);
      });
    });
  });

  // ============================================================================
  // New M2 Transaction Building Tests
  // ============================================================================
 describe('new Entety Service Tests', () => {
      
    /*  it('POST / - get latest block information', async () => {

        const { status, data } = await POST(`/odata/v4/cardano-odata/GetLatestBlock`, {});
        expect(data.value.length).to.be.greaterThan(0);
        expect(data.value[0]).to.have.property('blockHash');
        expect(status).to.equal(200);
      });
         
    });
  });
  })

}

*/
