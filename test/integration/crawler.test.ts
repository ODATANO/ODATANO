/**
 * Integration tests for the chain crawler (v2.0) — real Ogmios, real SQLite.
 *
 * Read-only against the chain: the crawler ingests blocks, it never submits, so
 * this needs no funds. It covers what the unit suites cannot:
 *
 *  - **chain-sync really ingests** into the deployed schema, contiguously, with
 *    hashes that match the backend (the unit fake has no schema and no chain);
 *  - **recovery from a fork the crawler slept through** — the regression that
 *    used to kill the ingest pipeline with "No intersection found" and latch the
 *    cluster off. Unit tests cover the intersection ladder in isolation; only a
 *    real Ogmios proves the node answers it with a rollBackward.
 *
 * Self-skipping: CI runs the suite in two configurations (with and without a
 * synced node), so these tests stand down when Ogmios is unreachable or not at
 * the tip instead of failing the no-Ogmios lane.
 */

import cds from '@sap/cds';
// require() shares the native module graph with the booted CAP server
// (see signing-services.test.ts for the rationale).
const { createTestContext, resetAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
const { startCrawler, stopCrawler } =
  require('../../srv/blockchain/crawler') as typeof import('../../srv/blockchain/crawler');

const { SELECT, UPDATE, DELETE } = cds.ql;

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'ogmios,blockfrost';
process.env.OGMIOS_URL = process.env.OGMIOS_URL || 'ws://localhost:1337';

const BLOCKS = 20;                       // enough to prove contiguity, fast over chain-sync
const FORK = 3;                          // blocks to orphan in the recovery test
const NETWORK = process.env.NETWORK || 'preview';
const BF = `https://cardano-${NETWORK}.blockfrost.io/api/v0`;

type Ctx = { skip: () => void };

async function blockfrost(path: string): Promise<Record<string, any>> {
  const res = await fetch(`${BF}${path}`, { headers: { project_id: process.env.BLOCKFROST_API_KEY as string } });
  if (!res.ok) throw new Error(`blockfrost ${path} → ${res.status}`);
  return res.json() as Promise<Record<string, any>>;
}

/** Ogmios must be connected AND at the tip — a syncing node cannot serve a recent point. */
async function ogmiosReady(): Promise<boolean> {
  if (!process.env.BLOCKFROST_API_KEY) return false;
  const url = (process.env.OGMIOS_URL as string).replace(/^ws/, 'http') + '/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const h = await res.json() as { connectionStatus?: string; networkSynchronization?: number };
    return h.connectionStatus === 'connected' && (h.networkSynchronization ?? 0) > 0.99;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = async <T = Record<string, any>>(q: unknown): Promise<T[]> =>
  (await cds.tx((tx) => tx.run(q as never))) as T[];

describe('chain crawler (integration: real Ogmios + real SQLite)', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  let ready = false;
  let start: Record<string, any>;
  let target = 0;

  beforeAll(async () => {
    ready = await ogmiosReady();
    if (!ready) return;
    const ctx = await createTestContext(['ogmios', 'blockfrost']);
    resetAppContext(ctx);
    const tip = await blockfrost('/blocks/latest');
    start = await blockfrost(`/blocks/${tip.height - BLOCKS}`);
    target = tip.height;
  });

  afterEach(async () => {
    await stopCrawler();
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from('odatano.cardano.CardanoSyncState'));
      await tx.run(DELETE.from('odatano.cardano.CardanoReorgLog'));
    });
  });

  /** Boot the crawler over chain-sync from the shared start point. */
  async function crawl(): Promise<void> {
    const { getCardanoClient, getCardanoIndexer } = require('../../srv/server') as typeof import('../../srv/server');
    await startCrawler({
      client: getCardanoClient(),
      indexer: getCardanoIndexer(),
      network: NETWORK,
      config: {
        enabled: true,
        startSlot: start.slot,
        startBlockHash: start.hash,
        source: 'ogmios',
        batchSize: 20,
        confirmationDepth: 3,
        pollIntervalMs: 20000,
      },
    }, true);
  }

  /** Wait until the cursor reaches `height`, or give up. */
  async function waitForHeight(height: number, timeoutMs = 60_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < deadline) {
      const [cursor] = await rows(SELECT.from('odatano.cardano.CardanoSyncState'));
      last = Number(cursor?.lastHeight ?? 0);
      if (last >= height) return last;
      await sleep(500);
    }
    return last;
  }

  it('ingests a contiguous range over chain-sync that matches the chain', async (ctx: Ctx) => {
    if (!ready) return ctx.skip();

    await crawl();
    const reached = await waitForHeight(target);
    expect(reached, 'crawler did not reach the target tip').to.be.at.least(target);

    const blocks = await rows(
      SELECT.from('odatano.cardano.Blocks').columns('height', 'hash', 'slot').orderBy('height'),
    );
    const crawled = blocks.filter((b) => Number(b.height) > start.height);
    expect(crawled.length, 'expected the whole requested range').to.be.at.least(BLOCKS);

    // Contiguous: a gap means a lost block, which no row count would reveal.
    const heights = crawled.map((b) => Number(b.height));
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i], `gap after height ${heights[i - 1]}`).to.equal(heights[i - 1] + 1);
    }

    // And the data is right, not merely present.
    const sample = crawled[Math.floor(crawled.length / 2)];
    const ref = await blockfrost(`/blocks/${sample.height}`);
    expect(sample.hash).to.equal(ref.hash);
    expect(Number(sample.slot)).to.equal(Number(ref.slot));
  });

  it('recovers from a fork it slept through instead of dying on "No intersection found"', async (ctx: Ctx) => {
    if (!ready) return ctx.skip();

    await crawl();
    const reached = await waitForHeight(target);
    expect(reached).to.be.at.least(target);
    await stopCrawler();

    // Stage the fork exactly as an orphaned chain would leave it: the last few
    // crawled blocks carry hashes that are not on the canonical chain, and the
    // cursor points at that dead tip.
    const tail = (await rows(
      SELECT.from('odatano.cardano.Blocks').columns('height', 'hash').orderBy('height'),
    )).slice(-FORK);
    const forkHash = (real: string) => 'dead' + real.slice(4);
    await cds.tx(async (tx) => {
      for (const b of tail) {
        await tx.run(UPDATE.entity('odatano.cardano.Blocks')
          .set({ hash: forkHash(String(b.hash)) }).where({ height: b.height }));
      }
      await tx.run(UPDATE.entity('odatano.cardano.CardanoSyncState')
        .set({ lastBlockHash: forkHash(String(tail[tail.length - 1].hash)) }));
    });

    await crawl();

    // The ladder of ancestors lets the node intersect at the last common block and
    // report a rollBackward, which the reorg handling resolves.
    const deadline = Date.now() + 60_000;
    let reorgs: Record<string, any>[] = [];
    while (Date.now() < deadline) {
      reorgs = await rows(SELECT.from('odatano.cardano.CardanoReorgLog'));
      if (reorgs.length) break;
      await sleep(500);
    }
    expect(reorgs.length, 'the fork was never detected — the pipeline likely died').to.be.at.least(1);
    expect(Number(reorgs[0].blocksRolledBack)).to.be.at.least(1);

    // The synthetic blocks are gone and the canonical chain is back.
    const synthetic = await rows(
      SELECT.from('odatano.cardano.Blocks').columns('hash').where({ hash: { like: 'dead%' } }),
    );
    expect(synthetic, 'orphaned rows survived the rollback').to.have.length(0);

    const [cursor] = await rows(SELECT.from('odatano.cardano.CardanoSyncState'));
    expect(cursor.syncStatus, 'a recoverable fork must not latch the cluster off')
      .to.not.equal('error');
    expect(cursor.desiredRunning).to.not.equal(false);
  });

  it('exposes the cursor through CardanoIndexerService.getStatus()', async (ctx: Ctx) => {
    if (!ready) return ctx.skip();

    await crawl();
    await waitForHeight(start.height + 1, 30_000);

    const res = await test.get('/odata/v4/cardano-indexer/getStatus()', {
      auth: { username: 'alice', password: '' },
    });
    expect(res.data.running).to.equal(true);
    // CAP 10 serializes Int64/Decimal as strings — the contract consumers see.
    expect(res.data.lastHeight).to.be.a('string');
    expect(Number(res.data.lastHeight)).to.be.greaterThan(0);
  });
});
