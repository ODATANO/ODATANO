import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copySql, isTextType, rebuiltTableSql, unparsableSql } from '../../scripts/migrate-schema.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/migrate-schema.mjs');
const h = (c: string) => c.repeat(64);
const SEQ_A = 100 * 65536, SEQ_C = 100 * 65536 + 1, SEQ_D = 200 * 65536;

// the transaction tables as they were before the txSeq key
const HASH_KEYED = `
CREATE TABLE odatano_cardano_Transactions (hash NVARCHAR(64) NOT NULL, blockHash NVARCHAR(64), slot BIGINT, txIndex INTEGER, PRIMARY KEY(hash));
CREATE TABLE odatano_cardano_TransactionInputs (tx_hash NVARCHAR(64) NOT NULL, inputIndex INTEGER NOT NULL, address_address NVARCHAR(120),
  spentTxHash NVARCHAR(64), spentOutputIndex INTEGER, PRIMARY KEY(tx_hash, inputIndex));
CREATE TABLE odatano_cardano_TransactionOutputs (tx_hash NVARCHAR(64) NOT NULL, outputIndex INTEGER NOT NULL, address_address NVARCHAR(120),
  PRIMARY KEY(tx_hash, outputIndex));
CREATE TABLE odatano_cardano_TransactionInputAssets (input_tx_hash NVARCHAR(64) NOT NULL, input_inputIndex INTEGER NOT NULL, unit NVARCHAR(120) NOT NULL,
  asset_quantity REAL_DECIMAL(20, 0), PRIMARY KEY(input_tx_hash, input_inputIndex, unit));
CREATE TABLE odatano_cardano_TransactionOutputAssets (output_tx_hash NVARCHAR(64) NOT NULL, output_outputIndex INTEGER NOT NULL, unit NVARCHAR(120) NOT NULL,
  asset_quantity REAL_DECIMAL(20, 0), PRIMARY KEY(output_tx_hash, output_outputIndex, unit));
CREATE TABLE odatano_cardano_CardanoSyncState (ID NVARCHAR(10) NOT NULL, leaseUntil TIMESTAMP_TEXT, PRIMARY KEY(ID));
`;

// the tables the later steps touch, as the version before them left them
const SEQ_KEYED = `
CREATE TABLE odatano_cardano_Blocks (hash NVARCHAR(64) NOT NULL, time NVARCHAR(255), height INTEGER, slot BIGINT, epochNumber INTEGER, PRIMARY KEY(hash));
CREATE TABLE odatano_cardano_CardanoAgentGrants (ID NVARCHAR(36) NOT NULL, agentLabel NVARCHAR(120), walletId NVARCHAR(120), allowedJobKinds NVARCHAR(255), PRIMARY KEY(ID));
CREATE TABLE odatano_cardano_TransactionInputs (txSeq BIGINT NOT NULL, inputIndex INTEGER NOT NULL, spentTxHash NVARCHAR(64), spentOutputIndex INTEGER, PRIMARY KEY(txSeq, inputIndex));
CREATE TABLE odatano_cardano_TransactionInputAssets (input_txSeq BIGINT NOT NULL, input_inputIndex INTEGER NOT NULL, unit NVARCHAR(120) NOT NULL,
  asset_quantity REAL_DECIMAL(20, 0), PRIMARY KEY(input_txSeq, input_inputIndex, unit));
CREATE TABLE odatano_cardano_CardanoSyncState (ID NVARCHAR(10) NOT NULL, leaseUntil TIMESTAMP_TEXT, PRIMARY KEY(ID));
CREATE VIEW CardanoODataService_Blocks AS SELECT hash, time, height FROM odatano_cardano_Blocks;
`;

/** A stored model in the shape the schema deploy writes, for the tables of SEQ_KEYED. */
const STORED_MODEL = {
  definitions: {
    'odatano.cardano.Blocks': { kind: 'entity', elements: { hash: { key: true, type: 'cds.String', length: 64 }, time: { type: 'cds.String', length: 255 } } },
    'odatano.cardano.CardanoAgentGrants': { kind: 'entity', elements: { ID: { key: true, type: 'cds.UUID' }, agentLabel: { type: 'cds.String' }, walletId: { type: 'cds.String' }, allowedJobKinds: { type: 'cds.String' } } },
    'odatano.cardano.TransactionInputs': { kind: 'entity', elements: { txSeq: { key: true, type: 'cds.Integer64' }, assets: { type: 'cds.Composition', target: 'odatano.cardano.TransactionInputAssets' } } },
    'odatano.cardano.TransactionInputAssets': { kind: 'entity', elements: { unit: { key: true, type: 'cds.String' } } },
    'CardanoODataService.Blocks': { kind: 'entity', query: { SELECT: { from: { ref: ['odatano.cardano.Blocks'] } } }, elements: { time: { type: 'cds.String' } } },
  },
};

