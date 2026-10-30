#!/usr/bin/env node
// Prints the image's CDS_CONFIG JSON, built from the environment. Exits 2 when the environment is unusable.
// --db-only prints just the database binding, for migrate modes that need no credentials.
import { createRequire } from 'node:module';
import fs from 'node:fs';

// @cap-js/postgres takes pg Pool fields, not a connection string.
// Only sslmode disable, require and verify-full are supported. Other modes are refused, not approximated.
export function postgresCredentials(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('ODATANO_DB_URL is not a valid URL'); }
    if (!/^postgres(ql)?:$/i.test(u.protocol)) {
        throw new Error(`ODATANO_DB_URL must be a postgres:// URL (got '${url.replace(/:\/\/[^@]*@/, '://***@').slice(0, 40)}…'); for SQLite use ODATANO_DB_PATH`);
    }
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!u.hostname || !database) throw new Error('ODATANO_DB_URL needs a host and a database name (postgres://user:pw@host:5432/db)');
    return {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        database,
        ...sslOptions(u.searchParams)
    };
}

function sslOptions(params) {
    const sslmode = (params.get('sslmode') || '').toLowerCase();
    const sslFlag = (params.get('ssl') || '').toLowerCase();
    const mode = sslmode || (['1', 'true', 'require'].includes(sslFlag) ? 'require' : '');
    if (!mode || mode === 'disable') return {};
    if (mode === 'require') return { ssl: { rejectUnauthorized: false } };
    if (mode === 'verify-full') {
        const rootcert = params.get('sslrootcert');
        if (!rootcert) return { ssl: { rejectUnauthorized: true } };
        let ca;
        try { ca = fs.readFileSync(rootcert, 'utf8'); } catch (e) { throw new Error(`sslrootcert is not readable: ${rootcert} (${e.message})`); }
        return { ssl: { rejectUnauthorized: true, ca } };
    }
    if (mode === 'allow' || mode === 'prefer') throw new Error(`sslmode='${mode}' (opportunistic TLS) is not supported by node-postgres; use disable, require or verify-full`);
    if (mode === 'verify-ca') throw new Error("sslmode='verify-ca' (chain without hostname check) is not supported; use verify-full, or require to skip verification");
    throw new Error(`unsupported sslmode='${mode}' in ODATANO_DB_URL (use: disable | require | verify-full)`);
}

// Wider than CAP's kind defaults (max 10, acquire 1 s): a checkpoint stall
// must not exhaust the pool, and a hung connect must not pin a slot.
export const POSTGRES_POOL = Object.freeze({
    min: 0, max: 20, testOnBorrow: true,
    acquireTimeoutMillis: 30000, destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 60000, evictionRunIntervalMillis: 60000
});
export const POSTGRES_CLIENT = Object.freeze({ connectionTimeoutMillis: 10000 });

export function databaseConfig(env = process.env) {
    const url = String(env.ODATANO_DB_URL ?? '').trim();
    if (url) {
        return { kind: 'postgres', credentials: postgresCredentials(url), pool: { ...POSTGRES_POOL }, client: { ...POSTGRES_CLIENT } };
    }
    const path = String(env.ODATANO_DB_PATH ?? '/data/db.sqlite');
    const timeout = Number(env.ODATANO_SQLITE_TIMEOUT_MS) || 5000;
    return { kind: 'sqlite', credentials: { url: path }, client: { timeout } };
}

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

// CAP only discovers @cap-js/postgres among project dependencies, but the image installs it beside them.
// So the postgres kind is read from the plugin's own package.json.
export function postgresKind() {
    let pkg;
    try { pkg = createRequire(import.meta.url)('@cap-js/postgres/package.json'); }
    catch { throw new Error('ODATANO_DB_URL needs @cap-js/postgres installed next to @sap/cds'); }
    const kind = pkg?.cds?.requires?.kinds?.postgres;
    if (!kind?.impl) throw new Error('@cap-js/postgres/package.json carries no cds.requires.kinds.postgres definition');
    return kind;
}

export function cdsConfig(env = process.env, { dbOnly = false } = {}) {
    const db = databaseConfig(env);
    const requires = dbOnly ? { db } : { db, auth: authConfig(env) };
    if (db.kind === 'postgres') requires.kinds = { postgres: postgresKind() };
    return { requires };
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${String(process.argv[1]).replace(/\\/g, '/')}`) {
    try {
        process.stdout.write(JSON.stringify(cdsConfig(process.env, { dbOnly: process.argv.includes('--db-only') })) + '\n');
    } catch (e) {
        process.stderr.write(`FATAL: ${e.message}\n`);
        process.exit(2);
    }
}
