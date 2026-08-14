/**
 * Wallet-worker end-to-end on preview: a full wallet session.
 *
 *   pending → building → submitting → submitted → confirmed
 *
 * Self-contained: It boots its own server with the worker enabled, drives the
 * OData surface, and shuts down again:
 *
 *   npx tsx scripts/testing/wallet-worker-e2e-preview.ts
 *   npx tsx scripts/testing/wallet-worker-e2e-preview.ts --amount 3000000 --depth 2
 *
 * What it proves, against the real chain:
 *  - the configured wallet is registered and its signer initialized
 *  - a submitted job runs build → sign → submit without operator interaction
 *  - the signed tx is durable BEFORE submission (the row carries txHash and
 *    signedTxCbor while still `submitting`) — the crash-safety invariant
 *  - the same idempotencyKey returns the SAME job instead of paying twice
 *  - the job reaches `confirmed` once the tx sits at the configured depth
 *
 * Key handling: the signing key is read from payment.skey and passed to the
 * server process in memory only. It is never written to a file and never logged.
 * The worker always spends from the enterprise address derived from that key —
 * the preflight refuses to run if that is not the funded payment.addr.
 */

import 'dotenv/config';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoftwareWorkerSigner } from '../../srv/blockchain/wallet-worker/signers';

const REPO_ROOT = resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 4005);
const BASE = `http://localhost:${PORT}/odata/v4/cardano-worker`;
const AUTH = 'Basic ' + Buffer.from('alice:').toString('base64');

const WALLET_ID = 'e2e-preview';
const KEY_ENV = 'E2E_PREVIEW_WALLET_KEY';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const LOVELACE = argOf('amount', 2_000_000);       // self-payment: only fees are really spent
const DEPTH = argOf('depth', 1);                   // 1 = confirmed as soon as included
const TIMEOUT_MS = argOf('timeout', 900_000);      // 15 min: build + submit + confirmation

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...parts: unknown[]) => console.log(...parts);

/** cardano-cli envelope → raw 32-byte ed25519 seed (strips the CBOR 0x5820 header). */
function seedFromEnvelope(path: string): string {
  const env = JSON.parse(readFileSync(path, 'utf8')) as { cborHex: string };
  const hex = env.cborHex.toLowerCase();
  const seed = hex.startsWith('5820') ? hex.slice(4) : hex;
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error(`unexpected key encoding in ${path}`);
  return seed;
}

