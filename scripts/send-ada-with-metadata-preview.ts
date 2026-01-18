import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

const METADATA = {
  "674": {
    "msg": ["Hello", "from", "ODATANO"]
  }
};

const BUILD_BODY = {
  network: "preview",
  senderAddress: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  recipientAddress: "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622",
  lovelaceAmount: 10000000,
  metadataJson: JSON.stringify(METADATA)
};

const SIGNING_KEY_PATH = './payment.skey';

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-metadata.body.json');
const txSignedPath = join(tempDir, 'tx-metadata.signed');

async function main() {
  try {
    console.log('Starting ADA transfer (10 ADA) with Metadata on Preview...');
    console.log('Metadata:', JSON.stringify(METADATA, null, 2));

    // build Transaction with Metadata
    console.log('\nBuilding Transaction with Metadata...');
    const buildResponse = await axios.post(`${ODATA_URL}/BuildTransactionWithMetadata`, BUILD_BODY);
    const buildData = buildResponse.data;

    const buildId = buildData.id;
    const unsignedTxCbor = buildData.unsignedTxCbor;
    const txHash = buildData.txBodyHash; // Use hash from build response

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
    console.log('unsignedTxCbor as tx-metadata.body.json saved');

    // sign transaction with cardano-cli
    console.log('\nSign with cardano-cli...');
    execSync(
      `docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
      `--tx-body-file tx-metadata.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-metadata.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-metadata.signed.json created');

    // extract signedTxCbor from tx.signed.json
    const signedJsonContent = readFileSync(join(tempDir, 'tx-metadata.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    // Validate CBOR format (84 = CBOR array with 4 elements, followed by map marker)
    if (!signedTxCbor.startsWith('84a')) {
      throw new Error(`Warning: signedTxCbor has unexpected format! Starts with: ${signedTxCbor.slice(0, 6)}`);
    }

    console.log('signedTxCbor extracted (starts with', signedTxCbor.slice(0, 6), ')');
    
    // submit
    console.log('\nSubmitting Transaction...');
    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    });

    console.log('Response Status:', submitResponse.status);
    console.log('Response Headers:', submitResponse.headers);
    console.log('Response Data Type:', typeof submitResponse.data);
    
    const submitData = submitResponse.data;
    
    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\nTransaction submitted successfully! (HTTP 204 - No Content)');
      console.log('Transaction Hash:', txHash);
      console.log('\nCheck transaction on Cardano Explorer:');
      console.log(`https://preview.cardanoscan.io/transaction/${txHash}`);
    } else {
      console.log('Response Data:', submitData);
      console.log('\nTransaction submitted successfully!');
      console.log('Full Response:', JSON.stringify(submitData, null, 2));
      
      if (submitData && typeof submitData === 'object') {
        console.log('\nSubmission ID:', submitData.id || 'N/A');
        console.log('Transaction Hash:', submitData.txHash || txHash);
        console.log('Status:', submitData.status || 'N/A');
      }
    }

  } catch (error: any) {
    console.error('\nError:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  } finally {
    // cleanup
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx-metadata.signed.json')); } catch {}
  }
}

main();
