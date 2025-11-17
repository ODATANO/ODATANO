const axios = require('axios');

const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

const examples = [
  {
    name: 'Transaction (example hash)',
    url: `${BASE}/Transactions(ID='50d9ad6558a6963d72dc25b4f37f31db15a512c708bb735a8f67f30b878bd4e3')`
  },
  {
    name: 'Address (example)',
    url: `${BASE}/Addresses(address='addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')`
  },
  {
    name: 'Metadata (example tx)',
    url: `${BASE}/Metadata(tx='50d9ad6558a6963d72dc25b4f37f31db15a512c708bb735a8f67f30b878bd4e3')`
  }
];

(async () => {
  for (const ex of examples) {
    console.log(`\n=== ${ex.name} ===`);
    try {
      const res = await axios.get(ex.url, { timeout: 10000 });
      console.log('Status:', res.status);
      console.log('Data:', JSON.stringify(res.data, null, 2));
    } catch (err) {
      if (err.response) {
        console.log('Status:', err.response.status);
        console.log('Body:', typeof err.response.data === 'object' ? JSON.stringify(err.response.data, null, 2) : String(err.response.data));
      } else {
        console.log('Error:', err.message);
      }
    }
  }
})();
