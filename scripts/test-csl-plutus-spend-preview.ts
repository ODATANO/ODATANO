import axios from 'axios';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Test script: CSL PlutusV3 Pharma Trace Spend (Redeem) on Preview
 *
 * Purpose: Verify that BuildPlutusSpendTransaction with inlineDatumJson works
 * correctly — consuming a minted NFT at a script address and producing a
 * continuing output with an updated inline datum (state-machine pattern).
 *
 * Flow:
 *   1. Find the UTxO from the previous mint transaction (contains the NFT + ChainOfCustody datum)
 *   2. BuildPlutusSpendTransaction with:
 *      - validatorScript (spend validator, parameterized)
 *      - scriptTxHash + scriptOutputIndex (the minted NFT UTxO)
 *      - redeemerJson: Transfer action with next_holder VKH
 *      - datumJson: current ChainOfCustody (for script input)
 *      - inlineDatumJson: updated ChainOfCustody (for continuing output)
 *      - requiredSignersJson: current holder VKH
 *   3. Sign with cardano-cli
 *   4. Submit
 *
 * Prerequisites:
 *   1. ODATANO running with TX_BUILDERS=csl:
 *        TX_BUILDERS=csl BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_... npm run cds:watch
 *   2. payment.skey in project root (preview testnet wallet)
 *   3. Docker available (for cardano-cli signing)
 *   4. A previously minted NFT from test-csl-plutus-mint-preview.ts
 *
 * Usage:
 *   npx tsx scripts/test-csl-plutus-spend-preview.ts
 *
 * IMPORTANT: Update MINT_TX_HASH and MINT_OUTPUT_INDEX below with the
 * transaction hash and output index from your mint transaction.
 */

const ODATA_URL = 'http://localhost:4004/odata/v4/cardano-transaction';
const ODATA_READ_URL = 'http://localhost:4004/odata/v4/cardano-odata';

// ---------------------------------------------------------------------------
// Configuration — adjust to your wallet and mint transaction
// ---------------------------------------------------------------------------

// Wallet address on preview (same as minting wallet)
const SENDER_ADDRESS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

// Manufacturer verification key hash (28 bytes hex)
const MANUFACTURER_VKH = "374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a1";

// === UPDATE THESE after running the mint script ===
// Transaction hash where the NFT was minted (from mint script output)
const MINT_TX_HASH = "a63d4f8615b8bc99cce2a1a65914ef941dec00ec62873dca0e2a890156f29a87";
// Output index of the UTxO at the script address (usually 0 or 1)
const MINT_OUTPUT_INDEX = 0;

// For this test, we transfer custody to ourselves (same VKH).
// In production, this would be a different holder's VKH.
const NEXT_HOLDER_VKH = MANUFACTURER_VKH;

// ---------------------------------------------------------------------------
// Pharma Trace PlutusV3 Validator (Aiken v1.1.21, odatano/nft-lock)
// ---------------------------------------------------------------------------