function database(dir: string, layout: string, ...statements: string[]): string {
  const file = path.join(dir, 'old.sqlite');
  const db = new DatabaseSync(file);
  db.exec(layout);
  for (const sql of statements) db.exec(sql);
  db.exec(`INSERT INTO odatano_cardano_CardanoSyncState VALUES ('SINGLETON', NULL)`);
  db.close();
  return file;
}

const HASH_KEYED_ROWS = [
  `INSERT INTO odatano_cardano_Transactions VALUES ('${h('a')}', 'b', 100, 0), ('${h('c')}', 'b', 100, 1), ('${h('d')}', 'e', 200, 0)`,
  `INSERT INTO odatano_cardano_TransactionOutputs VALUES ('${h('a')}', 0, 'addr1'), ('${h('a')}', 1, 'addr2'), ('${h('c')}', 0, 'addr3')`,
  `INSERT INTO odatano_cardano_TransactionInputs VALUES ('${h('c')}', 0, 'addr1', '${h('a')}', 0), ('${h('d')}', 0, 'addr2', '${h('a')}', 1)`,
  `INSERT INTO odatano_cardano_TransactionOutputAssets VALUES ('${h('a')}', 0, 'lovelace', 5), ('${h('a')}', 0, 'p1', 7)`,
  `INSERT INTO odatano_cardano_TransactionInputAssets VALUES ('${h('c')}', 0, 'lovelace', 5)`,
];
const SEQ_KEYED_ROWS = [
  `INSERT INTO odatano_cardano_Blocks VALUES ('${h('a')}', '2026-11-20T10:00:00.000Z', 1, 100, 7), ('${h('b')}', NULL, 2, 200, 7)`,
  `INSERT INTO odatano_cardano_CardanoAgentGrants VALUES ('g1', 'bot', NULL, NULL)`,
  `INSERT INTO odatano_cardano_TransactionInputs VALUES (${SEQ_C}, 0, '${h('a')}', 0)`,
  `INSERT INTO odatano_cardano_TransactionInputAssets VALUES (${SEQ_C}, 0, 'lovelace', 5)`,
];

function migrate(file: string, ...args: string[]) {
  const env = { ...process.env, CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: file } } } }) };
  const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Reads from a database file and closes it again. */
function read<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}
const columnsOf = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all() as Array<{ name: string; type: string }>);
const kindOf = (db: DatabaseSync, name: string) =>
  (db.prepare(`SELECT type FROM sqlite_schema WHERE name = '${name}'`).get() as { type: string } | undefined)?.type;
const storedModel = (db: DatabaseSync) =>
  JSON.parse((db.prepare('SELECT csn FROM cds_model').get() as { csn: string }).csn) as { definitions: Record<string, { elements: Record<string, { type?: string }> }> };

describe('scripts/migrate-schema.mjs: statements', () => {
  it('builds the copy from the given columns with the key taken from Transactions', () => {
    const sql = copySql(
      { from: 'TransactionInputAssets', to: 'TransactionInputAssetCopies', hashKey: 'input_tx_hash', seqKey: 'input_txSeq', order: 'input_inputIndex, unit' },
      ['input_tx_hash', 'input_inputindex', 'unit', 'asset_quantity'],
      'odatano_cardano_TransactionInputAssetCopies_txseq_new',
    );
    expect(sql).toBe(
      'INSERT INTO odatano_cardano_TransactionInputAssetCopies_txseq_new (input_txSeq, input_inputindex, unit, asset_quantity) '
      + 'SELECT t.txSeq, x.input_inputindex, x.unit, x.asset_quantity FROM odatano_cardano_TransactionInputAssets x '
      + 'JOIN odatano_cardano_Transactions t ON t.hash = x.input_tx_hash ORDER BY t.txSeq, x.input_inputIndex, x.unit',
    );
  });

  it('tells a text column from a timestamp column', () => {
    for (const type of ['nvarchar(255)', 'character varying', 'text']) expect(isTextType(type), type).toBe(true);
    for (const type of ['timestamp_text', 'timestamp without time zone']) expect(isTextType(type), type).toBe(false);
  });

  it('checks the stored time with a pattern of the database at hand', () => {
    expect(unparsableSql('postgres')).toContain('time !~ ');
    expect(unparsableSql('sqlite')).toContain('time NOT GLOB ');
  });

  it('rebuilds a SQLite table definition with the time as a timestamp', () => {
    const sql = rebuiltTableSql('CREATE TABLE odatano_cardano_Blocks (hash NVARCHAR(64) NOT NULL, time NVARCHAR(255), height INTEGER)', 'odatano_cardano_Blocks', 'b_new');
    expect(sql).toBe('CREATE TABLE b_new (hash NVARCHAR(64) NOT NULL, time TIMESTAMP_TEXT, height INTEGER)');
    expect(() => rebuiltTableSql('CREATE TABLE odatano_cardano_Blocks (hash NVARCHAR(64))', 'odatano_cardano_Blocks', 'b_new')).toThrow('no text column time');
  });
});

