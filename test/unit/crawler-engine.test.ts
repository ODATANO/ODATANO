/**
 * Chain crawler — engine reorg handling (C4/C7).
 * Mocks the @sap/cds CQL + tx layer and drives CardanoCrawler.handleReorg directly,
 * asserting the slot-axis block cut, the blockHash-join transaction delete (lazily
 * indexed txs of unrelated blocks stay untouched), cursor reset and ReorgLog audit.
 */

type Q = { _op: string; entity: string; where?: unknown; set?: unknown; entries?: unknown };
const dbRun = jest.fn<Promise<unknown>, [Q]>();
const fakeDb = { run: dbRun };

jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  utils: { uuid: () => 'reorg-uuid' },
  tx: (fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ql: {
    SELECT: {
      one: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }) }) },
      from: (entity: string) => ({
        columns: () => ({ where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }) }),
        where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
      }),
    },
    DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
    INSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'INSERT', entity, entries }) }) },
    UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: () => ({ _op: 'UPDATE', entity, set }) }) }) },
  },
}));

// The typed entity proxies need the real cds runtime — stub them with plain names.
jest.mock('#cds-models/odatano/cardano', () => ({
  Blocks: 'odatano.cardano.Blocks',
  Transactions: 'odatano.cardano.Transactions',
  TransactionInputs: 'odatano.cardano.TransactionInputs',
  TransactionInputAssets: 'odatano.cardano.TransactionInputAssets',
  TransactionOutputs: 'odatano.cardano.TransactionOutputs',
  TransactionOutputAssets: 'odatano.cardano.TransactionOutputAssets',
  TransactionMetadata_: 'odatano.cardano.TransactionMetadata',
  CardanoReorgLog: 'odatano.cardano.CardanoReorgLog',
  CardanoSyncState: 'odatano.cardano.CardanoSyncState',
}));

import { CardanoCrawler, type CrawlerConfig } from '../../srv/blockchain/crawler/crawler';

const CONFIG: CrawlerConfig = {
  enabled: true, startSlot: 0, startBlockHash: 'genesis', source: 'auto',
  batchSize: 20, confirmationDepth: 3, pollIntervalMs: 20000,
};

const makeCrawler = (config: CrawlerConfig = CONFIG, client: unknown = {}) =>
  new CardanoCrawler(client as never, {} as never, 'preview', config);

const opsFor = (op: string) => dbRun.mock.calls.map(c => c[0]).filter(q => q._op === op);
const shortName = (entity: string) => entity.split('.').pop();