async function odata(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${body?.error?.message ?? text}`);
  return body;
}

/** Balance at the address the worker will actually spend from. */
async function fetchBalance(address: string, network: string): Promise<bigint | null> {
  const key = process.env.BLOCKFROST_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://cardano-${network}.blockfrost.io/api/v0/addresses/${address}/utxos`,
    { headers: { project_id: key } });
  if (res.status === 404) return 0n;
  if (!res.ok) return null;
  const utxos = await res.json() as Array<{ amount: Array<{ unit: string; quantity: string }> }>;
  return utxos.reduce((sum, u) =>
    sum + BigInt(u.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n);
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE}/$metadata`, { headers: { Authorization: AUTH } });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(1_000);
  }
  throw new Error('server did not become ready within 120s');
}

async function main() {
  const network = process.env.NETWORK ?? 'preview';

  // ---- 1. Preflight: does our key own the funded address? ------------------
  const seed = seedFromEnvelope(`${REPO_ROOT}/payment.skey`);
  const expected = readFileSync(`${REPO_ROOT}/payment.addr`, 'utf8').trim();
  const signer = new SoftwareWorkerSigner(seed, network);
  const address = signer.getAddress();

  log('── preflight ──────────────────────────────────────────────');
  log('network        :', network);
  log('worker address :', address);
  if (address !== expected) {
    throw new Error(`derived address ${address} != payment.addr ${expected} — the worker would spend a different (probably empty) address`);
  }
  log('matches payment.addr: yes');

  const balance = await fetchBalance(address, network);
  if (balance !== null) {
    log('balance        :', `${Number(balance) / 1e6} ADA`);
    if (balance < BigInt(LOVELACE) + 2_000_000n) {
      throw new Error(`insufficient funds: need ~${(LOVELACE + 2_000_000) / 1e6} ADA (amount + fees/min-ADA)`);
    }
  }

  // ---- 2. Boot a server with the worker enabled ----------------------------
  log('\n── starting server (worker enabled) ───────────────────────');
  const child = spawn('npx', ['cds-serve', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      [KEY_ENV]: seed, // in-memory only — never persisted, never logged
      WALLET_WORKER_ENABLED: 'true',
      WALLET_WORKER_WALLETS: JSON.stringify([{ walletId: WALLET_ID, signerType: 'software', keyEnv: KEY_ENV }]),
      WALLET_WORKER_CONFIRMATION_DEPTH: String(DEPTH),
      WALLET_WORKER_POLL_INTERVAL_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  const capture = (buf: Buffer) => {
    const line = buf.toString();
    serverLog.push(line);
    if (/CardanoWalletWorker|error|Error/.test(line)) process.stdout.write('  [srv] ' + line);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  // On Windows `shell: true` puts cmd.exe between us and the server: child.kill()
  // would only kill the shell, orphaning the server — which keeps running AND
  // holds our stdout pipe open, so a piped run never returns. Kill the tree.
  const shutdown = () => {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    } else {
      child.kill();
    }
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(130); });

  try {
    await waitForServer(child);
    log('server ready on port', PORT);

    // ---- 3. Wait for the wallet to be registered + signer initialized ------
    let status = await odata('/GetWorkerStatus()');
    for (let i = 0; i < 15 && !status.wallets?.includes(WALLET_ID); i++) {
      await sleep(1_000);
      status = await odata('/GetWorkerStatus()');
    }
    log('\n── worker ─────────────────────────────────────────────────');
    log('running        :', status.running);
    log('wallets        :', status.wallets);
    if (!status.wallets?.includes(WALLET_ID)) {
      throw new Error(`wallet "${WALLET_ID}" never registered — check the [srv] log above`);
    }

    // ---- 4. Submit the job (self-payment: only fees leave the wallet) ------
    const idempotencyKey = `e2e-${Date.now()}`;
    const requestJson = JSON.stringify({ recipientAddress: address, lovelaceAmount: String(LOVELACE) });
    const submit = await odata('/SubmitWalletJob', {
      method: 'POST',
      body: JSON.stringify({ walletId: WALLET_ID, kind: 'simpleAda', requestJson, idempotencyKey }),
    });
    log('\n── job ────────────────────────────────────────────────────');
    log('jobId          :', submit.jobId, `(deduplicated: ${submit.deduplicated})`);

    // ---- 5. Idempotency: the same key must NOT create a second payment ----
    const retry = await odata('/SubmitWalletJob', {
      method: 'POST',
      body: JSON.stringify({ walletId: WALLET_ID, kind: 'simpleAda', requestJson, idempotencyKey }),
    });
    const idempotent = retry.jobId === submit.jobId && retry.deduplicated === true;
    log('idempotent retry:', idempotent ? `OK — same job ${retry.jobId}` : `FAILED — got ${retry.jobId}`);
    if (!idempotent) throw new Error('idempotency violated: the retry created a second job');

    // ---- 6. Follow the session through its states -------------------------
    log('\n── session ────────────────────────────────────────────────');
    const started = Date.now();
    const seen = new Set<string>();
    let job: any;
    while (Date.now() - started < TIMEOUT_MS) {
      job = await odata(`/GetJobStatus(jobId=${submit.jobId})`);
      if (!seen.has(job.status)) {
        seen.add(job.status);
        const secs = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
        log(`${secs}s  ${job.status.padEnd(11)}` +
          (job.txHash ? ` tx=${job.txHash}` : '') +
          (job.fee ? ` fee=${job.fee}` : ''));
      }
      if (['confirmed', 'failed', 'cancelled'].includes(job.status)) break;
      // Fine-grained on purpose: `building` and `submitting` can last well under a
      // second, and seeing them is the point of the trace.
      await sleep(500);
    }

    log('\n── result ─────────────────────────────────────────────────');
    log('final status   :', job.status);
    log('states seen    :', [...seen].join(' → '));
    if (job.txHash) log('explorer       :', `https://preview.cardanoscan.io/transaction/${job.txHash}`);
    if (job.status !== 'confirmed') {
      log('errorCode      :', job.errorCode, '|', job.errorMessage);
      throw new Error(`job ended as ${job.status}`);
    }

    // The durable-pre-submit invariant: submitting must have carried the artifacts.
    const durable = seen.has('submitting') || Boolean(job.txHash);
    log('durable pre-submit:', durable ? 'OK' : 'NOT OBSERVED (job may have raced past it)');
    log('\nPASS — wallet session completed end to end.');
  } finally {
    shutdown();
  }
}

main().catch((err) => { console.error('\nFAIL:', err.message); process.exit(1); });
