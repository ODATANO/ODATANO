import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

const policyId = "def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea";
const assetName = "TokenM";
const assetNameHex = Buffer.from(assetName, 'utf8').toString('hex');

// Mint actions (positive quantity = mint, negative = burn)
const MINT_ACTIONS = [
  {
    assetUnit: policyId + assetNameHex, // Example: policyId + "TokenM" in hex
    quantity: "1000" // Mint 1000 tokens
  }
];

// Minting policy script in CBOR hex format
const MINTING_POLICY_SCRIPT = "585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009";

const BUILD_BODY = {
  network: "preview",
  senderAddress: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  recipientAddress: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp", // Mint to same address (sender)
  lovelaceAmount: 2000000, // 2 ADA (min ADA with minted tokens)
  mintActionsJson: JSON.stringify(MINT_ACTIONS),
  mintingPolicyScript: MINTING_POLICY_SCRIPT
};

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-mint.body.json');

async function main() {
  try {
    console.log('Starting Token Minting on Preview...');
    console.log('Mint Actions:', JSON.stringify(MINT_ACTIONS, null, 2));

    // Build Minting Transaction
    console.log('\nBuilding Minting Transaction...');
    const buildResponse = await axios.post(`${ODATA_URL}/BuildMintTransaction`, BUILD_BODY);
    const buildData = buildResponse.data;

    // Validate build response
    if (!buildData || !buildData.unsignedTxCbor) {
      throw new Error('Build failed: Response does not contain unsignedTxCbor. Check the response data above.');
    }

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
    console.log('unsignedTxCbor as tx-mint.body.json saved');

    // Sign transaction with cardano-cli
    console.log('\nSign with cardano-cli...');
    execSync(
      `docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
      `--tx-body-file tx-mint.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-mint.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-mint.signed.json created');

    // Extract signedTxCbor from tx.signed.json
    const signedJsonContent = readFileSync(join(tempDir, 'tx-mint.signed.json'), 'utf8');
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
      console.log('\nMinted Tokens:');
      MINT_ACTIONS.forEach(action => {
        console.log(`  - ${action.quantity} of ${action.assetUnit}`);
      });
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
    try { unlinkSync(join(tempDir, 'tx-mint.signed.json')); } catch {}
  }
}

main();
