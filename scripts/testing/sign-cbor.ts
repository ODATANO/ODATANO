import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

const SIGNING_KEY = 'payment.skey';
const TESTNET_MAGIC = 2;
const TEMP_DIR = 'C:/temp';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const cborHex = process.argv[2] || await ask('Unsigned TX CBOR hex: ');

  if (!cborHex) {
    console.error('No CBOR hex provided.');
    process.exit(1);
  }

  // Ensure temp dir exists
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }

  const txBodyPath = join(TEMP_DIR, 'tx.body.json');
  const txSignedPath = join(TEMP_DIR, 'tx.signed.json');

  // Write TextEnvelope
  const envelope = {
    type: 'Unwitnessed Tx ConwayEra',
    description: 'Ledger Cddl Format',
    cborHex
  };
  writeFileSync(txBodyPath, JSON.stringify(envelope, null, 2));

  // Sign with cardano-cli in Docker
  const projectRoot = join(__dirname, '..').replace(/\\/g, '/');
  const tempDir = TEMP_DIR.replace(/\\/g, '/');

  console.log(`\nSigning with cardano-cli (testnet-magic ${TESTNET_MAGIC})...`);

  try {
    execSync(
      `docker run --rm ` +
      `-v ${projectRoot}:/keys ` +
      `-v ${tempDir}:/work ` +
      `-w /work ` +
      `ghcr.io/blinklabs-io/cardano-node:latest ` +
      `cli conway transaction sign ` +
      `--tx-body-file tx.body.json ` +
      `--signing-key-file /keys/${SIGNING_KEY} ` +
      `--testnet-magic ${TESTNET_MAGIC} ` +
      `--out-file tx.signed.json`,
      { stdio: 'inherit' }
    );
  } catch {
    console.error('Signing failed.');
    process.exit(1);
  }

  // Extract signed CBOR
  const signedJson = JSON.parse(readFileSync(txSignedPath, 'utf8'));
  const signedCbor = signedJson.cborHex;

  console.log('\nSigned TX CBOR:');
  console.log(signedCbor);

  // Cleanup
  try { unlinkSync(txBodyPath); } catch {}
  try { unlinkSync(txSignedPath); } catch {}
}

main();
