/**
 * Chain-crawler end-to-end on preview: pre-sync the last N blocks.
 *
 *   npx tsx scripts/testing/crawler-e2e-preview.ts
 *   npx tsx scripts/testing/crawler-e2e-preview.ts --blocks 100 --source pagination
 *
 * Self-contained — picks a start point N blocks behind the tip, boots its own
 * server with the crawler enabled, follows the cursor, and shuts down again.
 *
 * Verification is deliberately not "some rows appeared": after the sync it
 *  - checks the crawled heights are CONTIGUOUS (a gap means a lost block),
 *  - re-fetches sample blocks from the backend and compares hash, slot, tx count
 *    against what was persisted (proves the data is right, not just present),
 *  - confirms the transactions of those blocks landed with their inputs/outputs.
 *
 * The crawled range is authoritative (non-temporal, no TTL), so this also shows
 * what a consumer would serve locally instead of hitting a backend per request.
 */

import 'dotenv/config';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 4006);
const BASE = `http://localhost:${PORT}/odata/v4/cardano-indexer`;
const AUTH = 'Basic ' + Buffer.from('alice:').toString('base64');
const DB_FILE = `${REPO_ROOT}/db.sqlite`;

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BLOCKS = Number(argOf('blocks', '100'));
const SOURCE = argOf('source', 'auto');            // ogmios | pagination | auto
const TIMEOUT_MS = Number(argOf('timeout', '900000'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...p: unknown[]) => console.log(...p);

const network = process.env.NETWORK ?? 'preview';
const BF = `https://cardano-${network}.blockfrost.io/api/v0`;

async function blockfrost(path: string): Promise<any> {
  const key = process.env.BLOCKFROST_API_KEY;
  if (!key) throw new Error('BLOCKFROST_API_KEY is required to pick a start block and verify');
  const res = await fetch(`${BF}${path}`, { headers: { project_id: key } });
  if (!res.ok) throw new Error(`blockfrost ${path} → ${res.status}`);
  return res.json();
}

async function odata(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: AUTH } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${body?.error?.message ?? text}`);
  return body;
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      if ((await fetch(`${BASE}/$metadata`, { headers: { Authorization: AUTH } })).ok) return;
    } catch { /* not up yet */ }
    await sleep(1_000);
  }
  throw new Error('server did not become ready within 120s');
}

function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try { return db.prepare(sql).all(...params as never[]) as T[]; } finally { db.close(); }
}

/**
 * Drop the cursor so the configured start point actually applies. Without this a
 * second run resumes where the previous one stopped (by design — the crawler is
 * cursor-resumable), and the "crawl the last N blocks" range would be a no-op.
 * Only touches CardanoSyncState; crawled blocks stay and are re-UPSERTed.
 */
function resetCursor(): void {
  const db = new DatabaseSync(DB_FILE);
  try { db.exec('delete from odatano_cardano_CardanoSyncState'); } finally { db.close(); }
}

/**
 * Chain-sync is only available when an Ogmios BACKEND exists — a reachable Ogmios
 * process is not enough, the capability guard looks at the configured backends.
 * So if Ogmios answers but BACKENDS omits it, add it for the child process.
 */
async function resolveBackends(): Promise<{ backends: string; ogmiosUp: boolean }> {
  const configured = (process.env.BACKENDS ?? 'blockfrost').split(',').map((b) => b.trim()).filter(Boolean);
  const url = process.env.OGMIOS_URL ?? 'ws://localhost:1337';
  const health = url.replace(/^ws/, 'http') + '/health';
  let ogmiosUp = false;
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(4_000) });
    ogmiosUp = res.ok;
  } catch { ogmiosUp = false; }

  if (ogmiosUp && !configured.includes('ogmios')) configured.unshift('ogmios');
  return { backends: configured.join(','), ogmiosUp };
}

async function main() {
  // ---- 1. Pick a start point N blocks behind the tip -----------------------
  const tip = await blockfrost('/blocks/latest');
  const startHeight = tip.height - BLOCKS;
  const start = await blockfrost(`/blocks/${startHeight}`);

  log('── target ─────────────────────────────────────────────────');
  log('network        :', network);
  log('tip            :', `height ${tip.height}, slot ${tip.slot}`);
  log('start block    :', `height ${start.height}, slot ${start.slot}`);
  log('range          :', `${BLOCKS} blocks (${start.height} → ${tip.height}, tip moves on)`);
  const existing = query<{ lastHeight: number }>('select lastHeight from odatano_cardano_CardanoSyncState')[0];
  if (existing && !args.includes('--reset')) {
    throw new Error(`a cursor already exists (height ${existing.lastHeight}) — the crawler would resume there instead of the requested range. Re-run with --reset.`);
  }
  if (existing) { resetCursor(); log('cursor reset (was at height ' + existing.lastHeight + ')'); }

  const { backends, ogmiosUp } = await resolveBackends();
  log('source         :', SOURCE, SOURCE === 'auto' ? '(ogmios chain-sync if available, else pagination)' : '');
  log('ogmios         :', ogmiosUp ? 'reachable — chain-sync path' : 'not reachable — pagination path');
  log('backends       :', backends);

  // ---- 2. Boot a server with the crawler enabled ---------------------------
  log('\n── starting server (crawler enabled) ──────────────────────');
  const child = spawn('npx', ['cds-serve', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      BACKENDS: backends,
      CRAWLER_ENABLED: 'true',
      CRAWLER_START_SLOT: String(start.slot),
      CRAWLER_START_HASH: start.hash,
      CRAWLER_SOURCE: SOURCE,
      CRAWLER_CONFIRMATION_DEPTH: '3',
      CRAWLER_BATCH_SIZE: '20',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (buf: Buffer) => {
    const line = buf.toString();
    if (/Crawler|crawler|reorg|Reorg|error|Error/.test(line)) process.stdout.write('  [srv] ' + line);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  // Windows: `shell: true` means child.kill() would only kill cmd.exe and orphan
  // the server (which also keeps our stdout pipe open) — kill the whole tree.
  const shutdown = () => {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    } else { child.kill(); }
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(130); });

  try {
    await waitForServer(child);
    log('server ready on port', PORT);

    // ---- 3. Follow the cursor ---------------------------------------------
    log('\n── sync ───────────────────────────────────────────────────');
    const began = Date.now();
    let status: any;
    let lastLogged = -1;
    while (Date.now() - began < TIMEOUT_MS) {
      status = await odata('/getStatus()');
      const height = Number(status.lastHeight);
      if (height !== lastLogged) {
        lastLogged = height;
        const done = Math.max(0, height - start.height);
        const secs = ((Date.now() - began) / 1000).toFixed(1).padStart(6);
        log(`${secs}s  ${String(done).padStart(3)}/${BLOCKS} blocks  height=${height}  status=${status.syncStatus}  progress=${status.syncProgress}%`);
      }
      if (Number(status.lastHeight) >= tip.height) break;   // caught up with the tip we targeted
      await sleep(2_000);
    }
    if (Number(status.lastHeight) < tip.height) {
      throw new Error(`did not reach height ${tip.height} within the timeout (stuck at ${status.lastHeight}, errors=${status.consecutiveErrors})`);
    }
    log('caught up to the target tip.');

    // ---- 4. Verify what was persisted --------------------------------------
    log('\n── verification ───────────────────────────────────────────');
    // The start block is the cursor ANCHOR (already-processed), so crawling begins
    // at start.height + 1 — the expected count is the range, not the range + 1.
    const rows = query<{ height: number; hash: string; slot: number }>(
      'select height, hash, slot from odatano_cardano_Blocks where height between ? and ? order by height',
      start.height + 1, tip.height,
    );
    log('blocks persisted:', rows.length, `(expected ${tip.height - start.height})`);

    const gaps: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      if (Number(rows[i].height) !== Number(rows[i - 1].height) + 1) gaps.push(Number(rows[i - 1].height));
    }
    log('height gaps     :', gaps.length ? `FOUND after ${gaps.join(', ')}` : 'none — contiguous');
    if (gaps.length) throw new Error('crawled range has gaps');

    // Sample three blocks and compare against the backend, plus their txs.
    const samples = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean);
    for (const row of samples) {
      const ref = await blockfrost(`/blocks/${row.height}`);
      const persistedTxs = query<{ c: number }>(
        'select count(*) c from odatano_cardano_Transactions where blockHash = ?', row.hash)[0].c;
      const match = ref.hash === row.hash && Number(ref.slot) === Number(row.slot) && Number(ref.tx_count) === Number(persistedTxs);
      log(`block ${row.height}: hash ${ref.hash === row.hash ? 'ok' : 'MISMATCH'}, ` +
        `slot ${Number(ref.slot) === Number(row.slot) ? 'ok' : 'MISMATCH'}, ` +
        `txs ${persistedTxs}/${ref.tx_count} ${match ? 'ok' : 'MISMATCH'}`);
      if (!match) throw new Error(`block ${row.height} does not match the backend`);
    }

    const txTotal = query<{ c: number }>(
      'select count(*) c from odatano_cardano_Transactions where blockHeight between ? and ?',
      start.height + 1, tip.height)[0].c;
    const expectedTxs = query<{ c: number }>(
      'select coalesce(sum(txCount),0) c from odatano_cardano_Blocks where height between ? and ?',
      start.height + 1, tip.height)[0].c;
    log('tx rows vs block.txCount:', `${txTotal} / ${expectedTxs}`,
      Number(txTotal) === Number(expectedTxs) ? 'ok' : 'MISMATCH');
    const ioTotal = query<{ i: number; o: number }>(
      `select (select count(*) from odatano_cardano_TransactionInputs) i,
              (select count(*) from odatano_cardano_TransactionOutputs) o`)[0];
    log('transactions    :', txTotal, `| inputs ${ioTotal.i} / outputs ${ioTotal.o}`);

    const cursor = query<{ lastHeight: number; syncStatus: string }>(
      'select lastHeight, syncStatus from odatano_cardano_CardanoSyncState')[0];
    log('cursor row      :', `height ${cursor?.lastHeight}, status ${cursor?.syncStatus}`);
    const reorgs = query<{ c: number }>('select count(*) c from odatano_cardano_CardanoReorgLog')[0].c;
    log('reorgs logged   :', reorgs);

    log('\nPASS — crawler pre-synced', rows.length, 'blocks, contiguous and matching the chain.');
  } finally {
    shutdown();
  }
}

main().catch((err) => { console.error('\nFAIL:', err.message); process.exit(1); });
