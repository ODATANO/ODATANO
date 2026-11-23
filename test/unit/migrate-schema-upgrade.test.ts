/**
 * The upgrade from 1.9.0: the migration steps followed by the schema deploy.
 * PostgreSQL: the deploy from the stored 1.9.0 model must hold no empty statement.
 * SQLite: a 1.9.0 file with rows runs through scripts/deploy-schema.mjs and keeps every row.
 */
import cds from '@sap/cds';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STEPS, emptyDeltaStatements, HANA_UPGRADE } from '../../scripts/migrate-schema.mjs';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test/fixtures');
const DEPLOY = path.join(ROOT, 'scripts/deploy-schema.mjs');
const PG = { kind: 'postgres', dialect: 'postgres' };
const h = (c: string) => c.repeat(64);

type Csn = { definitions: Record<string, { query?: unknown; projection?: unknown; elements?: Record<string, unknown> }> };
const storedModel = (): Csn => JSON.parse(readFileSync(path.join(FIXTURES, 'stored-model-1.9.0.json'), 'utf8'));

/** The parts of cds.deploy and cds.compile.to.sql the published typings leave out. */
type Untyped = {
  deploy: { exclude_external_entities_in: (model: unknown) => void };
  compile: { to: { sql: { delta: (model: unknown, options: unknown) => { afterImage: Csn } } } };
};

let current: Csn;
let image: Csn;
beforeAll(async () => {
  const untyped = cds as unknown as Untyped;
  current = await cds.load('*').then(cds.minify) as unknown as Csn;
  untyped.deploy.exclude_external_entities_in(current);
  image = untyped.compile.to.sql.delta(current, PG).afterImage;
});

/** The stored model as migrateSchema leaves it: every step applied, the views removed. */
function afterSteps(prior: Csn): Csn {
  for (const step of STEPS) step.model(prior.definitions, image.definitions);
  for (const [name, def] of Object.entries(prior.definitions)) if (def.query || def.projection) delete prior.definitions[name];
  return prior;
}

describe('upgrade from 1.9.0 on PostgreSQL', () => {
  it('the deploy after the steps holds no empty statement', () => {
    expect(emptyDeltaStatements(current, PG, afterSteps(storedModel()))).toBe(0);
  });

  it('counts the empty statements a stale composition produces', () => {
    const prior = storedModel();
    const stale = prior.definitions['odatano.cardano.Transactions'].elements!.inputs;
    const migrated = afterSteps(prior);
    migrated.definitions['odatano.cardano.Transactions'].elements!.inputs = stale;
    expect(emptyDeltaStatements(current, PG, migrated)).toBeGreaterThan(0);
    // SQLite runs an empty statement as a no-op
    expect(emptyDeltaStatements(current, { kind: 'sqlite' }, migrated)).toBe(0);
  });
});

