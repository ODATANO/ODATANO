import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:').toString('base64');
const axiosConfig = { headers: { 'Authorization': AUTH_HEADER } };

// ---------------------------------------------------------------------------
// Configuration - Adjust these values for your use case
// ---------------------------------------------------------------------------

// Sender address (wallet that pays fees and provides collateral)
const SENDER_ADDRESS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

// Recipient address (where the unlocked ADA goes)
const RECIPIENT_ADDRESS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

// Lovelace to send to recipient from the script UTxO
const LOVELACE_AMOUNT = 2_000_000; // 2 ADA

// PlutusV3 validator script in CBOR hex
// This example is an always-true validator for testing purposes.
// Replace with your own validator script for production use.
const VALIDATOR_SCRIPT = "587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401";

// Script UTxO reference - the UTxO sitting at the script address to be consumed.
// You must first lock ADA at the script address (e.g. via BuildSimpleAdaTransaction
// to the script address), then provide that transaction's hash and output index here.
const SCRIPT_TX_HASH = "3e226adabf25f3d862fcda97d2e9bdd2d3d40d8e1def7b5dc1c7b6d5ab4a1215"; // 64 hex chars
const SCRIPT_OUTPUT_INDEX = 0;

// Redeemer JSON (cardano-cli DetailedSchema format)
// Unit redeemer: { "constructor": 0, "fields": [] }
const REDEEMER = { constructor: 0, fields: [] };

// Datum JSON (optional - only needed if the UTxO does NOT have an inline datum)
// Set to null if the script UTxO uses an inline datum on-chain.
const DATUM = { constructor: 0, fields: [] };

// ---------------------------------------------------------------------------

const BUILD_BODY: Record<string, any> = {
  senderAddress: SENDER_ADDRESS,
  recipientAddress: RECIPIENT_ADDRESS,
  lovelaceAmount: LOVELACE_AMOUNT,
  validatorScript: VALIDATOR_SCRIPT,
  scriptTxHash: SCRIPT_TX_HASH,
  scriptOutputIndex: SCRIPT_OUTPUT_INDEX,
  redeemerJson: JSON.stringify(REDEEMER),
  changeAddress: SENDER_ADDRESS,
};

// Only include datumJson if datum is provided
if (DATUM !== null) {
  BUILD_BODY.datumJson = JSON.stringify(DATUM);
}

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-plutus-spend.body.json');

async function main() {
  try {
    // Validate script UTxO reference
    if (!SCRIPT_TX_HASH || SCRIPT_TX_HASH.length !== 64) {
      console.error('ERROR: SCRIPT_TX_HASH must be a 64-character hex transaction hash.');
      console.error('Run lock-ada-at-script-preview.ts first to lock ADA at the script address.');
      process.exit(1);
    }

    console.log('=== Plutus Spend Transaction on Preview ===');
    console.log('');
    console.log('Validator Script:', VALIDATOR_SCRIPT.slice(0, 20) + '...');
    console.log('Script UTxO:     ', `${SCRIPT_TX_HASH}#${SCRIPT_OUTPUT_INDEX}`);
    console.log('Redeemer:        ', JSON.stringify(REDEEMER));
    console.log('Datum:           ', DATUM ? JSON.stringify(DATUM) : '(inline on-chain)');
    console.log('Sender:          ', SENDER_ADDRESS);
    console.log('Recipient:       ', RECIPIENT_ADDRESS);
    console.log('Amount:          ', `${(LOVELACE_AMOUNT / 1_000_000).toFixed(6)} ADA`);

    // Step 1: Build Plutus Spend Transaction
    console.log('\n[1/3] Building Plutus Spend Transaction...');
    const buildResponse = await axios.post(
      `${ODATA_URL}/BuildPlutusSpendTransaction`,
      BUILD_BODY,
      axiosConfig
    );
    const buildData = buildResponse.data;

    if (!buildData || !buildData.unsignedTxCbor) {
      throw new Error('Build failed: Response does not contain unsignedTxCbor.');
    }

    const buildId = buildData.id;
    const unsignedTxCbor = buildData.unsignedTxCbor;
    const txHash = buildData.txBodyHash;

    console.log(`Build successful!`);
    console.log(`  Build ID: ${buildId}`);
    console.log(`  Fee:      ${(buildData.fee / 1_000_000).toFixed(6)} ADA`);
    console.log(`  Tx Hash:  ${txHash}`);

    // Step 2: Sign with cardano-cli
    const textEnvelope = {
      type: "Unwitnessed Tx ConwayEra",
      description: "Ledger Cddl Format",
      cborHex: unsignedTxCbor
    };

    writeFileSync(txBodyJsonPath, JSON.stringify(textEnvelope, null, 2));
    console.log('\n[2/3] Signing with cardano-cli...');

    execSync(
      `docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
      `--tx-body-file tx-plutus-spend.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-plutus-spend.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-plutus-spend.signed.json created');

    // Extract signedTxCbor
    const signedJsonContent = readFileSync(join(tempDir, 'tx-plutus-spend.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    if (!signedTxCbor.startsWith('84a')) {
      throw new Error(`Warning: signedTxCbor has unexpected format! Starts with: ${signedTxCbor.slice(0, 6)}`);
    }

    console.log('signedTxCbor extracted (starts with', signedTxCbor.slice(0, 6), ')');

    // Step 3: Submit Transaction
    console.log('\n[3/3] Submitting Transaction...');
    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    }, axiosConfig);

    console.log('Response Status:', submitResponse.status);

    const submitData = submitResponse.data;

    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\n=== Transaction submitted successfully! ===');
      console.log('Transaction Hash:', txHash);
      console.log('Script UTxO consumed:', `${SCRIPT_TX_HASH}#${SCRIPT_OUTPUT_INDEX}`);
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
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx-plutus-spend.signed.json')); } catch {}
  }
}

main();