describe('scripts/migrate-schema.mjs: a database from before the txSeq key', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'odatano-schema-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-keys the four tables, keeps every row and needs nothing on a second run', () => {
    const file = database(dir, HASH_KEYED, ...HASH_KEYED_ROWS);

    const dry = migrate(file, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('due: transaction inputs and outputs keyed by txSeq');
    expect(dry.out).not.toContain('table renamed');
    expect(read(file, (db) => columnsOf(db, 'odatano_cardano_TransactionInputs').some(c => c.name === 'tx_hash'))).toBe(true);

    const run = migrate(file);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);

    read(file, (db) => {
      expect(db.prepare('SELECT txSeq FROM odatano_cardano_Transactions ORDER BY txSeq').all().map(r => r.txSeq)).toEqual([SEQ_A, SEQ_C, SEQ_D]);
      expect(db.prepare('SELECT txSeq, outputIndex, address_address FROM odatano_cardano_TransactionOutputs ORDER BY txSeq, outputIndex').all())
        .toEqual([{ txSeq: SEQ_A, outputIndex: 0, address_address: 'addr1' }, { txSeq: SEQ_A, outputIndex: 1, address_address: 'addr2' }, { txSeq: SEQ_C, outputIndex: 0, address_address: 'addr3' }]);
      expect(db.prepare('SELECT txSeq, spentTxHash FROM odatano_cardano_TransactionInputs ORDER BY txSeq').all())
        .toEqual([{ txSeq: SEQ_C, spentTxHash: h('a') }, { txSeq: SEQ_D, spentTxHash: h('a') }]);
      expect(db.prepare('SELECT output_txSeq, unit FROM odatano_cardano_TransactionOutputAssets ORDER BY unit').all())
        .toEqual([{ output_txSeq: SEQ_A, unit: 'lovelace' }, { output_txSeq: SEQ_A, unit: 'p1' }]);
      // the stored input assets are the copies of this version; the old name is free for the view
      expect(db.prepare('SELECT input_txSeq, unit FROM odatano_cardano_TransactionInputAssetCopies').all()).toEqual([{ input_txSeq: SEQ_C, unit: 'lovelace' }]);
      expect(kindOf(db, 'odatano_cardano_TransactionInputAssets')).toBeUndefined();
      // the rebuilt tables carry the columns of this version
      expect(columnsOf(db, 'odatano_cardano_TransactionInputs').map(c => c.name)).toContain('spentTxSeq');
    });

    const again = migrate(file);
    expect(again.code).toBe(0);
    expect(again.out).toContain('needs no migration');
  }, 90_000);

  it('rolls back when a row has no transaction to take its txSeq from', () => {
    const file = database(dir, HASH_KEYED, ...HASH_KEYED_ROWS, `INSERT INTO odatano_cardano_TransactionOutputs VALUES ('${h('f')}', 0, 'orphan')`);

    const r = migrate(file);

    expect(r.code).toBe(1);
    expect(r.err).toContain('odatano_cardano_TransactionOutputs: 4 rows, 3 copied');
    expect(read(file, (db) => columnsOf(db, 'odatano_cardano_TransactionInputs').some(c => c.name === 'tx_hash'))).toBe(true);
  }, 60_000);
});

