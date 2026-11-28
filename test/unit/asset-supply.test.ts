/**
 * Supply sums per unit (srv/blockchain/asset-supply.ts) on the real model in an in-memory SQLite:
 * the first computation, block by block counting under the height, and a rollback.
 */
import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import path from 'path';
import {
  applyBlockAssetSupply, assetSupplyHeight, computeAssetSupply, lowerAssetSupplyHeight, readAssetSupply, undoAssetSupply,
} from '../../srv/blockchain/asset-supply';

const { SELECT, INSERT, DELETE, UPSERT } = cds.ql;
const HISTORY = 'odatano.cardano.AssetHistory';
const SUPPLY = 'odatano.cardano.AssetSupply';
const STATE = 'odatano.cardano.CardanoSyncState';
const A = `${'a'.repeat(56)}746f6b656e`;
const B = `${'b'.repeat(56)}74`;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const row = (unit: string, n: number, action: 'mint' | 'burn', quantity: string, blockHeight: number | null) =>
  ({ unit, txHash: hash(n), action, quantity, blockTime: 1, blockHeight });

const db = () => cds.db as unknown as CapTransaction;
const sums = async (unit: string) => {
  const r = await readAssetSupply(db(), unit);
  return r ? { totalSupply: String(r.totalSupply), mintOrBurnCount: Number(r.mintOrBurnCount) } : undefined;
};
// writes the rows and counts them, as the crawler does for one block
const crawl = async (height: number, rows: ReturnType<typeof row>[]) => {
  await cds.run(UPSERT.into(HISTORY).entries(rows));
  await applyBlockAssetSupply(db(), rows, height);
};

beforeAll(async () => {
  const csn = await cds.load(path.resolve(__dirname, '../../db'));
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  const conn = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  // cds.deploy is not part of the published typings
  await (cds as unknown as { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } }).deploy(csn).to(conn);
});

beforeEach(async () => {
  for (const e of [HISTORY, SUPPLY, STATE]) await cds.run(DELETE.from(e));
  await cds.run(INSERT.into(STATE).entries({ ID: 'SINGLETON', network: 'preview', lastSlot: 0, lastHeight: 0 }));
});

describe('computeAssetSupply', () => {
  it('sums the stored rows up to the height and sets it', async () => {
    await cds.run(INSERT.into(HISTORY).entries([
      row(A, 1, 'mint', '100', 10), row(A, 2, 'burn', '30', 20), row(A, 3, 'mint', '9007199254740000', 25),
      row(B, 4, 'mint', '7', 30),
      row(A, 5, 'mint', '1000', 40), // above the height: the crawler counts it when it gets there
      row(A, 6, 'mint', '1', null), // no height: never counted
    ]));

    await computeAssetSupply(db(), 30);

    expect(await assetSupplyHeight(db())).toBe(30);
    expect(await sums(A)).toEqual({ totalSupply: '9007199254740070', mintOrBurnCount: 3 });
    expect(await sums(B)).toEqual({ totalSupply: '7', mintOrBurnCount: 1 });
  });

  it('replaces sums left from an earlier computation', async () => {
    await cds.run(INSERT.into(SUPPLY).entries({ unit: A, totalSupply: '999', mintOrBurnCount: 9 }));
    await computeAssetSupply(db(), 30);
    expect(await sums(A)).toBeUndefined();
  });
});

describe('applyBlockAssetSupply', () => {
  it('counts nothing before the sums are computed', async () => {
    await crawl(10, [row(A, 1, 'mint', '100', 10)]);
    expect(await assetSupplyHeight(db())).toBeNull();
    expect(await sums(A)).toBeUndefined();
  });

  it('counts each crawled block once and moves the height', async () => {
    await computeAssetSupply(db(), 0);
    await crawl(10, [row(A, 1, 'mint', '100', 10), row(B, 2, 'mint', '5', 10)]);
    await crawl(20, [row(A, 3, 'burn', '40', 20)]);
    expect(await sums(A)).toEqual({ totalSupply: '60', mintOrBurnCount: 2 });
    expect(await assetSupplyHeight(db())).toBe(20);

    // the same blocks crawled again after a cursor reset
    await crawl(10, [row(A, 1, 'mint', '100', 10), row(B, 2, 'mint', '5', 10)]);
    await crawl(20, [row(A, 3, 'burn', '40', 20)]);
    expect(await sums(A)).toEqual({ totalSupply: '60', mintOrBurnCount: 2 });
    expect(await sums(B)).toEqual({ totalSupply: '5', mintOrBurnCount: 1 });
  });

  it('counts a row the lazy path stored ahead of the crawler when the crawler reaches its block', async () => {
    await computeAssetSupply(db(), 0);
    await cds.run(INSERT.into(HISTORY).entries(row(A, 1, 'mint', '100', 10)));
    await crawl(10, [row(A, 1, 'mint', '100', 10)]);
    expect(await sums(A)).toEqual({ totalSupply: '100', mintOrBurnCount: 1 });
  });
});

describe('rollback', () => {
  it('takes the rolled-back rows off and counts the new chain', async () => {
    await computeAssetSupply(db(), 0);
    await crawl(10, [row(A, 1, 'mint', '100', 10)]);
    await crawl(20, [row(A, 2, 'mint', '50', 20), row(B, 3, 'mint', '5', 20)]);

    await undoAssetSupply(db(), [hash(2), hash(3)]);
    await cds.run(DELETE.from(HISTORY).where({ txHash: { in: [hash(2), hash(3)] } }));
    await lowerAssetSupplyHeight(db(), 10);

    expect(await sums(A)).toEqual({ totalSupply: '100', mintOrBurnCount: 1 });
    expect(await sums(B)).toBeUndefined(); // no counted row left
    expect(await assetSupplyHeight(db())).toBe(10);

    await crawl(20, [row(A, 4, 'burn', '10', 20)]);
    expect(await sums(A)).toEqual({ totalSupply: '90', mintOrBurnCount: 2 });
  });

  it('leaves rows above the height alone, they were never counted', async () => {
    await computeAssetSupply(db(), 10);
    await cds.run(INSERT.into(HISTORY).entries(row(A, 1, 'mint', '100', 20)));
    await undoAssetSupply(db(), [hash(1)]);
    expect(await sums(A)).toBeUndefined();
    expect(await cds.run(SELECT.from(SUPPLY))).toEqual([]);
  });

  it('never raises the height, and clears it when the fork height is unknown', async () => {
    await computeAssetSupply(db(), 10);
    await lowerAssetSupplyHeight(db(), 50);
    expect(await assetSupplyHeight(db())).toBe(10);
    await lowerAssetSupplyHeight(db(), null);
    expect(await assetSupplyHeight(db())).toBeNull();
  });
});