describe('upgrade from 1.9.0 on SQLite through scripts/deploy-schema.mjs', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'odatano-upgrade-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function database(): string {
    const file = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(file);
    db.exec(readFileSync(path.join(FIXTURES, 'schema-1.9.0.sqlite.sql'), 'utf8'));
    db.exec(`
      INSERT INTO odatano_cardano_Blocks (hash, time, height, epochNumber) VALUES ('${h('b')}', '2025-06-01T10:00:00.000Z', 7, 3);
      INSERT INTO odatano_cardano_Transactions (hash, blockHash, blockHeight, slot, txIndex) VALUES ('${h('a')}', '${h('b')}', 7, 100, 0), ('${h('c')}', '${h('b')}', 7, 100, 1);
      INSERT INTO odatano_cardano_TransactionOutputs (tx_hash, outputIndex, address_address) VALUES ('${h('a')}', 0, 'addr1');
      INSERT INTO odatano_cardano_TransactionOutputAssets (output_tx_hash, output_outputIndex, unit, asset_quantity) VALUES ('${h('a')}', 0, 'lovelace', 5);
      INSERT INTO odatano_cardano_TransactionInputs (tx_hash, inputIndex, address_address) VALUES ('${h('c')}', 0, 'addr1');
      INSERT INTO odatano_cardano_TransactionInputAssets (input_tx_hash, input_inputIndex, unit, asset_quantity) VALUES ('${h('c')}', 0, 'lovelace', 5);
      INSERT INTO odatano_cardano_TransactionBuilds (validFrom, id, senderAddress) VALUES ('2025-06-01T10:00:00.000Z', 'build-1', 'addr1');
    `);
    db.close();
    return file;
  }

  function deploy(file: string, ...args: string[]) {
    const env = { ...process.env, CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: file } } } }) };
    const r = spawnSync(process.execPath, ['--no-warnings', DEPLOY, ...args], { cwd: ROOT, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('a dry run names the due steps and changes nothing; an empty file is reported as empty', () => {
    const file = database();
    // CAP switches the file to WAL on its first statement, so compare schema and rows, not bytes
    const content = () => {
      const db = new DatabaseSync(file);
      try {
        const schema = db.prepare(`SELECT type, name, sql FROM sqlite_schema ORDER BY name`).all();
        const rows = ['Blocks', 'Transactions', 'TransactionInputAssets', 'TransactionBuilds']
          .map((t) => db.prepare(`SELECT * FROM odatano_cardano_${t}`).all());
        return JSON.stringify({ schema, rows });
      } finally {
        db.close();
      }
    };
    const before = content();
    const dry = deploy(file, '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Dry run: the steps above are due');
    expect(content()).toBe(before);

    const empty = path.join(dir, 'empty.sqlite');
    new DatabaseSync(empty).close();
    expect(deploy(empty, '--dry-run').out).toContain('the database is empty');
  });

  it('refuses an unknown argument instead of running a real deploy', () => {
    const file = database();
    const r = deploy(file, '--dryrun');
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown argument --dryrun');
  });

  it('migrates and deploys, keeps every row and reads the input assets through the view', () => {
    const file = database();

    const run = deploy(file);
    expect(run.err).not.toContain('FATAL');
    expect(run.code).toBe(0);

    const db = new DatabaseSync(file);
    try {
      const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('odatano_cardano_Blocks')).toBe(1);
      expect(count('odatano_cardano_Transactions')).toBe(2);
      expect(count('odatano_cardano_TransactionOutputs')).toBe(1);
      expect(count('odatano_cardano_TransactionBuilds')).toBe(1);
      expect(db.prepare('SELECT input_txSeq AS seq, unit FROM odatano_cardano_TransactionInputAssets').all())
        .toEqual([{ seq: 100 * 65536 + 1, unit: 'lovelace' }]);
      expect(db.prepare(`SELECT type FROM sqlite_schema WHERE name = 'odatano_cardano_TransactionInputAssets'`).get()).toEqual({ type: 'view' });
    } finally {
      db.close();
    }

    // a second run finds nothing to do and changes nothing
    const again = deploy(file);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('due:');
  });
});

describe('SAP HANA', () => {
  it('names the way to upgrade instead of migrating', () => {
    expect(HANA_UPGRADE).toContain('new HDI container');
  });
});

describe('empty database in a dry run', () => {
  it('counts only a missing table as empty; a failed login or connect is an error', async () => {
    const { isMissingTable } = await import('../../scripts/deploy-schema.mjs');
    expect(isMissingTable({ code: '42P01', message: 'relation "odatano_cardano_blocks" does not exist' })).toBe(true);
    expect(isMissingTable(new Error('no such table: odatano_cardano_Blocks'))).toBe(true);
    expect(isMissingTable({ code: '28P01', message: 'password authentication failed for user "odatano"' })).toBe(false);
    expect(isMissingTable({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' })).toBe(false);
  });
});

describe('helpers of the migration', () => {
  it('takes length, precision and scale from the stored PostgreSQL column', async () => {
    const { sizedAsStored } = await import('../../scripts/migrate-schema.mjs');
    expect(sizedAsStored({ type: 'cds.Decimal', precision: 9, scale: 4 }, { precision: 5, scale: 4 })).toEqual({ type: 'cds.Decimal', precision: 5, scale: 4 });
    expect(sizedAsStored({ type: 'cds.String', length: 120 }, { length: 64 })).toEqual({ type: 'cds.String', length: 64 });
    expect(sizedAsStored({ type: 'cds.Integer' }, { precision: 32, scale: 0 })).toEqual({ type: 'cds.Integer' });
    expect(sizedAsStored({ type: 'cds.String', length: 10 }, undefined)).toEqual({ type: 'cds.String', length: 10 });
  });

  it('names only the views a model defines', async () => {
    const { modelViewNames } = await import('../../scripts/migrate-schema.mjs');
    const names = modelViewNames(
      { definitions: { 'CardanoODataService.Blocks': { kind: 'entity', query: {} }, 'odatano.cardano.Blocks': { kind: 'entity' } } },
      null,
      { definitions: { 'odatano.cardano.TransactionInputAssets': { kind: 'entity', projection: {} } } },
    );
    expect([...names].sort()).toEqual(['cardanoodataservice_blocks', 'odatano_cardano_transactioninputassets']);
  });
});
