// Simple test to check if server is working
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 4004,
  path: '/odata/v4/cardano-odata/Transactions',
  method: 'GET',
  timeout: 5000
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Response length:', data.length);
    console.log('First 500 chars:', data.substring(0, 500));
    process.exit(0);
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('Request timed out');
  req.destroy();
  process.exit(1);
});

req.end();
