// Zero withdrawal from a staking script on preview. Registers the stake credential first if needed.
// Needs a running ODATANO with ogmios and payment.skey in the working directory.
// Usage: npx tsx scripts/testing/withdraw-zero-preview.ts

import axios from 'axios';
import { Agent } from 'http';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { blake2b_224 } from '@harmoniclabs/crypto';
import { credentialToStakeAddress } from '../../srv/utils/mappers';
import { applyScriptParameters } from '../../srv/utils/tx-build-helper';

const BASE_URL = 'http://localhost:4004/odata/v4';
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:').toString('base64');
// no keep-alive: signing can take longer than the server's idle timeout for the socket
const axiosConfig = { headers: { Authorization: AUTH_HEADER }, validateStatus: () => true, httpAgent: new Agent({ keepAlive: false }) };

// Sender: pays the fee and the deposit, gives collateral, receives the outputs
const SENDER_ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';

// PlutusV3 "param -> ctx -> ()": applied to one parameter it succeeds for every purpose; the hash
// of the applied script is the stake credential that withdraws
const STAKING_SCRIPT = '46010100224981';
const SCRIPT_PARAMS = [{ int: 0 }];

const REDEEMER = { constructor: 0, fields: [] };
const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;

function scriptStakeAddress(scriptCborHex: string): string {
  const hash = blake2b_224(Uint8Array.from(Buffer.concat([Buffer.from([0x03]), Buffer.from(scriptCborHex, 'hex')])));
  return credentialToStakeAddress(Buffer.from(hash).toString('hex'), true, 'preview');
}

async function isRegistered(stakeAddress: string): Promise<boolean> {
  const res = await axios.post(`${BASE_URL}/cardano/GetAccountByStakeAddress`, { stakeAddress }, axiosConfig);
  if (res.status === 404) return false;
  if (res.status !== 200) throw new Error(`GetAccountByStakeAddress ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data.active === true;
}

function signWithCli(unsignedTxCbor: string, label: string): string {
  const dir = tmpdir();
  const bodyFile = `${label}.body.json`;
  const signedFile = `${label}.signed.json`;
  writeFileSync(join(dir, bodyFile), JSON.stringify({
    type: 'Unwitnessed Tx ConwayEra',
    description: 'Ledger Cddl Format',
    cborHex: unsignedTxCbor,
  }, null, 2));
  execSync(
    `docker run --rm -v ${dir}:/work -v ${process.cwd()}:/keys -w /work ` +
    `ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign ` +
    `--tx-body-file ${bodyFile} --signing-key-file /keys/payment.skey --testnet-magic 2 --out-file ${signedFile}`,
    { stdio: 'inherit' }
  );
  const signed = JSON.parse(readFileSync(join(dir, signedFile), 'utf8')).cborHex as string;
  unlinkSync(join(dir, bodyFile));
  unlinkSync(join(dir, signedFile));
  return signed;
}

async function buildSignSubmit(label: string, body: Record<string, unknown>): Promise<string> {
  console.log(`\n[${label}] building`);
  const build = await axios.post(`${BASE_URL}/cardano-transaction/BuildPlutusTransaction`, body, axiosConfig);
  if (build.status !== 200) throw new Error(`build ${build.status}: ${JSON.stringify(build.data)}`);
  console.log(`  fee ${build.data.fee} lovelace, tx ${build.data.txBodyHash}`);

  console.log(`[${label}] signing`);
  const signedTxCbor = signWithCli(build.data.unsignedTxCbor, label);

  console.log(`[${label}] submitting`);
  const submit = await axios.post(`${BASE_URL}/cardano-transaction/SubmitTransaction`, { buildId: build.data.id, signedTxCbor }, axiosConfig);
  if (submit.status >= 300) throw new Error(`submit ${submit.status}: ${JSON.stringify(submit.data)}`);
  console.log(`  submitted ${build.data.txBodyHash}`);
  return build.data.txBodyHash as string;
}

async function waitConfirmed(txHash: string): Promise<void> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await axios.post(`${BASE_URL}/cardano/GetTransactionConfirmations`, { txHash }, axiosConfig);
    if (res.status === 200 && Number(res.data.confirmations ?? res.data) >= 1) {
      console.log(`  confirmed ${txHash}`);
      return;
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error(`transaction ${txHash} not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000}s`);
}

async function main() {
  const stakeAddress = scriptStakeAddress(applyScriptParameters(STAKING_SCRIPT, SCRIPT_PARAMS));
  console.log(`script stake address ${stakeAddress}`);

  if (await isRegistered(stakeAddress)) {
    console.log('credential is registered');
  } else {
    const txHash = await buildSignSubmit('register', {
      senderAddress: SENDER_ADDRESS,
      outputsJson: JSON.stringify([{ address: SENDER_ADDRESS, lovelaceAmount: '2000000' }]),
      certificatesJson: JSON.stringify([{ type: 'registerStake', stakeAddress }]),
    });
    await waitConfirmed(txHash);
    // the node lists only delegated credentials, so a provider must have indexed the certificate
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    while (!(await isRegistered(stakeAddress))) {
      if (Date.now() > deadline) throw new Error('no provider reports the registration yet');
      await new Promise(r => setTimeout(r, 10_000));
    }
    console.log('  registration visible to a provider');
  }

  const txHash = await buildSignSubmit('withdraw-zero', {
    senderAddress: SENDER_ADDRESS,
    outputsJson: JSON.stringify([{ address: SENDER_ADDRESS, lovelaceAmount: '2000000' }]),
    withdrawalsJson: JSON.stringify([{
      rewardAddress: stakeAddress,
      lovelace: '0',
      stakingScript: STAKING_SCRIPT,
      scriptParamsJson: JSON.stringify(SCRIPT_PARAMS),
      redeemerJson: JSON.stringify(REDEEMER),
    }]),
  });
  await waitConfirmed(txHash);
  console.log('\nwithdraw-zero from the script confirmed');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
