#!/usr/bin/env node
// Builds the CDS_CONFIG JSON for the image from the environment. Called by
// docker/entrypoint.sh; kept in its own file so the mapping is unit tested
// (test/unit/docker-cds-config.test.ts). Only auth is mapped here; the
// database binding stays the package.json default (SQLite in the image).
//
//   ODATANO_AUTH            basic (default) | dummy
//   ODATANO_HTTP_USER       operator user (default odatano)
//   ODATANO_HTTP_PASSWORD   required with basic auth
//   ODATANO_HTTP_ROLES      comma-separated roles (default Admin)
//
// Prints the JSON on stdout; exits 2 with a message on stderr when the
// environment is unusable.

export function authConfig(env = process.env) {
    const kind = String(env.ODATANO_AUTH ?? 'basic');
    if (kind === 'dummy') return { kind: 'dummy' };
    if (kind !== 'basic') throw new Error(`unsupported ODATANO_AUTH='${kind}' (use: basic | dummy)`);
    const password = String(env.ODATANO_HTTP_PASSWORD ?? '');
    if (!password) throw new Error('ODATANO_HTTP_PASSWORD is required with basic auth (local unauthenticated testing only: ODATANO_AUTH=dummy)');
    const user = String(env.ODATANO_HTTP_USER || 'odatano');
    // The single configured user IS the operator of this deployment, so it
    // carries the Admin role unless ODATANO_HTTP_ROLES says otherwise.
    const roles = String(env.ODATANO_HTTP_ROLES ?? 'Admin').split(',').map(r => r.trim()).filter(Boolean);
    return { kind: 'basic', impl: '@odatano/cap-auth', realm: 'odatano', users: { [user]: { password, roles } } };
}

export function cdsConfig(env = process.env) {
    return { requires: { auth: authConfig(env) } };
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${String(process.argv[1]).replace(/\\/g, '/')}`) {
    try {
        process.stdout.write(JSON.stringify(cdsConfig(process.env)) + '\n');
    } catch (e) {
        process.stderr.write(`FATAL: ${e.message}\n`);
        process.exit(2);
    }
}
