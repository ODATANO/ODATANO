/**
 * Crawled epochs turn final: once the crawl has written a block of a later epoch, the ended epoch's
 * row is final, also after a restart. The epoch the crawl is in stays open. Real model, in-memory SQLite.
 */
import cds from '@sap/cds';
import path from 'path';
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import { CardanoCrawler } from '../../srv/blockchain/crawler/crawler';
import { ensureSyncStateSingleton } from '../../srv/blockchain/crawler/sync-state';
import { epochStartSlot, slotToPosixSeconds } from '../../srv/utils/epoch-slots';

const { SELECT, INSERT, DELETE } = cds.ql;
const NS = 'odatano.cardano';
const REPO = path.resolve(__dirname, '../..');
const START = 'a'.repeat(64);
const DAY = 86_400;

type Persist = { running: boolean; persistBlock: (b: unknown, t: unknown[], tip?: unknown) => Promise<boolean> };
type Deploy = { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } };

/** A backend that knows the slot bounds of every epoch, or none (Ogmios cannot answer for past epochs). */
function client(answers: boolean) {
  const network = 'preview' as const;
  return {
    network,
    getEpoch: async (epoch: number) => {
      if (!answers) throw new Error('no epoch data');
      return {
        epoch,
        start_time: slotToPosixSeconds(network, epochStartSlot(network, epoch)),
        end_time: slotToPosixSeconds(network, epochStartSlot(network, epoch + 1)),
        first_block_time: null, last_block_time: null, block_count: 0, tx_count: 0, output: null, fees: null, active_stake: null,
      };
    },
  };
}

function crawlerWith(answers: boolean): Persist {
  const c = client(answers);
  const indexer = new CardanoIndexer(c as never, {} as never);
  indexer.configureCrawlCoverage({ assetHistory: true, assetCatalogue: 'bare', certificates: false, utxoSet: false });
  const crawler = new CardanoCrawler(c as never, indexer, 'preview', {
    enabled: true, startSlot: DAY + 100, startBlockHash: START, startHeight: 10, source: 'ogmios', batchSize: 1,
    confirmationDepth: 0, pollIntervalMs: 1000, assetHistory: true, assetCatalogue: 'bare', assetEnrichRate: 1, epochSnapshots: false,
  } as never) as unknown as Persist;
  crawler.running = true;
  return crawler;
}

let height = 10;
let previous = START;
async function crawl(crawler: Persist, slots: number[]): Promise<void> {
  const tip = { slot: DAY * 400, hash: 'f'.repeat(64), height: 1_000_000 };
  for (const slot of slots) {
    height++;
    const hash = height.toString(16).padStart(64, '0');
    const block = {
      time: slotToPosixSeconds('preview', slot), height, hash, slot, slotLeader: 'pool1x', epoch: Math.floor(slot / DAY),
      epochSlot: slot % DAY, size: 100, txCount: 0, fees: '0', previousHash: previous,
    };
    expect(await crawler.persistBlock(block, [], tip)).toBe(true);
    previous = hash;
  }
}

/** Final flags of the epochs the crawl covers; epoch 1 began before the crawl's start block. */
async function finals(): Promise<Record<number, boolean | null>> {
  const rows = await cds.run(SELECT.from(`${NS}.Epochs`).columns('epoch', 'final').where({ epoch: { '>=': 2 } })) as Array<{ epoch: number; final: boolean | null }>;
  return Object.fromEntries(rows.map((r) => [Number(r.epoch), r.final == null ? null : Boolean(r.final)]));
}

beforeAll(async () => {
  const csn = await cds.load([path.resolve(REPO, 'db'), path.resolve(REPO, 'srv')]);
  cds.model = cds.linked(cds.compile.for.nodejs(csn as never) as never) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as Deploy).deploy(csn).to(db);
});

beforeEach(async () => {
  await cds.tx(async (tx) => {
    for (const t of ['Epochs', 'Blocks', 'CardanoSyncState']) await tx.run(DELETE.from(`${NS}.${t}`));
    await ensureSyncStateSingleton(tx as never, 'preview', { slot: DAY + 100, hash: START, height: 10 });
    await tx.run(INSERT.into(`${NS}.Blocks`).entries({ hash: START, slot: DAY + 100, height: 10, epochNumber: 1, txCount: 0 }));
  });
  height = 10;
  previous = START;
});

describe.each([true, false])('crawled epochs turn final (backend answers epochs: %s)', (answers) => {
  it('marks every ended epoch final once the crawl has passed it; the current one stays open', async () => {
    await crawl(crawlerWith(answers), [DAY * 2 + 10, DAY * 2 + 500, DAY * 3 + 10, DAY * 3 + 900, DAY * 4 + 5, DAY * 5 + 5]);
    expect(await finals()).toEqual({ 2: true, 3: true, 4: true, 5: false });
  });

  it('completes the epoch before the restart point on the first block after a restart', async () => {
    await crawl(crawlerWith(answers), [DAY * 2 + 10, DAY * 3 + 10]);
    expect((await finals())[3]).toBe(false);
    await crawl(crawlerWith(answers), [DAY * 4 + 10]);
    expect(await finals()).toEqual({ 2: true, 3: true, 4: false });
  });
});
