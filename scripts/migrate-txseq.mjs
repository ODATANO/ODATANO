#!/usr/bin/env node
// Move a database written before the txSeq schema onto it: TransactionInputs / TransactionOutputs
// and their asset tables are keyed by Transactions.txSeq (slot * 65536 + txIndex) instead of the
// transaction hash. Runs against the configured `db` (PostgreSQL or SQLite) with ODATANO stopped:
//
//   node scripts/migrate-txseq.mjs            # image: docker compose run --rm --no-deps odatano migrate-txseq
//   node scripts/migrate-txseq.mjs --dry-run  # report what would change, touch nothing
//
// One transaction: fill Transactions.txSeq, rebuild the four tables in the new layout (rows copied
// in key order, row counts checked), recreate the service views, refresh the planner statistics
// and store the new model in `cds_model` so the next schema deployment sees no difference. A
// database already on the new layout is left alone. The table indexes are recreated by the server
// on its next start.
import cds from '@sap/cds';

const DRY = process.argv.includes('--dry-run');
const T = (name) => `odatano_cardano_${name}`;
const TX_SEQ_SLOT_FACTOR = 65536;

/** Old key column -> new key column, and the column the copy is ordered by after the key. */
const TABLES = [
    { name: 'TransactionInputs', hashKey: 'tx_hash', seqKey: 'txSeq', order: 'inputIndex' },
    { name: 'TransactionOutputs', hashKey: 'tx_hash', seqKey: 'txSeq', order: 'outputIndex' },
    { name: 'TransactionInputAssets', hashKey: 'input_tx_hash', seqKey: 'input_txSeq', order: 'input_inputIndex, unit' },
    { name: 'TransactionOutputAssets', hashKey: 'output_tx_hash', seqKey: 'output_txSeq', order: 'output_outputIndex, unit' },
];

/** Column names of a table, lower-cased (PostgreSQL folds unquoted identifiers). */
export async function tableColumns(db, table) {
    const rows = db.kind === 'postgres'
        ? await db.run(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table.toLowerCase()}'`)
        : await db.run(`SELECT name FROM pragma_table_info('${table}')`);
    return rows.map(r => String(r.name).toLowerCase());
}

/** CREATE statements of the compiled model for one table (renamed) and for every view. */
export function modelStatements(model, options) {
    const sql = cds.compile.to.sql(model, options);
    const views = sql.filter(s => /^CREATE VIEW/i.test(s.trim()));
    const tableDdl = (name) => {
        const stmt = sql.find(s => new RegExp(`^CREATE TABLE ${T(name)} \\(`, 'i').test(s.trim()));
        if (!stmt) throw new Error(`model has no table ${T(name)}`);
        return stmt;
    };
    return { views, tableDdl };
}

const viewName = (stmt) => stmt.trim().match(/^CREATE VIEW\s+("?[\w.]+"?)/i)[1];

/** Copy statement: every column of the old table except the hash key, the new key from Transactions. */
export function copySql(spec, oldColumns) {
    const others = oldColumns.filter(c => c !== spec.hashKey.toLowerCase());
    const target = [spec.seqKey, ...others].join(', ');
    const source = ['t.txSeq', ...others.map(c => `x.${c}`)].join(', ');
    const order = ['t.txSeq', ...spec.order.split(',').map(c => `x.${c.trim()}`)].join(', ');
    return `INSERT INTO ${T(spec.name)}_txseq_new (${target}) SELECT ${source} FROM ${T(spec.name)} x `
        + `JOIN ${T('Transactions')} t ON t.hash = x.${spec.hashKey} ORDER BY ${order}`;
}

async function count(tx, table) {
    const [row] = await tx.run(`SELECT count(*) AS n FROM ${table}`);
    return Number(row.n);
}

