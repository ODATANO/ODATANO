/**
 * Chain-crawler reorg recovery on preview.
 *
 *   npx tsx scripts/testing/crawler-reorg-preview.ts
 *   npx tsx scripts/testing/crawler-reorg-preview.ts --blocks 30 --fork 5
 *
 * A public testnet cannot be told to roll back, so the fork is staged in the
 * crawler's own state — which is exactly what an orphaned fork leaves behind:
 * the last K crawled blocks carry hashes that are not on the canonical chain,
 * and the cursor points at that dead tip. The crawler cannot tell this apart
 * from having followed a fork that lost.
 *
 * Sequence:
 *   1. crawl N blocks normally and remember the real hashes of the last K
 *   2. rewrite those K blocks + the cursor to synthetic hashes  (the "fork")
 *   3. restart the crawler and watch it recover
 *
 * What must happen (asserted):
 *   - the backend rejects the dead cursor (CHAIN_POINT_MISMATCH) and the crawler
 *     walks back to the last common block instead of erroring out
 *   - a CardanoReorgLog row records the fork slot/height and the rollback size
 *   - the orphaned rows are gone and the real chain is re-indexed in their place
 *   - the range is contiguous again and the cursor moves past the fork
 */

import 'dotenv/config';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 4007);
const BASE = `http://localhost:${PORT}/odata/v4/cardano-indexer`;
const AUTH = 'Basic ' + Buffer.from('alice:').toString('base64');
const DB_FILE = `${REPO_ROOT}/db.sqlite`;

const args = process.argv.slice(2);
const argOf = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BLOCKS = Number(argOf('blocks', '30'));
const FORK = Number(argOf('fork', '5'));
const SOURCE = argOf('source', 'pagination');   // pagination | ogmios
const network = process.env.NETWORK ?? 'preview';
const BF = `https://cardano-${network}.blockfrost.io/api/v0`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...p: unknown[]) => console.log(...p);

async function blockfrost(path: string): Promise<any> {
  const key = process.env.BLOCKFROST_API_KEY;
  if (!key) throw new Error('BLOCKFROST_API_KEY required');
  const res = await fetch(`${BF}${path}`, { headers: { project_id: key } });
  if (!res.ok) throw new Error(`blockfrost ${path} → ${res.status}`);
  return res.json();
}

async function odata(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: AUTH } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(body as any)?.error?.message}`);
  return body;
}

function query<T = Record<string, any>>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try { return db.prepare(sql).all(...params as never[]) as T[]; } finally { db.close(); }
}
function mutate(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(DB_FILE);
  try { fn(db); } finally { db.close(); }
}

/** Obviously synthetic, but structurally a valid block hash. */
const forkHash = (real: string) => 'dead' + real.slice(4);

function startServer(source: string, backends: string, start: { slot: number; hash: string }): ChildProcess {
  return spawn('npx', ['cds-serve', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      BACKENDS: backends,
      CRAWLER_ENABLED: 'true',
      CRAWLER_SOURCE: source,
      CRAWLER_START_SLOT: String(start.slot),
      CRAWLER_START_HASH: start.hash,
      CRAWLER_CONFIRMATION_DEPTH: '3',
      CRAWLER_BATCH_SIZE: '20',
      CRAWLER_POLL_INTERVAL_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else { child.kill(); }
}

function pipeLogs(child: ChildProcess): void {
  const capture = (b: Buffer) => {
    const line = b.toString();
    if (/Crawler|crawler|[Rr]eorg|MISMATCH|error/.test(line)) process.stdout.write('  [srv] ' + line);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
}

async function waitReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (code ${child.exitCode})`);
    try { if ((await fetch(`${BASE}/$metadata`, { headers: { Authorization: AUTH } })).ok) return; } catch { /* wait */ }
    await sleep(1_000);
  }
  throw new Error('server not ready');
}