// Unapplied compiled code from plutus.json — pharma_trace.pharma_trace.spend
// NOTE: For a combined validator (mint+spend), this may be the same hex as mint.
// If your plutus.json has a separate spend validator, use that hex here.
// For the pharma_trace combined validator, the mint hex is used for both.
const UNAPPLIED_VALIDATOR_HEX = "5902be010100229800aba2aba1aab9faab9eaab9dab9a9bae00248888889660033001300437540112300730083008300830083008300830083008001911919800800801912cc00400629422b30013371e6eb8c02800400e2946266004004601600280310094dc3a4000911119194c004c024dd5000cc03001a60180049112cc004c01800e264b30013300837586012601c6ea800c02e26644b30010018014566002602600313370e6eb4c040c0480052002801202240442940c8c8cc004004dd59809180998099809980998081baa0052259800800c00e2646644b30013372200e00515980099b8f0070028800c01901244cc014014c05c0110121bae3011001375660240026026002809052f5bded8c114a08060dd7180798069baa0048acc004cdc3a4004007132332259800980498079baa004899192cc004c05400a2b3001300b3011375400719800980a18091baa0039bae30143012375400d2301530160014889660026601e6eb0c040c054dd50051bae300130153754007132323300100137586004602e6ea8030896600200314a1159800992cc004cdc3a400860306ea8006264b300130133019375400313232323298009bad30200019bae30200049bae30200039bae30200024888966002604a00b15980099b8f375c604860446ea8024dd7181218111baa0108acc004cdc79bae300e3022375401201f15980099b8f375c601a60446ea8024dd7180698111baa01089919b87375a600260466ea8028cdc01bad300130233754022900111812981318131813000c52820408a50408114a081022c81186040002603e002603c00260346ea80062c80c0c06cc064dd5000c528202e300330183754603400314a3133002002301b001405880c88c060c064c064006294101322c80822c8098dd7180980098081baa0048b201c301000130103011001300d375400916402c80586016601800260160088a4d13656400801";

// Asset name for the minted NFT (same as in mint script)
const ASSET_NAME = "PHARMA_BATCH_001";
const ASSET_NAME_HEX = Buffer.from(ASSET_NAME, 'utf8').toString('hex');

// Batch ID for the ChainOfCustody datum
const BATCH_ID_HEX = Buffer.from("BATCH-2026-001", 'utf8').toString('hex');

// ---------------------------------------------------------------------------
// Datum & Redeemer construction
// ---------------------------------------------------------------------------

// Current ChainOfCustody datum (step 0 — as set during mint)
const CURRENT_DATUM = {
  constructor: 0,
  fields: [
    { bytes: MANUFACTURER_VKH },  // manufacturer
    { bytes: MANUFACTURER_VKH },  // current_holder
    { bytes: BATCH_ID_HEX },      // batch_id
    { int: 0 }                     // step
  ]
};

// Updated ChainOfCustody datum (step 1 — after transfer)
const UPDATED_DATUM = {
  constructor: 0,
  fields: [
    { bytes: MANUFACTURER_VKH },  // manufacturer (unchanged)
    { bytes: NEXT_HOLDER_VKH },   // current_holder → next holder
    { bytes: BATCH_ID_HEX },      // batch_id (unchanged)
    { int: 1 }                     // step incremented
  ]
};

// Redeemer: Transfer action — Constr(0, [next_holder_vkh])
// The pharma_trace spend validator expects this as the redeemer
const REDEEMER = {
  constructor: 0,
  fields: [
    { bytes: NEXT_HOLDER_VKH }
  ]
};

// Script parameters: apply manufacturer VKH to the unapplied validator
const scriptParams = [{ bytes: MANUFACTURER_VKH }];

// ---------------------------------------------------------------------------
// Build the request
// ---------------------------------------------------------------------------

const BUILD_BODY = {
  senderAddress: SENDER_ADDRESS,
  recipientAddress: SENDER_ADDRESS,
  lovelaceAmount: 2_000_000,
  validatorScript: UNAPPLIED_VALIDATOR_HEX,
  scriptTxHash: MINT_TX_HASH,
  scriptOutputIndex: MINT_OUTPUT_INDEX,
  redeemerJson: JSON.stringify(REDEEMER),
  datumJson: JSON.stringify(CURRENT_DATUM),
  changeAddress: SENDER_ADDRESS,
  requiredSignersJson: JSON.stringify([MANUFACTURER_VKH]),
  scriptParamsJson: JSON.stringify(scriptParams),
  inlineDatumJson: JSON.stringify(UPDATED_DATUM),
};

const tempDir = tmpdir();
const txBodyJsonPath = join(tempDir, 'tx-csl-v3-spend.body.json');

