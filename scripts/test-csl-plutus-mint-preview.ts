import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Test script: CSL PlutusV3 Pharma Trace Mint on Preview
 *
 * Purpose: Verify that the CSL transaction builder correctly handles PlutusV3
 * cost models (297 parameters, Conway Chang 2) and does NOT produce
 * PPViewHashesDontMatch errors.
 *
 * Uses the pharma_trace parameterized PlutusV3 validator (Aiken v1.1.21).
 * The mint validator requires:
 *   - scriptParamsJson with manufacturer VKH (applies the parameter to the script)
 *   - requiredSignersJson with manufacturer VKH (extra_signatories check)
 *   - inlineDatumJson with ChainOfCustody datum (spend validator needs it)
 *
 * Prerequisites:
 *   1. ODATANO running with TX_BUILDERS=csl:
 *        TX_BUILDERS=csl BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_... npm run cds:watch
 *   2. payment.skey in project root (preview testnet wallet)
 *   3. Docker available (for cardano-cli signing)
 *   4. Wallet funded with preview tADA
 *
 * Usage:
 *   npx tsx scripts/test-csl-plutus-mint-preview.ts
 */

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';

// ---------------------------------------------------------------------------
// Configuration — adjust to your wallet
// ---------------------------------------------------------------------------

// Wallet address on preview (change to your own)
const SENDER_ADDRESS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

// Manufacturer verification key hash (28 bytes hex) — derived from your payment.skey
// This is the VKH of the wallet that signs the transaction.
// Obtain via: cardano-cli conway address key-hash --payment-verification-key-file payment.vkey
const MANUFACTURER_VKH = "374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a1";

// ---------------------------------------------------------------------------
// Pharma Trace PlutusV3 Validator (Aiken v1.1.21, odatano/nft-lock)
// ---------------------------------------------------------------------------

// Unapplied compiled code from plutus.json — pharma_trace.pharma_trace.mint
// This is a parameterized script: manufacturer VKH is applied via scriptParamsJson
const UNAPPLIED_VALIDATOR_HEX = "5902be010100229800aba2aba1aab9faab9eaab9dab9a9bae00248888889660033001300437540112300730083008300830083008300830083008001911919800800801912cc00400629422b30013371e6eb8c02800400e2946266004004601600280310094dc3a4000911119194c004c024dd5000cc03001a60180049112cc004c01800e264b30013300837586012601c6ea800c02e26644b30010018014566002602600313370e6eb4c040c0480052002801202240442940c8c8cc004004dd59809180998099809980998081baa0052259800800c00e2646644b30013372200e00515980099b8f0070028800c01901244cc014014c05c0110121bae3011001375660240026026002809052f5bded8c114a08060dd7180798069baa0048acc004cdc3a4004007132332259800980498079baa004899192cc004c05400a2b3001300b3011375400719800980a18091baa0039bae30143012375400d2301530160014889660026601e6eb0c040c054dd50051bae300130153754007132323300100137586004602e6ea8030896600200314a1159800992cc004cdc3a400860306ea8006264b300130133019375400313232323298009bad30200019bae30200049bae30200039bae30200024888966002604a00b15980099b8f375c604860446ea8024dd7181218111baa0108acc004cdc79bae300e3022375401201f15980099b8f375c601a60446ea8024dd7180698111baa01089919b87375a600260466ea8028cdc01bad300130233754022900111812981318131813000c52820408a50408114a081022c81186040002603e002603c00260346ea80062c80c0c06cc064dd5000c528202e300330183754603400314a3133002002301b001405880c88c060c064c064006294101322c80822c8098dd7180980098081baa0048b201c301000130103011001300d375400916402c80586016601800260160088a4d13656400801";

// Asset name for the minted NFT
const ASSET_NAME = "PHARMA_BATCH_001";
const ASSET_NAME_HEX = Buffer.from(ASSET_NAME, 'utf8').toString('hex');

// Batch ID for the ChainOfCustody datum
const BATCH_ID_HEX = Buffer.from("BATCH-2026-001", 'utf8').toString('hex');

// ---------------------------------------------------------------------------
// Build the request
// ---------------------------------------------------------------------------

// Script parameters: apply manufacturer VKH to the unapplied validator
// This makes it a concrete minting policy tied to a specific manufacturer
const scriptParams = [{ bytes: MANUFACTURER_VKH }];

// Mint actions — assetName-only (< 57 chars) since scriptParamsJson is provided;
// ODATANO derives policyId from the applied script and prepends it automatically
const MINT_ACTIONS = [
  {
    assetUnit: ASSET_NAME_HEX,
    quantity: "1"
  }
];

// ChainOfCustody inline datum — the spend validator needs this on the minted token output
// Constr(0, [manufacturer, current_holder, batch_id, step])
const INLINE_DATUM = {
  constructor: 0,
  fields: [
    { bytes: MANUFACTURER_VKH },  // manufacturer
    { bytes: MANUFACTURER_VKH },  // current_holder (= manufacturer at mint time)
    { bytes: BATCH_ID_HEX },      // batch_id
    { int: 0 }                     // step (0 = initial)
  ]
};

const BUILD_BODY = {
  senderAddress: SENDER_ADDRESS,
  recipientAddress: SENDER_ADDRESS,
  lovelaceAmount: 2_000_000,
  mintActionsJson: JSON.stringify(MINT_ACTIONS),
  mintingPolicyScript: UNAPPLIED_VALIDATOR_HEX,
  changeAddress: SENDER_ADDRESS,
  scriptParamsJson: JSON.stringify(scriptParams),
  requiredSignersJson: JSON.stringify([MANUFACTURER_VKH]),
  inlineDatumJson: JSON.stringify(INLINE_DATUM),
};

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-csl-v3-mint.body.json');

