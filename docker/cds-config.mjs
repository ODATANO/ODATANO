#!/usr/bin/env node
// Prints the image's CDS_CONFIG JSON, built from the environment. Exits 2 when the environment is unusable.
// --db-only prints just the database binding, for migrate modes that need no credentials.
// --db-label prints the database for the log: kind, host, port, database and user, never a password.
import { createRequire } from 'node:module';
import fs from 'node:fs';

// @cap-js/postgres takes pg Pool fields, not a connection string.
// Only sslmode disable, require and verify-full are supported. Other modes are refused, not approximated.
export function postgresCredentials(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('ODATANO_DB_URL is not a valid URL'); }
    if (!/^postgres(ql)?:$/i.test(u.protocol)) {
        throw new Error(`ODATANO_DB_URL must be a postgres:// URL (got the scheme '${u.protocol}'); for SQLite use ODATANO_DB_PATH`);
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

// SQLite has one writer. Named in full, so no profile or plugin configuration can widen the pool.
export const SQLITE_POOL = Object.freeze({ min: 1, max: 1, evictionRunIntervalMillis: 0 });

export function databaseConfig(env = process.env) {
    const url = String(env.ODATANO_DB_URL ?? '').trim();
    if (url) {
        return { kind: 'postgres', credentials: postgresCredentials(url), pool: { ...POSTGRES_POOL }, client: { ...POSTGRES_CLIENT } };
    }
    const path = String(env.ODATANO_DB_PATH ?? '/data/db.sqlite');
    const timeout = Number(env.ODATANO_SQLITE_TIMEOUT_MS) || 5000;
    return { kind: 'sqlite', credentials: { url: path }, pool: { ...SQLITE_POOL }, client: { timeout } };
}

/** The database as the log names it. */
export function databaseLabel(env = process.env) {
    const db = databaseConfig(env);
    if (db.kind !== 'postgres') return `sqlite (${db.credentials.url})`;
    const { user, host, port, database } = db.credentials;
    return `postgres (${user ? `${user}@` : ''}${host}:${port}/${database})`;
}

/** Value of ODATANO_ALLOW_UNAUTHENTICATED that admits ODATANO_AUTH=dummy. */
export const UNAUTHENTICATED_CONFIRMATION = 'yes-anyone-who-reaches-the-port-is-admin';

/** ODATANO_TRUST_PROXY: reverse proxies in front of the container, 0 without one. */
export function trustedProxies(env = process.env) {
    const raw = String(env.ODATANO_TRUST_PROXY ?? '').trim();
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`ODATANO_TRUST_PROXY must be the number of reverse proxies, 0 to 10 (got '${raw}')`);
    return n;
}

/** The installed login package, read when a setting depends on its release. */
export function loginPackage() {
    return createRequire(import.meta.url)('@odatano/cap-auth');
}

// A proxy count the installed login package cannot read would be dropped without a word, and one
// guessing client behind the proxy would lock out everyone. So the start refuses it.
export function assertProxySupport(trustProxy, pkg = loginPackage()) {
    if (trustProxy > 0 && typeof pkg?.trustedProxyCount !== 'function') {
        throw new Error('ODATANO_TRUST_PROXY needs @odatano/cap-auth 0.2.0 or later; the installed release ignores it');
    }
}

export function authConfig(env = process.env, pkg) {
    const kind = String(env.ODATANO_AUTH ?? 'basic');
    if (kind === 'dummy') {
        // A container cannot see whether its port is published, so the operator has to say it in words.
        if (env.ODATANO_ALLOW_UNAUTHENTICATED !== UNAUTHENTICATED_CONFIRMATION) {
            throw new Error(`ODATANO_AUTH=dummy switches every login and role check off. It starts only with ODATANO_ALLOW_UNAUTHENTICATED=${UNAUTHENTICATED_CONFIRMATION}`);
        }
        return { kind: 'dummy' };
    }
    if (kind !== 'basic') throw new Error(`unsupported ODATANO_AUTH='${kind}' (use: basic | dummy)`);
    const password = String(env.ODATANO_HTTP_PASSWORD ?? '');
    if (!password) throw new Error('ODATANO_HTTP_PASSWORD is required with basic auth (local unauthenticated testing only: ODATANO_AUTH=dummy)');
    const user = String(env.ODATANO_HTTP_USER || 'odatano');
    // The single configured user IS the operator of this deployment, so it
    // carries every role unless ODATANO_HTTP_ROLES says otherwise.
    const roles = String(env.ODATANO_HTTP_ROLES ?? 'Read,Transact,Sign,Admin').split(',').map(r => r.trim()).filter(Boolean);
    const trustProxy = trustedProxies(env);
    assertProxySupport(trustProxy, pkg);
    return { kind: 'basic', impl: '@odatano/cap-auth', realm: 'odatano', users: { [user]: { password, roles } }, trustProxy };
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
        const out = process.argv.includes('--db-label')
            ? databaseLabel(process.env)
            : JSON.stringify(cdsConfig(process.env, { dbOnly: process.argv.includes('--db-only') }));
        process.stdout.write(out + '\n');
    } catch (e) {
        process.stderr.write(`FATAL: ${e.message}\n`);
        process.exit(2);
    }
}
