import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

// CAP mock auth: Basic auth with any user (e.g. alice), no password required
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:').toString('base64');
const axiosConfig = { headers: { 'Authorization': AUTH_HEADER } };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Sender wallet (must have ADA to lock + fees)
const SENDER_ADDRESS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

// How much ADA to lock at the script address (in lovelace)
const LOVELACE_TO_LOCK = 5_000_000; // 5 ADA

// PlutusV3 validator script in CBOR hex - must match what you use in plutus-spend-preview.ts
const VALIDATOR_SCRIPT = "587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401";

// Datum to attach to the locked UTxO (cardano-cli DetailedSchema JSON)
// This datum must match what you provide as redeemerJson/datumJson when spending.
const OUTPUT_DATUM = { constructor: 0, fields: [] };

// Network ID: 0 = preview, 1 = mainnet
const NETWORK_ID = 0;

// ---------------------------------------------------------------------------

/**
 * Derive the script address (enterprise, no staking) from a PlutusV3 script CBOR hex.
 */
function deriveScriptAddress(scriptCborHex: string, networkId: number): string {
  const scriptBytes = Buffer.from(scriptCborHex, 'hex');
  const plutusScript = CSL.PlutusScript.new_v3(scriptBytes);
  const scriptHash = plutusScript.hash();
  const credential = CSL.Credential.from_scripthash(scriptHash);
  const enterpriseAddr = CSL.EnterpriseAddress.new(networkId, credential);
  return enterpriseAddr.to_address().to_bech32();
}

const SCRIPT_ADDRESS = deriveScriptAddress(VALIDATOR_SCRIPT, NETWORK_ID);

const BUILD_BODY = {
  senderAddress: SENDER_ADDRESS,
  recipientAddress: SCRIPT_ADDRESS,
  lovelaceAmount: LOVELACE_TO_LOCK,
  outputDatumJson: JSON.stringify(OUTPUT_DATUM),
  changeAddress: SENDER_ADDRESS,
};

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-lock.body.json');

async function main() {
  try {
    console.log('=== Lock ADA at Script Address (Preview) ===');
    console.log('');
    console.log('Validator Script:', VALIDATOR_SCRIPT.slice(0, 20) + '...');
    console.log('Script Address: ', SCRIPT_ADDRESS);
    console.log('Sender:         ', SENDER_ADDRESS);
    console.log('Amount to lock: ', `${(LOVELACE_TO_LOCK / 1_000_000).toFixed(6)} ADA`);
    console.log('Output Datum:   ', JSON.stringify(OUTPUT_DATUM));

    // Step 1: Build transaction
    console.log('\n[1/3] Building transaction (send ADA to script address with datum)...');
    const buildResponse = await axios.post(
      `${ODATA_URL}/BuildSimpleAdaTransaction`,
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

    console.log('Build successful!');
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
      `--tx-body-file tx-lock.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-lock.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-lock.signed.json created');

    // Extract signedTxCbor
    const signedJsonContent = readFileSync(join(tempDir, 'tx-lock.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    if (!signedTxCbor.startsWith('84a')) {
      throw new Error(`Warning: signedTxCbor has unexpected format! Starts with: ${signedTxCbor.slice(0, 6)}`);
    }

    console.log('signedTxCbor extracted (starts with', signedTxCbor.slice(0, 6), ')');

    // Step 3: Submit transaction
    console.log('\n[3/3] Submitting Transaction...');
    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    }, axiosConfig);

    console.log('Response Status:', submitResponse.status);

    const submitData = submitResponse.data;

    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\n=== ADA locked at script address! ===');
      console.log('Transaction Hash:', txHash);
      console.log('');
      console.log('Check on Cardano Explorer:');
      console.log(`https://preview.cardanoscan.io/transaction/${txHash}`);
      console.log('');
      console.log('=== Next step: Spend from script ===');
      console.log('Update plutus-spend-preview.ts with:');
      console.log(`  SCRIPT_TX_HASH     = "${txHash}"`);
      console.log(`  SCRIPT_OUTPUT_INDEX = 0`);
    } else {
      console.log('\nTransaction submitted successfully!');
      console.log('Full Response:', JSON.stringify(submitData, null, 2));
    }

  } catch (error: any) {
    console.error('\nError:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.code) {
      console.error('Code:', error.code);
      console.error('Message:', error.message || '(empty)');
      if (error.code === 'ECONNREFUSED') {
        console.error('\nIs the ODATANO server running? Start it with: npm run cds:watch');
      }
    } else {
      console.error('Error message:', error.message || String(error));
    }
  } finally {
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx-lock.signed.json')); } catch {}
  }
}

main();
