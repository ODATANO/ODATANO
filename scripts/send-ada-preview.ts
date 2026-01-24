import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

const BUILD_BODY = {
  senderAddress: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  recipientAddress: "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622",
  lovelaceAmount: 10000000
};

const SIGNING_KEY_PATH = './payment.skey';

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx.body.json');

async function main() {
  try {
    console.log('Starting ADA transfer (10 ADA) on Preview...');

    // Build Transaction
    console.log('\nBuilding Transaction...');
    const buildResponse = await axios.post(`${ODATA_URL}/BuildSimpleAdaTransaction`, BUILD_BODY);
    const buildData = buildResponse.data;

    const buildId = buildData.id;
    const unsignedTxCbor = buildData.unsignedTxCbor;
    const txHash = buildData.txBodyHash;

    console.log(`Build successful – ID: ${buildId}`);
    console.log(`Fee: ${(buildData.fee / 1_000_000).toFixed(6)} ADA`);
    console.log(`Transaction Hash: ${txHash}`);

    // unsignedTxCbor → tx.body.json (TextEnvelope)
    const textEnvelope = {
      type: "Unwitnessed Tx ConwayEra",
      description: "Ledger Cddl Format",
      cborHex: unsignedTxCbor
    };

    writeFileSync(txBodyJsonPath, JSON.stringify(textEnvelope, null, 2));
    console.log('unsignedTxCbor as tx.body.json saved');

    // Sign transaction with cardano-cli
    console.log('\nSign with cardano-cli...');
    execSync(
      `docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
      `--tx-body-file tx.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx.signed.json created');

    // Extract signedTxCbor from tx.signed.json
    const signedJsonContent = readFileSync(join(tempDir, 'tx.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    // Validate CBOR format (84 = CBOR array with 4 elements, followed by map marker)
    if (!signedTxCbor.startsWith('84a')) {
      throw new Error(`Warning: signedTxCbor has unexpected format! Starts with: ${signedTxCbor.slice(0, 6)}`);
    }

    console.log('signedTxCbor extracted (starts with', signedTxCbor.slice(0, 6), ')');

    // Submit Transaction
    console.log('\nSubmitting Transaction...');
    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    });

    console.log('Response Status:', submitResponse.status);

    const submitData = submitResponse.data;

    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\nTransaction submitted successfully! (HTTP 204 - No Content)');
      console.log('Transaction Hash:', txHash);
      console.log('\nCheck transaction on Cardano Explorer:');
      console.log(`https://preview.cardanoscan.io/transaction/${txHash}`);
    } else {
      console.log('\nTransaction submitted successfully!');
      console.log('Full Response:', JSON.stringify(submitData, null, 2));
    }

  } catch (error: any) {
    console.error('\nError:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error message:', error.message);
    }
  } finally {
    // Cleanup temporary files
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx.signed.json')); } catch {}
  }
}

main();