async function main() {
  try {

    console.log('=== CSL PlutusV3 Pharma Trace Spend (Redeem) — Preview ===');
    console.log('');
    console.log('Tests BuildPlutusSpendTransaction with inlineDatumJson (state-machine pattern).');
    console.log('Consumes the minted NFT UTxO and produces a continuing output with updated datum.');
    console.log('');
    console.log('Validator:       pharma_trace.pharma_trace.spend (Aiken v1.1.21)');
    console.log('Manufacturer:   ', MANUFACTURER_VKH);
    console.log('Next Holder:    ', NEXT_HOLDER_VKH);
    console.log('Asset Name:     ', ASSET_NAME, `(${ASSET_NAME_HEX})`);
    console.log('Script UTxO:    ', `${MINT_TX_HASH}#${MINT_OUTPUT_INDEX}`);
    console.log('Current Datum:   ChainOfCustody { step: 0, holder:', MANUFACTURER_VKH.slice(0, 8), '... }');
    console.log('Updated Datum:   ChainOfCustody { step: 1, holder:', NEXT_HOLDER_VKH.slice(0, 8), '... }');
    console.log('Redeemer:        Transfer { next_holder:', NEXT_HOLDER_VKH.slice(0, 8), '... }');

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

    // Step 1: Build PlutusV3 Spend Transaction via CSL
    console.log('\n[1/3] Building PlutusV3 Spend Transaction (CSL builder)...');
    console.log('       scriptParamsJson applied → validator address derived');
    console.log('       inlineDatumJson → updated ChainOfCustody on continuing output');

    const buildResponse = await axios.post(`${ODATA_URL}/BuildPlutusSpendTransaction`, BUILD_BODY);
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
      `--tx-body-file tx-csl-v3-spend.body.json ` +
      `--signing-key-file /keys/payment.skey ` +
      `--testnet-magic 2 ` +
      `--out-file tx-csl-v3-spend.signed.json`,
      { stdio: 'inherit' }
    );

    console.log('Signed: tx-csl-v3-spend.signed.json created');

    // Extract signedTxCbor
    const signedJsonContent = readFileSync(join(tempDir, 'tx-csl-v3-spend.signed.json'), 'utf8');
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
    });

    console.log('Response Status:', submitResponse.status);

    const submitData = submitResponse.data;

    if (submitResponse.status === 204 || !submitData || submitData === '') {
      console.log('\n=== SUCCESS: Plutus Spend Transaction submitted! ===');
      console.log('');
      console.log('BuildPlutusSpendTransaction with inlineDatumJson works correctly.');
      console.log('The continuing output carries the updated ChainOfCustody datum.');
      console.log('');
      console.log('Transaction Hash: ', txHash);
      console.log('Script Hash:      ', buildData.scriptHash || '(not returned)');
      console.log('Consumed UTxO:    ', `${MINT_TX_HASH}#${MINT_OUTPUT_INDEX}`);
      console.log('New Datum:         ChainOfCustody { step: 1, holder:', NEXT_HOLDER_VKH.slice(0, 8), '... }');
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

      // Check for common Plutus spend errors
      const errStr = JSON.stringify(errData);
      if (errStr.includes('PPViewHashesDontMatch')) {
        console.error('\n!!! PPViewHashesDontMatch detected !!!');
        console.error('The cost model handling is wrong for the spend transaction.');
      }
      if (errStr.includes('NonOutputSupplimentaryDatums') || errStr.includes('ExtraneousScriptWitnessesUTXOW')) {
        console.error('\nHint: Datum/script witness mismatch. Check datumJson and inlineDatumJson.');
      }
      if (errStr.includes('MissingRequiredSigners') || errStr.includes('extra_signatories')) {
        console.error('\nHint: Missing required signers. Check requiredSignersJson.');
      }
    } else {
      console.error('Error message:', error.message);
    }
  } finally {
    try { unlinkSync(txBodyJsonPath); } catch {}
    try { unlinkSync(join(tempDir, 'tx-csl-v3-spend.signed.json')); } catch {}
  }
}

main();
