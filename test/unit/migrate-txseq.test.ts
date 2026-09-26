import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copySql } from '../../scripts/migrate-txseq.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/migrate-txseq.mjs');
const h = (c: string) => c.repeat(64);

// the tables the migration touches, in the layout before the txSeq key
const OLD_LAYOUT = `
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

function oldDatabase(dir: string): string {
  const file = path.join(dir, 'old.sqlite');
  const db = new DatabaseSync(file);
  db.exec(OLD_LAYOUT);
  db.exec(`INSERT INTO odatano_cardano_Transactions VALUES ('${h('a')}', 'b', 100, 0), ('${h('c')}', 'b', 100, 1), ('${h('d')}', 'e', 200, 0)`);
  db.exec(`INSERT INTO odatano_cardano_TransactionOutputs VALUES ('${h('a')}', 0, 'addr1'), ('${h('a')}', 1, 'addr2'), ('${h('c')}', 0, 'addr3')`);
  db.exec(`INSERT INTO odatano_cardano_TransactionInputs VALUES ('${h('c')}', 0, 'addr1', '${h('a')}', 0), ('${h('d')}', 0, 'addr2', '${h('a')}', 1)`);
  db.exec(`INSERT INTO odatano_cardano_TransactionOutputAssets VALUES ('${h('a')}', 0, 'lovelace', 5), ('${h('a')}', 0, 'p1', 7)`);
  db.exec(`INSERT INTO odatano_cardano_TransactionInputAssets VALUES ('${h('c')}', 0, 'lovelace', 5)`);
  db.exec(`INSERT INTO odatano_cardano_CardanoSyncState VALUES ('SINGLETON', NULL)`);
  db.close();
  return file;
}

function migrate(file: string, ...args: string[]) {
  const env = { ...process.env, CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: file } } } }) };
  const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('scripts/migrate-txseq.mjs', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'odatano-txseq-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds the copy from the old columns with the key taken from Transactions', () => {
    const sql = copySql(
      { name: 'TransactionInputAssets', hashKey: 'input_tx_hash', seqKey: 'input_txSeq', order: 'input_inputIndex, unit' },
      ['input_tx_hash', 'input_inputindex', 'unit', 'asset_quantity'],
    );
    expect(sql).toBe(
      'INSERT INTO odatano_cardano_TransactionInputAssets_txseq_new (input_txSeq, input_inputindex, unit, asset_quantity) '
      + 'SELECT t.txSeq, x.input_inputindex, x.unit, x.asset_quantity FROM odatano_cardano_TransactionInputAssets x '
      + 'JOIN odatano_cardano_Transactions t ON t.hash = x.input_tx_hash ORDER BY t.txSeq, x.input_inputIndex, x.unit',
    );
  });

  it('re-keys the four tables by txSeq, keeps every row and is a no-op on a second run', () => {
    const file = oldDatabase(dir);

    const dry = migrate(file, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('odatano_cardano_TransactionOutputs: 3 rows, key tx_hash -> txSeq');
    const before = new DatabaseSync(file);
    expect(before.prepare("SELECT count(*) AS n FROM pragma_table_info('odatano_cardano_TransactionInputs') WHERE name = 'tx_hash'").get()).toEqual({ n: 1 });
    before.close();

    const run = migrate(file);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);

    const db = new DatabaseSync(file);
    const seqA = 100 * 65536, seqC = 100 * 65536 + 1, seqD = 200 * 65536;
    expect(db.prepare('SELECT txSeq FROM odatano_cardano_Transactions ORDER BY txSeq').all().map(r => r.txSeq)).toEqual([seqA, seqC, seqD]);
    expect(db.prepare('SELECT txSeq, outputIndex, address_address FROM odatano_cardano_TransactionOutputs ORDER BY txSeq, outputIndex').all())
      .toEqual([{ txSeq: seqA, outputIndex: 0, address_address: 'addr1' }, { txSeq: seqA, outputIndex: 1, address_address: 'addr2' }, { txSeq: seqC, outputIndex: 0, address_address: 'addr3' }]);
    expect(db.prepare('SELECT txSeq, spentTxHash FROM odatano_cardano_TransactionInputs ORDER BY txSeq').all())
      .toEqual([{ txSeq: seqC, spentTxHash: h('a') }, { txSeq: seqD, spentTxHash: h('a') }]);
    expect(db.prepare('SELECT output_txSeq, unit FROM odatano_cardano_TransactionOutputAssets ORDER BY unit').all())
      .toEqual([{ output_txSeq: seqA, unit: 'lovelace' }, { output_txSeq: seqA, unit: 'p1' }]);
    expect(db.prepare('SELECT input_txSeq, unit FROM odatano_cardano_TransactionInputAssets').all()).toEqual([{ input_txSeq: seqC, unit: 'lovelace' }]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'view' AND name = 'CardanoODataService_TransactionInputs'").get()).toEqual({ n: 1 });
    db.close();

    const again = migrate(file);
    expect(again.code).toBe(0);
    expect(again.out).toContain('Already on the txSeq layout');
  }, 60_000);

  it('refuses while the crawler holds its lease', () => {
    const file = oldDatabase(dir);
    const db = new DatabaseSync(file);
    db.exec(`UPDATE odatano_cardano_CardanoSyncState SET leaseUntil = '${new Date(Date.now() + 60_000).toISOString()}'`);
    db.close();

    const r = migrate(file);
    expect(r.code).toBe(1);
    expect(r.err).toContain('stop ODATANO first');
  }, 60_000);

  it('rolls back when a row has no transaction to take its txSeq from', () => {
    const file = oldDatabase(dir);
    const db = new DatabaseSync(file);
    db.exec(`INSERT INTO odatano_cardano_TransactionOutputs VALUES ('${h('f')}', 0, 'orphan')`);
    db.close();

    const r = migrate(file);
    expect(r.code).toBe(1);
    expect(r.err).toContain('odatano_cardano_TransactionOutputs: 4 rows, 3 copied');
    const after = new DatabaseSync(file);
    expect(after.prepare("SELECT count(*) AS n FROM pragma_table_info('odatano_cardano_TransactionOutputs') WHERE name = 'tx_hash'").get()).toEqual({ n: 1 });
    after.close();
  }, 60_000);
});