async function main() {
  const configured = (process.env.BACKENDS ?? 'blockfrost').split(',').map(b => b.trim()).filter(Boolean);
  if (SOURCE === 'ogmios' && !configured.includes('ogmios')) configured.unshift('ogmios');
  const BACKENDS = configured.join(',');
  log('source         :', SOURCE, '| backends:', BACKENDS);

  // ---- 1. Crawl a clean baseline ------------------------------------------
  const tip = await blockfrost('/blocks/latest');
  const start = await blockfrost(`/blocks/${tip.height - BLOCKS}`);
  mutate((db) => db.exec('delete from odatano_cardano_CardanoSyncState'));

  log('── baseline crawl ─────────────────────────────────────────');
  log(`range          : ${start.height + 1} → ${tip.height} (${BLOCKS} blocks)`);

  let child = startServer(SOURCE, BACKENDS, start);
  pipeLogs(child);
  try {
    await waitReady(child);
    const deadline = Date.now() + 900_000;
    let status: any;
    while (Date.now() < deadline) {
      status = await odata('/getStatus()');
      if (Number(status.lastHeight) >= tip.height) break;
      await sleep(2_000);
    }
    if (Number(status.lastHeight) < tip.height) throw new Error(`baseline crawl stalled at ${status.lastHeight}`);
    log('crawled to     :', status.lastHeight);
  } finally { killTree(child); }
  await sleep(2_000); // let the file lock go

  // ---- 2. Stage the fork ---------------------------------------------------
  // Anchor on what was ACTUALLY crawled: the chain keeps moving during the
  // baseline, so the crawler usually ends a few blocks past the sampled tip.
  const crawledTip = Number(query<{ h: number }>('select max(height) h from odatano_cardano_Blocks')[0].h);
  const doomed = query<{ height: number; hash: string; slot: number }>(
    'select height, hash, slot from odatano_cardano_Blocks where height > ? order by height',
    crawledTip - FORK,
  );
  if (doomed.length !== FORK) throw new Error(`expected ${FORK} blocks to fork off, found ${doomed.length}`);
  const forkPoint = query<{ height: number; hash: string; slot: number }>(
    'select height, hash, slot from odatano_cardano_Blocks where height = ?', crawledTip - FORK)[0];

  log('\n── staging the fork ───────────────────────────────────────');
  log('fork point     :', `height ${forkPoint.height}, slot ${forkPoint.slot} (last common block)`);
  log('orphaning      :', doomed.map((b) => b.height).join(', '));

  mutate((db) => {
    for (const b of doomed) {
      db.prepare('update odatano_cardano_Blocks set hash = ? where height = ?').run(forkHash(b.hash), b.height);
    }
    const tipRow = doomed[doomed.length - 1];
    db.prepare('update odatano_cardano_CardanoSyncState set lastBlockHash = ?').run(forkHash(tipRow.hash));
  });
  const before = query<{ c: number }>('select count(*) c from odatano_cardano_CardanoReorgLog')[0].c;
  log('reorg log rows :', before, '(before)');

  // ---- 3. Restart and let it recover --------------------------------------
  log('\n── recovery ───────────────────────────────────────────────');
  child = startServer(SOURCE, BACKENDS, start);
  pipeLogs(child);
  try {
    await waitReady(child);
    const began = Date.now();
    let logged = before;
    while (Date.now() - began < 600_000) {
      logged = query<{ c: number }>('select count(*) c from odatano_cardano_CardanoReorgLog')[0].c;
      if (logged > before) break;
      await sleep(2_000);
    }
    if (logged === before) throw new Error('no reorg was recorded — the crawler did not detect the fork');
    const secs = ((Date.now() - began) / 1000).toFixed(1);
    log(`reorg detected after ${secs}s`);

    // let it re-crawl the real chain over the rolled-back range
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const s = await odata('/getStatus()');
      if (Number(s.lastHeight) >= crawledTip) break;
      await sleep(2_000);
    }
  } finally { killTree(child); }
  await sleep(2_000);

  // ---- 4. Verify -----------------------------------------------------------
  log('\n── verification ───────────────────────────────────────────');
  const entry = query<any>('select * from odatano_cardano_CardanoReorgLog order by detectedAt desc')[0];
  log('reorg row      :', `forkSlot=${entry.forkSlot} forkHeight=${entry.forkHeight} rolledBack=${entry.blocksRolledBack} status=${entry.status}`);
  if (Number(entry.forkHeight) !== Number(forkPoint.height)) {
    throw new Error(`fork height ${entry.forkHeight} != expected ${forkPoint.height}`);
  }
  if (Number(entry.blocksRolledBack) !== FORK) {
    throw new Error(`rolled back ${entry.blocksRolledBack} blocks, expected ${FORK}`);
  }

  const synthetic = query<{ c: number }>(
    "select count(*) c from odatano_cardano_Blocks where hash like 'dead%'")[0].c;
  log('orphan rows left:', synthetic, synthetic === 0 ? 'ok — all removed' : 'FAIL');
  if (synthetic !== 0) throw new Error('synthetic fork blocks survived the rollback');

  let restored = 0;
  for (const b of doomed) {
    const now = query<{ hash: string }>('select hash from odatano_cardano_Blocks where height = ?', b.height)[0];
    if (now?.hash === b.hash) restored++;
  }
  log('re-indexed      :', `${restored}/${FORK} heights carry the canonical hash again`);
  if (restored !== FORK) throw new Error('the canonical chain was not fully re-indexed');

  const rows = query<{ height: number }>(
    'select height from odatano_cardano_Blocks where height between ? and ? order by height',
    start.height + 1, crawledTip);
  const gaps = rows.filter((r, i) => i > 0 && Number(r.height) !== Number(rows[i - 1].height) + 1);
  log('contiguity      :', gaps.length ? 'GAPS' : 'ok');
  if (gaps.length) throw new Error('range has gaps after recovery');

  log('\nPASS — fork detected, rolled back, audited and re-indexed.');
}

main().catch((err) => { console.error('\nFAIL:', err.message); process.exit(1); });