async function main() {
    const db = await cds.connect.to('db');
    if (db.kind !== 'postgres' && db.kind !== 'sqlite') throw new Error(`unsupported database kind ${db.kind}: re-crawl instead`);

    const inputColumns = await tableColumns(db, T('TransactionInputs'));
    if (!inputColumns.includes('tx_hash')) {
        console.log('Already on the txSeq layout; nothing to do.');
        return;
    }

    const [lease] = await db.run(`SELECT leaseUntil FROM ${T('CardanoSyncState')}`).catch(() => []);
    const leaseUntil = lease?.leaseUntil ?? lease?.leaseuntil;
    if (leaseUntil && Date.parse(leaseUntil) > Date.now()) {
        throw new Error(`the crawler lease is held until ${leaseUntil}: stop ODATANO first`);
    }

    // the model exactly as `cds deploy` compiles it
    const model = await cds.load('*').then(cds.minify);
    cds.deploy.exclude_external_entities_in(model);
    const options = { ...db.options };
    const { views, tableDdl } = modelStatements(model, options);
    const [hasModelTable] = await db.run(db.kind === 'postgres'
        ? `SELECT 1 AS x FROM pg_tables WHERE tablename = 'cds_model' AND schemaname = current_schema()`
        : `SELECT 1 AS x FROM sqlite_schema WHERE name = 'cds_model'`);

    const txNull = Number((await db.run(`SELECT count(*) AS n FROM ${T('Transactions')} WHERE slot IS NULL OR txIndex IS NULL`))[0].n);
    if (txNull > 0) throw new Error(`${txNull} transactions have no slot or txIndex; their txSeq cannot be derived`);

    const plan = [];
    for (const spec of TABLES) plan.push({ spec, columns: await tableColumns(db, T(spec.name)), rows: await count(db, T(spec.name)) });
    for (const p of plan) console.log(`${T(p.spec.name)}: ${p.rows} rows, key ${p.spec.hashKey} -> ${p.spec.seqKey}`);
    console.log(`${views.length} views recreated${hasModelTable ? ', cds_model updated' : ''}`);
    if (DRY) { console.log('dry run: nothing changed'); return; }

    await db.tx(async (tx) => {
        const started = Date.now();
        const step = (msg) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${msg}`);

        for (const stmt of [...views].reverse()) {
            await tx.run(`DROP VIEW IF EXISTS ${viewName(stmt)}${db.kind === 'postgres' ? ' CASCADE' : ''}`);
        }
        step('views dropped');

        const txColumns = await tableColumns(tx, T('Transactions'));
        if (!txColumns.includes('txseq')) await tx.run(`ALTER TABLE ${T('Transactions')} ADD COLUMN txSeq BIGINT`);
        await tx.run(`UPDATE ${T('Transactions')} SET txSeq = slot * ${TX_SEQ_SLOT_FACTOR} + txIndex`);
        await tx.run(`CREATE INDEX IF NOT EXISTS odatano_cardano_transactions_txseq ON ${T('Transactions')} (txSeq)`);
        step('Transactions.txSeq filled');

        for (const { spec, columns, rows } of plan) {
            const table = T(spec.name);
            const newTable = `${table}_txseq_new`;
            await tx.run(tableDdl(spec.name).replace(new RegExp(`^(\\s*CREATE TABLE )${table}\\b`, 'i'), `$1${newTable}`));
            await tx.run(copySql(spec, columns));
            const copied = await count(tx, newTable);
            if (copied !== rows) throw new Error(`${table}: ${rows} rows, ${copied} copied (rows without a Transactions row?)`);
            await tx.run(`DROP TABLE ${table}`);
            await tx.run(`ALTER TABLE ${newTable} RENAME TO ${table}`);
            if (db.kind === 'postgres') {
                await tx.run(`ALTER TABLE ${table} RENAME CONSTRAINT ${newTable.toLowerCase()}_pkey TO ${table.toLowerCase()}_pkey`);
            }
            step(`${table}: ${copied} rows`);
        }

        for (const stmt of views) await tx.run(stmt);
        step('views recreated');

        // fresh planner statistics: without them the rebuilt tables are read by sequential scans
        for (const name of ['Transactions', ...TABLES.map(t => t.name)]) await tx.run(`ANALYZE ${T(name)}`);
        step('statistics updated');

        if (hasModelTable) {
            const { afterImage } = cds.compile.to.sql.delta(model, options);
            await tx.run(db.kind === 'postgres' ? 'UPDATE cds_model SET csn = $1' : 'UPDATE cds_model SET csn = ?', [JSON.stringify(afterImage)]);
            step('cds_model updated');
        }
    });
    console.log('Migration to the txSeq layout done. Start ODATANO; it recreates the table indexes.');
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
    main().then(() => process.exit(0), (err) => { console.error(`FAILED: ${err.message}`); process.exit(1); });
}
