import axios from 'axios';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-odata';
// Preview testnet address from M1 integration tests
const TEST_ADDRESS = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

async function main() {
  try {
    console.log(`Testing Address UTxO Query via Ogmios...`);
    console.log(`Address: ${TEST_ADDRESS}\n`);

    const response = await axios.get(`${ODATA_URL}/Addresses('${TEST_ADDRESS}')?$expand=utxos`, {
      headers: { 'Accept': 'application/json' }
    });
    const address = response.data;

    console.log('response.data:', JSON.stringify(address, null, 2));
    console.log(`Type: ${address.type}`);
    
    console.log(`UTxOs Count: ${address.utxos.length}`);
    }
    catch (error: any) {
    console.error('Error querying address UTxOs:', error.message);
    process.exit(1);
    }
}

main();
