import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

const BUILD_BODY = {
  network: "preview",
  senderAddress: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  recipientAddress: "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622",
  lovelaceAmount: 10000000
};

const SIGNING_KEY_PATH = './payment.skey';

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx.body.json');
const txSignedPath = join(tempDir, 'tx.signed');

async function main() {
  try {
    console.log('Starting ADA transfer (10 ADA) on Preview...');

    // 1. Build Transaction
    console.log('Building Transaction...');
    const buildResponse = await axios.post(`${ODATA_URL}/BuildSimpleAdaTransaction`, BUILD_BODY);
    const buildData = buildResponse.data;

    const buildId = buildData.id;
    const unsignedTxCbor = buildData.unsignedTxCbor;

    console.log(`Build successful – ID: ${buildId}`);
    console.log(`   Fee: ${(buildData.fee / 1_000_000).toFixed(6)} ADA`);

    // 2. unsignedTxCbor → TextEnvelope JSON
    const textEnvelope = {
      type: "Tx ConwayEra",
      description: "Ledger Cddl Format",
      cborHex: unsignedTxCbor
    };

    writeFileSync(txBodyJsonPath, JSON.stringify(textEnvelope, null, 2));
    console.log('unsignedTxCbor as tx.body.json (TextEnvelope) saved');

    // 3. Sign Transaction with cardano-cli
    console.log('Sign with cardano-cli...');
    execSync(
      `docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
      `--tx-body-file tx.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx.signed.json`,  // ← jetzt .json als Ausgabe!
      { stdio: 'inherit' }
    );
    console.log('Signed → tx.signed.json created');

    // 4. Extract signedTxCbor from tx.signed.json
    const signedJsonContent = readFileSync(join(tempDir, 'tx.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    if (!signedTxCbor.startsWith('84a5') && !signedTxCbor.startsWith('84a4')) {
      throw new Error('Warning: signedTxCbor does not start with 84a – invalid format!');
    }

    console.log('signedTxCbor correctly extracted (starts with', signedTxCbor.slice(0, 6), ')');
    // 5. Submit
    console.log('Submitting Transaction...');
    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    });

    console.log('Response:', submitResponse.data);

  } catch (error: any) {
    console.error('Error:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  } finally {
    // Cleanup
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(txSignedPath); } catch {}
  }
}

main();