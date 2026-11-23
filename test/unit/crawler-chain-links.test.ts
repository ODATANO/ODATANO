/**
 * Crawled chain on the real model (in-memory SQLite): blocks keep their parent hash and another
 * instance is served the stored one, a rollback removes the catalogue rows of units first seen
 * only in rolled-back inputs or burns, and a node behind the cursor turns local answers off.
 */
import cds from '@sap/cds';
import path from 'path';
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import { CardanoCrawler } from '../../srv/blockchain/crawler/crawler';
import {
  ensureSyncStateSingleton, advanceCursor, markNodeBehind, readCursor, setSyncStatus, tryAcquireCrawlerLease,
} from '../../srv/blockchain/crawler/sync-state';
import { readNextBlocks } from '../../srv/blockchain/stored-chain';
import { BARE_ASSET_STAMP } from '../../srv/utils/mappers';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const NS = 'odatano.cardano';
const REPO = path.resolve(__dirname, '../..');
const A = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const W = 'cd'.repeat(28) + '57';
const h = (c: string) => c.repeat(64);
const H0 = h('0');

type Deploy = { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } };

const block = (hash: string, slot: number, height: number, previousHash: string | null) => ({
  time: 1666656000 + slot, height, hash, slot, slotLeader: 'pool1x', epoch: 0, epochSlot: slot, size: 100, txCount: 0, fees: '0', previousHash,
});

let indexer: CardanoIndexer;
let crawler: CardanoCrawler;

async function persist(blk: ReturnType<typeof block>, txs: unknown[] = []): Promise<void> {
  await cds.tx(async (tx) => {
    await indexer.indexBlockFull(tx as never, { ...blk, txCount: txs.length } as never, txs as never);
    await advanceCursor(tx as never, { slot: blk.slot, hash: blk.hash, height: blk.height });
  });
  indexer.confirmBlockCommit();
}

beforeAll(async () => {
  const csn = await cds.load([path.resolve(REPO, 'db'), path.resolve(REPO, 'srv')]);
  cds.model = cds.linked(cds.compile.for.nodejs(csn as never) as never) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as Deploy).deploy(csn).to(db);
  const client = { network: 'preview', getEpoch: async () => { throw new Error('no epoch data'); } };
  indexer = new CardanoIndexer(client as never, {} as never);
  indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'bare', certificates: false, utxoSet: false });
  crawler = new CardanoCrawler(client as never, indexer, 'preview', {
    enabled: true, startSlot: 100, startBlockHash: H0, startHeight: 10, source: 'ogmios', batchSize: 1, confirmationDepth: 0,
    pollIntervalMs: 1000, assetHistory: true, assetCatalogue: 'bare', assetEnrichRate: 1, epochSnapshots: false,
  } as never);
});

beforeEach(async () => {
  await cds.tx(async (tx) => {
    for (const t of ['Blocks', 'Transactions', 'TransactionInputs', 'TransactionInputAssetCopies', 'TransactionOutputs',
      'TransactionOutputAssets', 'AssetHistory', 'Assets', 'CardanoSyncState']) await tx.run(DELETE.from(`${NS}.${t}`));
    await ensureSyncStateSingleton(tx as never, 'preview', { slot: 100, hash: H0, height: 10 });
    await tx.run(INSERT.into(`${NS}.Blocks`).entries({ hash: H0, slot: 100, height: 10, epochNumber: 0, txCount: 0 }));
  });
});