describe('CardanoCrawler.handleReorg', () => {
  beforeEach(() => dbRun.mockReset());

  it('cuts blocks on the slot axis, deletes only their txs via blockHash join, resets the cursor and logs the reorg', async () => {
    dbRun.mockImplementation(async (q) => {
      // blocks after the fork (slot axis)
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [{ hash: 'b1' }, { hash: 'b2' }];
      // txs belonging to those blocks only
      if (q._op === 'SELECT.many' && q.entity.endsWith('Transactions')) return [{ hash: 't1' }, { hash: 't2' }];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'forkhash', height: 5 });

    // block selection ran on the absolute-slot axis (never a height fallback)
    const blockSelect = opsFor('SELECT.many').find(q => q.entity.endsWith('Blocks'));
    expect(blockSelect!.where).toEqual({ slot: { '>': 500 } });

    // tx selection is confined to the rolled-back blocks' hashes
    const txSelect = opsFor('SELECT.many').find(q => q.entity.endsWith('Transactions'));
    expect(txSelect!.where).toEqual({ blockHash: { in: ['b1', 'b2'] } });

    const deletes = opsFor('DELETE').map(q => shortName(q.entity));
    expect(deletes).toEqual(expect.arrayContaining([
      'TransactionInputAssets', 'TransactionOutputAssets',
      'TransactionInputs', 'TransactionOutputs', 'TransactionMetadata',
      'Transactions', 'Blocks',
    ]));

    // children deleted by the resolved tx-hash set; txs and blocks by explicit hash sets
    const childDelete = opsFor('DELETE').find(q => q.entity.endsWith('TransactionInputs'));
    expect(childDelete!.where).toEqual({ tx_hash: { in: ['t1', 't2'] } });
    const txDelete = opsFor('DELETE').find(q => q.entity.endsWith('.Transactions'));
    expect(txDelete!.where).toEqual({ hash: { in: ['t1', 't2'] } });
    const blockDelete = opsFor('DELETE').find(q => q.entity.endsWith('Blocks'));
    expect(blockDelete!.where).toEqual({ hash: { in: ['b1', 'b2'] } });

    // cursor rewound to the fork
    const update = opsFor('UPDATE')[0];
    expect((update.set as Record<string, unknown>).lastBlockHash).toBe('forkhash');

    // audit row counts BLOCKS (not txs)
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect(reorg!.entries).toMatchObject({
      forkSlot: 500, forkHeight: 5, newTipHash: 'forkhash',
      blocksRolledBack: 2, status: 'completed',
    });
  });

  it('deletes nothing but still resets the cursor and logs when no blocks are after the fork', async () => {
    dbRun.mockImplementation(async (q) => {
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'forkhash', height: 5 });

    expect(opsFor('DELETE')).toHaveLength(0);
    expect(opsFor('UPDATE')).toHaveLength(1);
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect((reorg!.entries as Record<string, unknown>).blocksRolledBack).toBe(0);
  });

  it('never widens the delete when the fork height is unresolvable (no height-0 fallback)', async () => {
    dbRun.mockImplementation(async (q) => {
      // fork block unknown locally → SELECT.one returns undefined
      if (q._op === 'SELECT.one') return undefined;
      if (q._op === 'SELECT.many' && q.entity.endsWith('Blocks')) return [{ hash: 'b9' }];
      if (q._op === 'SELECT.many' && q.entity.endsWith('Transactions')) return [];
      return undefined;
    });

    const crawler = makeCrawler();
    await (crawler as unknown as { handleReorg: (p: unknown) => Promise<void> })
      .handleReorg({ slot: 500, hash: 'unknownfork' }); // no height on the point

    // the cut stays on the slot axis and explicit hashes — no height-based delete exists
    const blockDelete = opsFor('DELETE').find(q => q.entity.endsWith('Blocks'));
    expect(blockDelete!.where).toEqual({ hash: { in: ['b9'] } });
    const reorg = opsFor('INSERT').find(q => q.entity.endsWith('CardanoReorgLog'));
    expect((reorg!.entries as Record<string, unknown>).forkHeight).toBeNull();
  });
});

describe('CardanoCrawler source semantics', () => {
  beforeEach(() => dbRun.mockReset());

  it("source 'ogmios' does NOT fall back to pagination when no chain-sync backend exists", async () => {
    dbRun.mockResolvedValue(undefined);
    const client = {
      getChainSyncBackend: () => null,
      getPaginatingBackend: jest.fn(() => { throw new Error('pagination must not be reached'); }),
    };
    const crawler = makeCrawler({ ...CONFIG, source: 'ogmios' }, client);
    // in the real flow start() flips this before launching the pipeline
    (crawler as unknown as { running: boolean }).running = true;

    await (crawler as unknown as { runIngestPipeline: () => Promise<void> }).runIngestPipeline();

    expect(client.getPaginatingBackend).not.toHaveBeenCalled();
    // stop('error') recorded the terminal status on the cursor
    const statusUpdate = opsFor('UPDATE').find(q => (q.set as Record<string, unknown>)?.syncStatus === 'error');
    expect(statusUpdate).toBeDefined();
  });
});

describe('CardanoCrawler.isRunning', () => {
  it('is false before start', () => {
    expect(makeCrawler().isRunning()).toBe(false);
  });
});
