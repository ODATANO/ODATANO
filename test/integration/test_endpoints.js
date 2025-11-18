const axios = require('axios');

const BASE_URL = 'http://localhost:4005/odata/v4/cardano-odata';

async function testEndpoints() {
  console.log('Testing OData endpoints...\n');

  // Test 1: Invalid transaction hash (should return 400)
  try {
    console.log('1. Testing invalid transaction hash...');
    const res = await axios.get(`${BASE_URL}/Transactions('invalid')`);
    console.log('  Response:', res.status, res.data);
  } catch (e) {
    console.log('  Status:', e.response?.status);
    console.log('  Error:', e.response?.data?.error?.message || e.message);
  }

  // Test 2: Valid transaction hash (should attempt to fetch from Blockfrost)
  try {
    console.log('\n2. Testing valid transaction hash...');
    const txHash = 'a1c6ea7d4caa8e7b2d3f5e9c1b8d4f6a9e2c5b7d1f3a6c9d2e8f1b4a7c9e2d5';
    const res = await axios.get(`${BASE_URL}/Transactions('${txHash}')`);
    console.log('  Status:', res.status);
    console.log('  Keys:', Object.keys(res.data));
  } catch (e) {
    console.log('  Status:', e.response?.status);
    console.log('  Error:', e.response?.data?.error?.message || e.message);
  }

  // Test 3: GetTransactionByHash action (invalid hash)
  try {
    console.log('\n3. Testing GetTransactionByHash action (invalid hash)...');
    const res = await axios.post(`${BASE_URL}/GetTransactionByHash`, { hash: 'invalid' });
    console.log('  Status:', res.status);
  } catch (e) {
    console.log('  Status:', e.response?.status);
    console.log('  Error:', e.response?.data?.error?.message || e.message);
  }

  // Test 4: GetAddressByBech32 action (invalid address)
  try {
    console.log('\n4. Testing GetAddressByBech32 action (invalid address)...');
    const res = await axios.post(`${BASE_URL}/GetAddressByBech32`, { address: 'invalid' });
    console.log('  Status:', res.status);
  } catch (e) {
    console.log('  Status:', e.response?.status);
    console.log('  Error:', e.response?.data?.error?.message || e.message);
  }

  console.log('\n\nDone.');
  process.exit(0);
}

testEndpoints().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
