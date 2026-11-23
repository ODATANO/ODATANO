/**
 * Input asset copies: the statements run on a real SQLite database with one input per case,
 * the walk over slot windows runs against a recorded transaction.
 */
import { DatabaseSync } from 'node:sqlite';

const { runs, storedRange, state } = vi.hoisted(() => ({
  runs: [] as Array<{ sql: unknown; params?: unknown[] }>,
  storedRange: { lo: null as number | null, hi: null as number | null },
  state: { both: 0 },
}));

vi.mock('@sap/cds', () => {
  const tx = {
    run: vi.fn(async (sql: unknown, params?: unknown[]) => {
      runs.push({ sql, params });
      if (typeof sql !== 'string') return { lo: storedRange.lo, hi: storedRange.hi };
      if (sql.startsWith('UPDATE')) return { changes: 5 };
      if (sql.startsWith('DELETE')) return { changes: 9 };
      if (sql.startsWith('INSERT')) return { changes: 11 };
      if (sql.includes('IS NOT NULL AND EXISTS')) return [{ n: state.both }];
      return [{ n: 2 }];
    }),
  };
  const cdsMock = {
    db: { kind: 'sqlite' },
    tx: async (fn: (t: typeof tx) => unknown) => fn(tx),
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: { SELECT: { one: { from: () => ({ columns: () => ({ _op: 'range' }) }) } } },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({ TransactionInputs: 'TransactionInputs' }));
vi.mock('../../srv/utils/mappers', () => ({ TX_SEQ_SLOT_FACTOR: 65536 }));

import cds from '@sap/cds';
import {
  ASSET_COLUMNS, pruneInputAssetCopies, restoreInputAssetCopies,
  referenceStatement, deleteCopiesStatement, keptStatement, restoreCopiesStatement, dropReferenceStatement, bothStatement,
} from '../../srv/blockchain/crawler/input-asset-copies';
import { KEY_LOOKUPS_ONLY } from '../../srv/blockchain/crawler/window-plan';

const h = (c: string) => c.repeat(64);
const SPENDER = 1000 * 65536;
const WINDOW = [SPENDER, SPENDER + 65536];
const ASSET_DDL = ASSET_COLUMNS.map(c => `${c} ${c === 'asset_quantity' ? 'NUMERIC' : 'TEXT'}`).join(', ');

/** Six inputs of one transaction, each a case of the rule that decides whether an input may move. */
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE odatano_cardano_Transactions (hash TEXT PRIMARY KEY, txSeq INTEGER);
    CREATE TABLE odatano_cardano_TransactionOutputs (txSeq INTEGER, outputIndex INTEGER, PRIMARY KEY (txSeq, outputIndex));
    CREATE TABLE odatano_cardano_TransactionOutputAssets (output_txSeq INTEGER, output_outputIndex INTEGER, unit TEXT, ${ASSET_DDL},
      PRIMARY KEY (output_txSeq, output_outputIndex, unit));
    CREATE TABLE odatano_cardano_TransactionInputs (txSeq INTEGER, inputIndex INTEGER, spentTxHash TEXT, spentOutputIndex INTEGER, spentTxSeq INTEGER,
      PRIMARY KEY (txSeq, inputIndex));
    CREATE TABLE odatano_cardano_TransactionInputAssetCopies (input_txSeq INTEGER, input_inputIndex INTEGER, unit TEXT, ${ASSET_DDL},
      PRIMARY KEY (input_txSeq, input_inputIndex, unit));
    CREATE VIEW input_assets AS
      SELECT input_txSeq, input_inputIndex, unit, asset_quantity, asset_policyId FROM odatano_cardano_TransactionInputAssetCopies
      UNION ALL
      SELECT i.txSeq, i.inputIndex, a.unit, a.asset_quantity, a.asset_policyId FROM odatano_cardano_TransactionInputs i
        JOIN odatano_cardano_TransactionOutputAssets a ON a.output_txSeq = i.spentTxSeq AND a.output_outputIndex = i.spentOutputIndex;
    INSERT INTO odatano_cardano_Transactions VALUES ('${h('a')}', 100), ('${h('b')}', 200);
    INSERT INTO odatano_cardano_TransactionOutputs VALUES (100, 0), (100, 1), (100, 2), (200, 0);
    INSERT INTO odatano_cardano_TransactionOutputAssets (output_txSeq, output_outputIndex, unit, asset_quantity, asset_policyId) VALUES
      (100, 0, 'lovelace', 5, NULL), (100, 0, 'tok', 7, 'pol'), (100, 1, 'lovelace', 5, NULL), (100, 2, 'lovelace', 5, NULL), (100, 2, 'tok', 1, 'pol'),
      (200, 0, 'lovelace', 9, NULL);
    INSERT INTO odatano_cardano_TransactionInputs VALUES
      (${SPENDER}, 0, '${h('a')}', 0, NULL), (${SPENDER}, 1, '${h('a')}', 1, NULL), (${SPENDER}, 2, '${h('a')}', 2, NULL),
      (${SPENDER}, 3, '${h('b')}', 1, NULL), (${SPENDER}, 4, '${h('c')}', 0, NULL), (${SPENDER}, 5, '${h('b')}', 0, NULL);
    INSERT INTO odatano_cardano_TransactionInputAssetCopies (input_txSeq, input_inputIndex, unit, asset_quantity, asset_policyId) VALUES
      (${SPENDER}, 0, 'lovelace', 5, NULL), (${SPENDER}, 0, 'tok', 7, 'pol'), (${SPENDER}, 1, 'lovelace', 6, NULL), (${SPENDER}, 2, 'lovelace', 5, NULL),
      (${SPENDER}, 3, 'lovelace', 4, NULL), (${SPENDER}, 4, 'lovelace', 3, NULL), (${SPENDER}, 5, 'lovelace', 9, NULL);
  `);
  return db;
}
const run = (db: DatabaseSync, sql: string | null) => db.prepare(sql!).run(...WINDOW).changes;
const references = (db: DatabaseSync) =>
  Object.fromEntries((db.prepare('SELECT inputIndex, spentTxSeq FROM odatano_cardano_TransactionInputs ORDER BY inputIndex').all() as Array<{ inputIndex: number; spentTxSeq: number | null }>)
    .map(r => [r.inputIndex, r.spentTxSeq]));
const copies = (db: DatabaseSync) =>
  db.prepare('SELECT input_inputIndex AS i, unit, asset_quantity AS q, asset_policyId AS p FROM odatano_cardano_TransactionInputAssetCopies ORDER BY i, unit').all();
const assets = (db: DatabaseSync) =>
  db.prepare('SELECT input_inputIndex AS i, unit, asset_quantity AS q, asset_policyId AS p FROM input_assets ORDER BY i, unit').all();

describe('input asset copy statements on SQLite', () => {
  it('moves an input to its output only when the output holds exactly the copied assets', () => {
    const db = database();
    const before = assets(db);

    expect(run(db, referenceStatement('sqlite'))).toBe(2);
    expect(references(db)).toEqual({
      0: 100,   // equal
      1: null,  // the copy holds another quantity
      2: null,  // the output holds an asset the copy lacks
      3: null,  // the output is not stored
      4: null,  // the transaction that created it is not stored
      5: 200,   // equal
    });
    // between the two statements inputs 0 and 5 have both; after the delete none has
    expect(db.prepare(bothStatement('sqlite')!).get(...WINDOW)).toEqual({ n: 2 });
    expect(run(db, deleteCopiesStatement('sqlite'))).toBe(3);
    expect(db.prepare(bothStatement('sqlite')!).get(...WINDOW)).toEqual({ n: 0 });
    expect(db.prepare(keptStatement('sqlite')!).get(...WINDOW)).toEqual({ n: 4 });

    // every input still reads the same assets, each once
    expect(assets(db)).toEqual(before);
    db.close();
  });

  it('leaves inputs outside the window alone', () => {
    const db = database();
    expect(db.prepare(referenceStatement('sqlite')!).run(SPENDER + 65536, SPENDER + 131072).changes).toBe(0);
    expect(references(db)[0]).toBeNull();
    db.close();
  });

  it('writes the copies back from the outputs and takes the reference away', () => {
    const db = database();
    const stored = copies(db);
    const before = assets(db);
    run(db, referenceStatement('sqlite'));
    run(db, deleteCopiesStatement('sqlite'));

    expect(run(db, restoreCopiesStatement('sqlite'))).toBe(3);
    expect(run(db, dropReferenceStatement('sqlite'))).toBe(2);

    expect(Object.values(references(db)).every(r => r === null)).toBe(true);
    expect(copies(db)).toEqual(stored);
    expect(assets(db)).toEqual(before);
    // a second restore finds no reference and writes nothing
    expect(run(db, restoreCopiesStatement('sqlite'))).toBe(0);
    db.close();
  });

  it('has no statement for another database', () => {
    for (const build of [referenceStatement, deleteCopiesStatement, keptStatement, restoreCopiesStatement, dropReferenceStatement, bothStatement]) {
      expect(build('hana')).toBeNull();
    }
    expect(referenceStatement('postgres')).toContain('i.txSeq >= $1 AND i.txSeq < $2');
  });
});

describe('walk over slot windows', () => {
  beforeEach(() => {
    runs.length = 0;
    state.both = 0;
    (cds.db as unknown as { kind: string }).kind = 'sqlite';
    storedRange.lo = 100 * 65536;
    storedRange.hi = 349 * 65536 + 7;
  });
  const statements = () => runs.filter(r => typeof r.sql === 'string');
  const kinds = () => statements().map(s => String(s.sql).split(' ')[0]);

  it('prunes window by window: reference, delete, count, and adds up what each window reports', async () => {
    const seen: number[] = [];

    const r = await pruneInputAssetCopies({ fromSlot: 0, toSlot: 1_000_000, slotWindow: 100, onProgress: (p) => seen.push(p.atSlot) });

    // the stored inputs span slots 100..349: three windows of 100
    expect(kinds()).toEqual(['UPDATE', 'DELETE', 'SELECT', 'SELECT', 'UPDATE', 'DELETE', 'SELECT', 'SELECT', 'UPDATE', 'DELETE', 'SELECT', 'SELECT']);
    expect(statements().filter(s => String(s.sql).startsWith('UPDATE')).map(s => s.params)).toEqual([
      [100 * 65536, 200 * 65536], [200 * 65536, 300 * 65536], [300 * 65536, 350 * 65536],
    ]);
    expect(r).toEqual({ atSlot: 349, toSlot: 349, referenced: 15, kept: 6, deleted: 27 });
    expect(seen).toEqual([199, 299, 349]);
  });

  it('tells PostgreSQL in every window to find the rows by key', async () => {
    (cds.db as unknown as { kind: string }).kind = 'postgres';

    await pruneInputAssetCopies({ fromSlot: 0, toSlot: 1_000_000, slotWindow: 200 });

    // two windows; each starts with the planner settings
    expect(statements().map(s => s.sql).filter((_, i) => i % 5 === 0)).toEqual([KEY_LOOKUPS_ONLY, KEY_LOOKUPS_ONLY]);
    expect(statements()).toHaveLength(10);
  });

  it('keeps to the slots the caller asked for', async () => {
    const r = await restoreInputAssetCopies({ fromSlot: 250, toSlot: 320, slotWindow: 50 });

    expect(kinds()).toEqual(['INSERT', 'UPDATE', 'SELECT', 'INSERT', 'UPDATE', 'SELECT']);
    expect(statements().filter(s => String(s.sql).startsWith('INSERT')).map(s => s.params)).toEqual([[250 * 65536, 300 * 65536], [300 * 65536, 321 * 65536]]);
    expect(r).toEqual({ atSlot: 320, toSlot: 320, restored: 10, rows: 22 });
  });

  it('stops at a window that would leave an input with copies and a reference', async () => {
    state.both = 3;
    const seen: number[] = [];

    await expect(pruneInputAssetCopies({ fromSlot: 0, toSlot: 1_000_000, slotWindow: 100, onProgress: (p) => seen.push(p.atSlot) }))
      .rejects.toThrow('3 inputs between txSeq 6553600 and 13107200 would have copies and a reference');
    // the first window failed: no later window ran and nothing was reported as done
    expect(statements().filter(s => String(s.sql).startsWith('UPDATE'))).toHaveLength(1);
    expect(seen).toEqual([]);
    await expect(restoreInputAssetCopies({ fromSlot: 0, toSlot: 1_000_000 })).rejects.toThrow('would have copies and a reference');
  });

  it('does nothing where no input is stored', async () => {
    expect(await pruneInputAssetCopies({ fromSlot: 500, toSlot: 600 })).toEqual({ atSlot: 0, toSlot: 0, referenced: 0, kept: 0, deleted: 0 });
    expect(statements()).toHaveLength(0);
  });

  it('refuses a database it has no statement for', async () => {
    (cds.db as unknown as { kind: string }).kind = 'hana';
    await expect(pruneInputAssetCopies({ fromSlot: 1, toSlot: 2 })).rejects.toThrow('PostgreSQL and SQLite only');
    await expect(restoreInputAssetCopies({ fromSlot: 1, toSlot: 2 })).rejects.toThrow('PostgreSQL and SQLite only');
  });
});
