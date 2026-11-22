#!/usr/bin/env node
// Brings the configured database to the schema of this version: first the changes the additive
// deploy refuses (scripts/migrate-schema.mjs), then the deploy itself, which never drops data.
// Replaces @sap/cds/bin/deploy.js, which prints the credentials.
import cds from '@sap/cds';
import { migrateSchema } from '../scripts/migrate-schema.mjs';

try {
    await cds.plugins;
    cds.db = await cds.connect.to('db');
    await migrateSchema(cds.db, { log: (line) => process.stdout.write(`schema migration: ${line}\n`) });
    // without schema evolution CAP drops and recreates every table of a SQLite database
    await cds.deploy('*', { schema_evolution: 'auto' }).to(cds.db);
} catch (err) {
    process.stderr.write(`FATAL: schema deploy failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
} finally {
    await cds.db?.disconnect?.();
}
