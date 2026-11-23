#!/usr/bin/env node
// Brings the configured database to the schema of this version: first the changes the additive
// deploy refuses (migrate-schema.mjs), then the deploy itself, which keeps every row.
// The upgrade command of a plugin project and of the Docker image. --dry-run only reports.
import cds from '@sap/cds';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertDeployable, migrateSchema } from './migrate-schema.mjs';

const print = (line) => process.stdout.write(`schema migration: ${line}\n`);

/** Migrates, then deploys with schema evolution. Without it CAP drops and recreates every SQLite table. */
export async function deploySchema(db, { dryRun = false, log = print } = {}) {
    return withDeployLock(db, log, async () => {
        const ran = await migrateSchema(db, { dryRun, log });
        if (dryRun) return ran;
        await assertDeployable(db);
        await cds.deploy('*', { schema_evolution: 'auto' }).to(db);
        return ran;
    });
}

// Two instances starting together on PostgreSQL would run the steps and the deploy at the same time,
// and one fails. A session lock on a connection of its own makes the second wait until the first is done.
async function withDeployLock(db, log, run) {
    const factory = db.kind === 'postgres' ? db.factory : null;
    if (!factory) return run();
    const dbc = await factory.create();
    try {
        const schema = db.options?.credentials?.schema;
        if (schema) await dbc.query(`SET search_path TO "${String(schema).replace(/"/g, '""')}", public`);
        const key = "hashtext('odatano_deploy_schema:' || current_schema())";
        const { rows } = await dbc.query(`SELECT pg_try_advisory_lock(${key}) AS got`);
        if (!rows[0]?.got) {
            log('another instance deploys the schema; waiting for it');
            await dbc.query(`SELECT pg_advisory_lock(${key})`);
        }
        try {
            return await run();
        } finally {
            await dbc.query(`SELECT pg_advisory_unlock(${key})`);
        }
    } finally {
        await factory.destroy(dbc);
    }
}

/** The SQLite file the configured database names, or null when it is not a file on disk. */
function sqliteFile() {
    const db = cds.env.requires.db ?? {};
    const url = db.credentials?.url ?? db.credentials?.database;
    if (!['sqlite', 'better-sqlite'].includes(db.kind) || !url || url === ':memory:') return null;
    return path.resolve(cds.root, url);
}

/** True when the error says the table does not exist; any other error is not an answer. */
export function isMissingTable(err) {
    const e = err ?? {};
    if (e.code === '42P01') return true;
    return /no such table/i.test(String(e.message ?? ''));
}

/** True when the database holds no table of this model yet. A failed connect or login is thrown. */
async function isEmpty(db) {
    try {
        await db.run('SELECT 1 FROM odatano_cardano_Blocks WHERE 1 = 0');
        return false;
    } catch (err) {
        if (isMissingTable(err)) return true;
        throw err;
    }
}

async function main() {
    const unknown = process.argv.slice(2).filter((a) => a !== '--dry-run');
    if (unknown.length) throw new Error(`unknown argument ${unknown.join(' ')}; the only option is --dry-run`);
    await cds.plugins;
    const dryRun = process.argv.includes('--dry-run');
    // connecting creates a missing SQLite file, which a dry run must not do
    const file = sqliteFile();
    if (dryRun && file && !existsSync(file)) {
        console.log(`Dry run: ${file} does not exist. A deploy creates it with the schema of this version.`);
        return;
    }
    cds.db = await cds.connect.to('db');
    try {
        if (dryRun && await isEmpty(cds.db)) {
            console.log('Dry run: the database is empty. A deploy creates the schema of this version; nothing changed.');
            return;
        }
        const ran = await deploySchema(cds.db, { dryRun });
        if (dryRun) {
            console.log(ran.length ? 'Dry run: the steps above are due, then the deploy; nothing changed.'
                : 'Dry run: no migration step is due. A deploy still adds what this version adds; nothing changed.');
        }
    } finally {
        await cds.db?.disconnect?.();
    }
}

/** The command line: deploys to the configured database, exits with 1 on a failure. */
export async function runDeploySchemaCli() {
    try {
        await main();
        process.exit(0);
    } catch (err) {
        process.stderr.write(`FATAL: schema deploy failed: ${err instanceof Error ? err.stack : String(err)}\n`);
        process.exit(1);
    }
}

// Replaces @sap/cds/bin/deploy.js, which prints the credentials.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) await runDeploySchemaCli();
