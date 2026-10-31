#!/usr/bin/env node
// Deploys the schema to the configured database. Replaces @sap/cds/bin/deploy.js, which prints the credentials.
import cds from '@sap/cds';

try {
    await cds.plugins;
    cds.db = await cds.connect.to('db');
    await cds.deploy('*').to(cds.db);
} catch (err) {
    process.stderr.write(`FATAL: schema deploy failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
} finally {
    await cds.db?.disconnect?.();
}