async function main() {
  try {
    console.log('=== CSL PlutusV3 Pharma Trace Mint — Preview ===');
    console.log('');
    console.log('Tests CSL builder with parameterized PlutusV3 validator (297 cost model params).');
    console.log('If PPViewHashesDontMatch occurs, the cost model padding fix is insufficient');
    console.log('and we need to escalate to the full scriptDataHash bypass approach.');
    console.log('');
    console.log('Validator:       pharma_trace.pharma_trace.mint (Aiken v1.1.21)');
    console.log('Manufacturer:   ', MANUFACTURER_VKH);
    console.log('Asset Name:     ', ASSET_NAME, `(${ASSET_NAME_HEX})`);
    console.log('Batch ID:       ', `BATCH-2026-001 (${BATCH_ID_HEX})`);
    console.log('Sender:         ', SENDER_ADDRESS);
    console.log('Inline Datum:    ChainOfCustody { manufacturer, current_holder, batch_id, step: 0 }');

    // Step 0: Verify server is running
    console.log('\n[0/3] Checking ODATANO server...');
    try {
      await axios.get('http://localhost:4004/odata/v4/cardano-transaction/$metadata');
      console.log('Server is running.');
    } catch {
      console.error('ERROR: ODATANO server not reachable at http://localhost:4004');
      console.error('Start with: TX_BUILDERS=csl BACKENDS=blockfrost BLOCKFROST_API_KEY=... npm run cds:watch');
      process.exit(1);
    }

    // Step 1: Build PlutusV3 Mint Transaction via CSL
    console.log('\n[1/3] Building PlutusV3 Mint Transaction (CSL builder)...');
    console.log('       scriptParamsJson applied → policyId derived from applied script');

    const buildResponse = await axios.post(`${ODATA_URL}/BuildMintTransaction`, BUILD_BODY);
    const buildData = buildResponse.data;

    if (!buildData || !buildData.unsignedTxCbor) {
      throw new Error('Build failed: Response does not contain unsignedTxCbor.');
    }

    const buildId = buildData.id;
    const unsignedTxCbor = buildData.unsignedTxCbor;
    const txHash = buildData.txBodyHash;

    console.log('Build successful!');
    console.log(`  Build ID:    ${buildId}`);
    console.log(`  Fee:         ${(buildData.fee / 1_000_000).toFixed(6)} ADA`);
    console.log(`  Tx Hash:     ${txHash}`);
    console.log(`  Script Hash: ${buildData.scriptHash || '(not returned)'}`);
    if (buildData.fingerprint) {
      console.log(`  Fingerprint: ${buildData.fingerprint}`);
    }

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
      `--tx-body-file tx-csl-v3-mint.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-csl-v3-mint.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-csl-v3-mint.signed.json created');

    // Extract signedTxCbor
    const signedJsonContent = readFileSync(join(tempDir, 'tx-csl-v3-mint.signed.json'), 'utf8');
    const signedJson = JSON.parse(signedJsonContent);
    const signedTxCbor = signedJson.cborHex;

    if (!signedTxCbor.startsWith('84a')) {
      throw new Error(`Warning: signedTxCbor has unexpected format! Starts with: ${signedTxCbor.slice(0, 6)}`);
    }

    console.log('signedTxCbor extracted (starts with', signedTxCbor.slice(0, 6), ')');

    // Step 3: Submit Transaction
    // PPViewHashesDontMatch would occur HERE if cost models are wrong
    console.log('\n[3/3] Submitting Transaction...');
    console.log('       (PPViewHashesDontMatch would appear here if cost model fix failed)');

    const submitResponse = await axios.post(`${ODATA_URL}/SubmitTransaction`, {
      buildId: buildId,
      signedTxCbor: signedTxCbor
    });

    console.log('Response Status:', submitResponse.status);

    const submitData = submitResponse.data;

    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\n=== SUCCESS: Transaction submitted! ===');
      console.log('');
      console.log('The CSL builder correctly handled PlutusV3 cost models (297 params).');
      console.log('PPViewHashesDontMatch fix is working.');
      console.log('');
      console.log('Transaction Hash: ', txHash);
      console.log('Policy ID:        ', buildData.scriptHash);
      console.log('Asset:            ', ASSET_NAME);
      if (buildData.fingerprint) {
        console.log('Fingerprint:      ', buildData.fingerprint);
      }
      console.log('Inline Datum:      ChainOfCustody (step 0)');
      console.log('\nCheck on Cardanoscan:');
      console.log(`https://preview.cardanoscan.io/transaction/${txHash}`);
    } else {
      console.log('\nTransaction submitted successfully!');
      console.log('Full Response:', JSON.stringify(submitData, null, 2));
    }

  } catch (error: any) {
    console.error('\n=== ERROR ===');
    if (error.response) {
      console.error('Status:', error.response.status);
      const errData = error.response.data;
      console.error('Data:', JSON.stringify(errData, null, 2));

      // Check specifically for PPViewHashesDontMatch
      const errStr = JSON.stringify(errData);
      if (errStr.includes('PPViewHashesDontMatch')) {
        console.error('\n!!! PPViewHashesDontMatch detected !!!');
        console.error('The simple padding fix (251 -> 297) was NOT sufficient.');
        console.error('Escalate to full bypass: compute scriptDataHash manually');
        console.error('using costModelsToLanguageViewCbor() from @harmoniclabs/cardano-costmodels-ts.');
      }
    } else {
      console.error('Error message:', error.message);
    }
  } finally {
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx-csl-v3-mint.signed.json')); } catch {}
  }
}

main();
