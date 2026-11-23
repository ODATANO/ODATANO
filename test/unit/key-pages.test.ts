/**
 * Keyset paging over a two-column key: a first key stays on one page unless it fills a page,
 * then the walk goes on inside it by the second key. Runs on CAP's in-memory SQLite.
 */
import cds from '@sap/cds';
import { pageByKey } from '../../srv/blockchain/crawler/key-pages';

/** cds.deploy is not part of the published typings. */
type Deploy = { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } };

let db: cds.DatabaseService;
beforeAll(async () => {
  const csn = cds.parse.cdl('entity Rows { key seq : Integer64; key idx : Integer; v : String; }');
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } }) as cds.DatabaseService;
  await (cds as unknown as Deploy).deploy(csn).to(db);
});

async function fill(rows: Array<[number, number]>) {
  await db.run(cds.ql.DELETE.from('Rows'));
  if (rows.length) await db.run(cds.ql.INSERT.into('Rows').entries(rows.map(([seq, idx]) => ({ seq, idx, v: `${seq}.${idx}` }))));
}

async function walk(chunkSize: number, shouldStop?: () => boolean) {
  const pages: string[][] = [];
  const finished = await pageByKey<{ seq: number; idx: number; v: string }>(
    { entity: 'Rows', keys: ['seq', 'idx'], columns: ['v'], chunkSize, shouldStop },
    async (rows) => { pages.push(rows.map((r) => r.v)); },
  );
  return { pages, finished };
}

describe('pageByKey', () => {
  it('lets the event loop run between pages, so a request or a cancel is served mid-walk', async () => {
    await fill(Array.from({ length: 30 }, (_, i) => [i, 0] as [number, number]));
    let stop = false;
    // a macrotask, like an incoming request: it runs only if the walk yields to the event loop
    setImmediate(() => { stop = true; });
    const { pages, finished } = await walk(2, () => stop);
    expect(finished).toBe(false);
    expect(pages.length).toBeLessThan(15);
  });

  it('keeps the rows of one first key on one page', async () => {
    await fill([[1, 0], [1, 1], [2, 0], [2, 1], [2, 2], [3, 0]]);
    const { pages, finished } = await walk(4);
    expect(finished).toBe(true);
    expect(pages).toEqual([['1.0', '1.1'], ['2.0', '2.1', '2.2'], ['3.0']]);
  });

  it('walks on inside a first key that holds more rows than a page, without skipping any', async () => {
    await fill([[1, 0], [5, 0], [5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [5, 6], [7, 0]]);
    const { pages } = await walk(3);
    expect(pages.flat()).toEqual(['1.0', '5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '7.0']);
  });

  it('stops before the next page once asked to', async () => {
    await fill([[1, 0], [2, 0], [3, 0], [4, 0]]);
    let seen = 0;
    const { pages, finished } = await walk(2, () => seen++ >= 1);
    expect(finished).toBe(false);
    expect(pages).toEqual([['1.0']]);
  });

  it('ends at once on an empty table', async () => {
    await fill([]);
    expect(await walk(5)).toEqual({ pages: [], finished: true });
  });
});