describe('parent hashes of stored blocks', () => {
  it('stores the parent a crawled block names and serves that one, never a made-up value', async () => {
    await persist(block(h('1'), 200, 11, H0));
    await persist(block(h('2'), 300, 12, h('1')));
    const stored = await cds.run(SELECT.from(`${NS}.Blocks`).columns('hash', 'previousHash').where({ height: { '>': 10 } }).orderBy('height')) as Array<{ hash: string; previousHash: string }>;
    expect(stored.map(b => b.previousHash)).toEqual([H0, h('1')]);

    const next = await readNextBlocks(cds.db as never, 10, 5, H0);
    expect(next.map(b => [b.hash, b.previousHash])).toEqual([[h('1'), H0], [h('2'), h('1')]]);
    // the anchor block has no stored parent
    expect((await readNextBlocks(cds.db as never, 9, 1, null))[0].previousHash).toBeNull();
  });

  it('of two blocks at one height serves the one on the stored chain', async () => {
    await persist(block(h('1'), 200, 11, H0));
    await persist(block(h('2'), 300, 12, h('1')));
    // an orphan at height 11, stored lazily from another fork
    await cds.run(INSERT.into(`${NS}.Blocks`).entries({ hash: h('9'), slot: 201, height: 11, epochNumber: 0, txCount: 0, previousHash: h('8') }));
    expect((await readNextBlocks(cds.db as never, 10, 5, H0)).map(b => b.hash)).toEqual([h('1'), h('2')]);

    // without parent hashes the block a stored successor names wins
    await cds.run(UPDATE.entity(`${NS}.Blocks`).set({ previousHash: null }).where({ hash: { in: [h('1'), h('9')] } }));
    expect((await readNextBlocks(cds.db as never, 10, 5, H0)).map(b => b.hash)).toEqual([h('1'), h('2')]);

    // nothing decides: refused with a clear reason instead of serving either
    await cds.run(UPDATE.entity(`${NS}.Blocks`).set({ previousHash: null }).where({ hash: h('2') }));
    await expect(readNextBlocks(cds.db as never, 10, 5, H0)).rejects.toThrow(/two stored blocks at height 11/);
  });
});

describe('rollback and the asset catalogue', () => {
  it('removes the catalogue row of a unit first seen in a rolled-back input that burnt it', async () => {
    const b1 = block(h('1'), 200, 11, H0);
    const burn = {
      hash: h('b'), blockHash: b1.hash, blockHeight: 11, slot: 200, index: 0, fee: '170000', deposit: '0', size: 300, blockTime: b1.time,
      inputs: [{ txHash: h('a'), outputIndex: 0, address: A, amount: [{ unit: 'lovelace', quantity: '3000000' }, { unit: W, quantity: '5' }], isCollateral: false, isReference: false }],
      outputs: [{ txHash: h('b'), outputIndex: 0, address: A, amount: [{ unit: 'lovelace', quantity: '2830000' }], dataHash: null, inlineDatum: null, isCollateral: false }],
      mint: [{ unit: W, quantity: '-5' }], certificates: [], withdrawals: [], redeemers: [], datums: [], metadata: [],
    };
    await persist(b1, [burn]);
    const seen = await cds.run(SELECT.from(`${NS}.Assets`).columns('unit', 'firstSeenSlot').where({ unit: W, validFrom: BARE_ASSET_STAMP })) as Array<{ firstSeenSlot: number }>;
    expect(seen.map(r => Number(r.firstSeenSlot))).toEqual([200]);

    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> }).handleReorg({ slot: 100, hash: H0, height: 10 });

    expect(await cds.run(SELECT.from(`${NS}.Assets`).where({ unit: W }))).toEqual([]);
  });
});

describe('node behind the cursor', () => {
  it('marks the crawl syncing and keeps the crawled chain from answering alone', async () => {
    await cds.tx(async (tx) => {
      await tryAcquireCrawlerLease(tx as never, 'me');
      await setSyncStatus(tx as never, 'synced');
    });
    const coverage = () => cds.tx((tx) => (indexer as unknown as { localCoverage: (t: unknown) => Promise<unknown> }).localCoverage(tx));
    expect(await coverage()).not.toBeNull();

    await cds.tx((tx) => markNodeBehind(tx as never, 'node tip below the cursor'));

    const cursor = await readCursor(cds.db as never);
    expect(cursor).toMatchObject({ syncStatus: 'syncing' });
    expect(cursor!.nodeBehindSince).not.toBeNull();
    await cds.tx((tx) => setSyncStatus(tx as never, 'synced'));
    expect(await coverage()).toBeNull();
  });
});
