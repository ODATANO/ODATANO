#!/usr/bin/env node
// Copy an ODATANO SQLite database into PostgreSQL.
//
//   node scripts/migrate-sqlite-to-postgres.mjs --from /data/db.sqlite --to postgres://user:pw@host:5432/db [--dry-run] [--force] [--ignore-unknown] [--batch 500]
//
// Reads every persisted entity of the loaded CDS model from the SQLite file
// (node:sqlite, integers as BigInt so Integer64 keeps every digit) and inserts
// the rows through CAP into PostgreSQL, so types are converted the way the
// runtime expects (SQLite 0/1 -> boolean, ISO strings stay timestamps). Rows
// are streamed and written in batches. Views are skipped (the deploy creates
// them). A source table the model does not define is reported; with rows it
// stops the run unless --ignore-unknown. The target must have been deployed
// (the image entrypoint does it) and must be EMPTY unless --force (rows are
// then appended; duplicate keys fail the run).
//
// Stop every writer first: this is a data migration, not a live sync. After
// the copy the script compares row counts per table; a mismatch exits 1.
// Defaults: --from ODATANO_DB_PATH or /data/db.sqlite, --to ODATANO_DB_URL.
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    return fallback;
}
const FROM = path.resolve(arg('--from', process.env.ODATANO_DB_PATH || '/data/db.sqlite'));
const TO = arg('--to', process.env.ODATANO_DB_URL || '');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const IGNORE_UNKNOWN = process.argv.includes('--ignore-unknown');
const BATCH = Math.max(1, Number(arg('--batch', '500')) || 500);

if (!fs.existsSync(FROM)) { console.error(`source SQLite file not found: ${FROM}`); process.exit(2); }
if (!TO || !/^postgres(ql)?:\/\//i.test(TO)) { console.error('a postgres:// target is required (--to or ODATANO_DB_URL)'); process.exit(2); }

const cds = require('@sap/cds');
const { postgresCredentials, postgresKind } = await import(new URL('../docker/cds-config.mjs', import.meta.url).href);
cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(TO) };

const src = new DatabaseSync(FROM, { readOnly: true });
const srcTables = new Set(src.prepare("select name from sqlite_master where type='table'").all().map(r => r.name));
const countOf = (table) => Number(src.prepare(`select count(*) n from "${table}"`).get().n);

const model = await cds.load('*');
cds.model = cds.compile.for.nodejs(model);
const entities = Object.values(cds.model.definitions)
    .filter(d => d.kind === 'entity' && !d.query && !d.projection && !d['@cds.persistence.skip'] && !d['@cds.persistence.exists']);

const db = await cds.connect.to('db');
const { SELECT, INSERT } = cds.ql;

const plan = [];
const modelTables = new Set();
for (const d of entities) {
    const table = String(d.name).replace(/\./g, '_');
    modelTables.add(table);
    if (!srcTables.has(table)) { plan.push({ entity: d.name, table, source: null, note: 'not in source (skipped)' }); continue; }
    const [{ n: dstCount }] = await db.run(SELECT.from(d.name).columns('count(*) as n'));
    plan.push({ entity: d.name, table, source: countOf(table), target: Number(dstCount), def: d });
}
const unknown = [...srcTables]
    .filter(t => !modelTables.has(t) && !t.startsWith('sqlite_'))
    .map(t => ({ table: t, rows: countOf(t) }));

console.log(`source ${FROM}`);
console.log(`target ${TO.replace(/:\/\/([^:/@]*)(:[^@]*)?@/, '://$1:***@')}`);
for (const p of plan) console.log(`  ${p.table.padEnd(48)} source=${p.source ?? '-'} target=${p.target ?? '-'}${p.note ? ' ' + p.note : ''}`);
for (const u of unknown) console.log(`  ${u.table.padEnd(48)} source=${u.rows} NOT IN MODEL (not migrated${u.rows > 0 ? ', see --ignore-unknown' : ''})`);
const unknownWithRows = unknown.filter(u => u.rows > 0);
if (unknownWithRows.length && !IGNORE_UNKNOWN) {
    console.error(`source holds rows in table(s) the loaded model does not define: ${unknownWithRows.map(u => u.table).join(', ')}. Pass --ignore-unknown to leave them behind.`);
    process.exit(1);
}
if (DRY) { console.log('dry run, nothing written'); process.exit(0); }

const nonEmpty = plan.filter(p => (p.target ?? 0) > 0);
if (nonEmpty.length && !FORCE) {
    console.error(`target is not empty (${nonEmpty.map(p => p.table).join(', ')}); migrate into a freshly deployed database, or pass --force to append anyway`);
    process.exit(1);
}

const { convertRow } = await import(new URL('./migrate-values.mjs', import.meta.url).href);

let failed = false;
for (const p of plan) {
    if (p.source == null || p.source === 0) continue;
    const stmt = src.prepare(`select * from "${p.table}"`);
    stmt.setReadBigInts(true);
    let done = 0;
    let batch = [];
    const flush = async () => {
        if (!batch.length) return;
        const rows = batch; batch = [];
        await cds.tx(async tx => { await tx.run(INSERT.into(p.entity).entries(rows)); });
        done += rows.length;
        process.stdout.write(`\r  ${p.table.padEnd(48)} ${done}/${p.source}`);
    };
    for (const row of stmt.iterate()) {
        batch.push(convertRow(p.def, row));
        if (batch.length >= BATCH) await flush();
    }
    await flush();
    const [{ n }] = await db.run(SELECT.from(p.entity).columns('count(*) as n'));
    const ok = Number(n) === (p.target ?? 0) + p.source;
    if (!ok) failed = true;
    process.stdout.write(`\r  ${p.table.padEnd(48)} ${done}/${p.source} -> target ${n} ${ok ? 'OK' : 'MISMATCH'}\n`);
}
src.close();
await cds.disconnect?.();
console.log(failed ? 'FAILED: row counts differ' : 'done: every table copied, counts match');
process.exit(failed ? 1 : 0);