describe('scripts/migrate-schema.mjs: block time, grant columns and input asset copies', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'odatano-schema-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports without changing anything on --dry-run', () => {
    const file = database(dir, SEQ_KEYED, ...SEQ_KEYED_ROWS);

    const r = migrate(file, '--dry-run');

    expect(r.code).toBe(0);
    expect(r.out).toContain('due: Blocks.time: text -> timestamp (2 rows)');
    expect(r.out).toContain('due: CardanoAgentGrants: columns walletId and allowedJobKinds removed');
    expect(r.out).toContain('due: TransactionInputAssets: table renamed to TransactionInputAssetCopies');
    expect(r.out).toContain('dry run: nothing changed');
    read(file, (db) => {
      expect(kindOf(db, 'odatano_cardano_TransactionInputAssets')).toBe('table');
      expect(kindOf(db, 'CardanoODataService_Blocks')).toBe('view');
    });
  }, 60_000);

  it('applies the steps, keeps every row and writes the stored model a database lacks', () => {
    const file = database(dir, SEQ_KEYED, ...SEQ_KEYED_ROWS);

    const r = migrate(file);

    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    read(file, (db) => {
      expect(columnsOf(db, 'odatano_cardano_Blocks').find(c => c.name === 'time')?.type).toBe('TIMESTAMP_TEXT');
      expect(db.prepare('SELECT height, time FROM odatano_cardano_Blocks ORDER BY height').all())
        .toEqual([{ height: 1, time: '2026-11-20T10:00:00.000Z' }, { height: 2, time: null }]);
      expect(columnsOf(db, 'odatano_cardano_CardanoAgentGrants').map(c => c.name)).toEqual(['ID', 'agentLabel']);
      expect(db.prepare('SELECT ID, agentLabel FROM odatano_cardano_CardanoAgentGrants').all()).toEqual([{ ID: 'g1', agentLabel: 'bot' }]);
      expect(kindOf(db, 'odatano_cardano_TransactionInputAssets')).toBeUndefined();
      expect(db.prepare('SELECT input_txSeq, unit, asset_quantity FROM odatano_cardano_TransactionInputAssetCopies').all())
        .toEqual([{ input_txSeq: SEQ_C, unit: 'lovelace', asset_quantity: 5 }]);
      // the views are gone until the schema deploy that follows
      expect(kindOf(db, 'CardanoODataService_Blocks')).toBeUndefined();

      const model = storedModel(db).definitions;
      // only what the database holds: tables it has, with the columns it has, and no view
      expect(Object.keys(model['odatano.cardano.Blocks'].elements).sort()).toEqual(['epochNumber', 'hash', 'height', 'slot', 'time']);
      expect(model['odatano.cardano.TransactionInputAssetCopies']).toBeDefined();
      expect(model['odatano.cardano.Pools']).toBeUndefined();
      expect(model['odatano.cardano.TransactionInputAssets']).toBeUndefined();
      expect(model['CardanoODataService.Blocks']).toBeUndefined();
    });

    expect(migrate(file).out).toContain('needs no migration');
  }, 90_000);

  it('makes a stored model say what the steps did, without its views', () => {
    const file = database(dir, SEQ_KEYED, ...SEQ_KEYED_ROWS,
      'CREATE TABLE cds_model (csn CLOB)', `INSERT INTO cds_model VALUES ('${JSON.stringify(STORED_MODEL)}')`);

    const r = migrate(file);

    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const model = read(file, (db) => storedModel(db).definitions);
    expect(model['odatano.cardano.Blocks'].elements.time.type).toBe('cds.Timestamp');
    expect(Object.keys(model['odatano.cardano.Blocks'].elements)).toEqual(['hash', 'time']);
    expect(Object.keys(model['odatano.cardano.CardanoAgentGrants'].elements)).toEqual(['ID', 'agentLabel']);
    expect(model['odatano.cardano.TransactionInputAssets']).toBeUndefined();
    expect(model['odatano.cardano.TransactionInputAssetCopies']).toBeDefined();
    expect(model['odatano.cardano.TransactionInputs'].elements.assets).toBeUndefined();
    expect(model['CardanoODataService.Blocks']).toBeUndefined();
  }, 60_000);

  it('refuses a time that is no ISO 8601 UTC timestamp', () => {
    const file = database(dir, SEQ_KEYED, ...SEQ_KEYED_ROWS, `INSERT INTO odatano_cardano_Blocks VALUES ('${h('d')}', '1790380806', 4, 400, 7)`);

    const r = migrate(file);

    expect(r.code).toBe(1);
    expect(r.err).toContain('1 blocks hold a time that is no ISO 8601 UTC timestamp');
    expect(read(file, (db) => kindOf(db, 'odatano_cardano_TransactionInputAssets'))).toBe('table');
  }, 60_000);

  it('refuses while a crawler holds its lease', () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const file = database(dir, SEQ_KEYED, ...SEQ_KEYED_ROWS);
    read(file, (db) => db.exec(`UPDATE odatano_cardano_CardanoSyncState SET leaseUntil = '${until}'`));

    const r = migrate(file);

    expect(r.code).toBe(1);
    expect(r.err).toContain('stop ODATANO first');
    expect(read(file, (db) => kindOf(db, 'odatano_cardano_TransactionInputAssets'))).toBe('table');
  }, 60_000);
});
