import axios from 'axios';

const TX_URL = 'http://localhost:4004/odata/v4/cardano-transaction';
const SIGN_URL = 'http://localhost:4004/odata/v4/cardano-sign';
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:').toString('base64');
const axiosConfig = { headers: { 'Authorization': AUTH_HEADER } };

const HSM_ADDRESS = 'addr_test1vrhejsyaadc7vn55ghmjya38u86a5d0rslruywtwkpz0qwqfv32lc';

const RECIPIENT = 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622';

const LOVELACE_AMOUNT = '5000000'; // 5 ADA

async function main() {
  try {
    console.log('=== HSM Signing Flow — Send ADA on Preview ===\n');

    // 1. Check HSM status
    console.log('1. Checking HSM status...');
    const hsmStatus = await axios.post(`${SIGN_URL}/GetHsmStatus`, {}, axiosConfig);
    const hsm = hsmStatus.data;

    if (!hsm.connected) {
      console.error('HSM is not connected. Check SOFTHSM2_CONF and HSM_* env vars.');
      return;
    }

    console.log(`   HSM connected: ${hsm.keyLabel}`);
    console.log(`   Address: ${hsm.cardanoAddress}`);
    console.log(`   Public Key Hash: ${hsm.publicKeyHash}\n`);

    // 2. Build transaction
    console.log('2. Building transaction...');
    const buildResponse = await axios.post(`${TX_URL}/BuildSimpleAdaTransaction`, {
      senderAddress: HSM_ADDRESS,
      recipientAddress: RECIPIENT,
      lovelaceAmount: LOVELACE_AMOUNT,
      changeAddress: HSM_ADDRESS
    }, axiosConfig);

    const build = buildResponse.data;
    console.log(`   Build ID: ${build.id}`);
    console.log(`   Fee: ${(Number(build.fee) / 1_000_000).toFixed(6)} ADA`);
    console.log(`   Tx Hash: ${build.txBodyHash}\n`);

    // 3. Sign and submit with HSM (single call)
    console.log('3. Signing and submitting with HSM...');
    const submitResponse = await axios.post(`${SIGN_URL}/SignAndSubmitWithHsm`, {
      buildId: build.id
    }, axiosConfig);

    const submission = submitResponse.data;
    console.log(`   Transaction submitted successfully!`);
    console.log(`   Tx Hash: ${submission.txHash}`);
    console.log(`\n   https://preview.cardanoscan.io/transaction/${submission.txHash}`);

  } catch (error: any) {
    console.error('\nError:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
}

main();
