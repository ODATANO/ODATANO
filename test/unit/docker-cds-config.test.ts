// The image builds its CDS_CONFIG (db + auth) from the environment in
// docker/cds-config.mjs. The mapping is what a container boots with, so it
// is pinned.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { convertValue, convertRow } from '../../scripts/migrate-values.mjs';

const SCRIPT = path.resolve(__dirname, '../../docker/cds-config.mjs');

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('docker/cds-config.mjs', () => {
  it('SQLite by default: /data/db.sqlite, basic auth via @odatano/cap-auth with the Admin role', () => {
    const r = run({ ODATANO_HTTP_PASSWORD: 'pw' });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(r.out);
    expect(cfg.requires.db).toEqual({ kind: 'sqlite', credentials: { url: '/data/db.sqlite' }, client: { timeout: 5000 } });
    expect(cfg.requires.auth).toEqual({ kind: 'basic', impl: '@odatano/cap-auth', realm: 'odatano', users: { odatano: { password: 'pw', roles: ['Admin'] } } });
    expect(cfg.requires.kinds).toBeUndefined();
  });

  it('honours the SQLite path and timeout, user and roles', () => {
    const cfg = JSON.parse(run({ ODATANO_HTTP_PASSWORD: 'pw', ODATANO_DB_PATH: '/x/y.db', ODATANO_SQLITE_TIMEOUT_MS: '9000', ODATANO_HTTP_USER: 'ops', ODATANO_HTTP_ROLES: 'Admin, viewer' }).out);
    expect(cfg.requires.db).toEqual({ kind: 'sqlite', credentials: { url: '/x/y.db' }, client: { timeout: 9000 } });
    expect(cfg.requires.auth.users).toEqual({ ops: { password: 'pw', roles: ['Admin', 'viewer'] } });
  });

  it('ODATANO_DB_URL selects PostgreSQL as pg Pool fields and injects the kind definition', () => {
    const cfg = JSON.parse(run({ ODATANO_HTTP_PASSWORD: 'pw', ODATANO_DB_URL: 'postgres://u:p%40ss@db:5433/odatano', ODATANO_DB_PATH: '/ignored.db' }).out);
    expect(cfg.requires.db).toMatchObject({ kind: 'postgres', credentials: { host: 'db', port: 5433, user: 'u', password: 'p@ss', database: 'odatano' } });
    expect(cfg.requires.db.credentials.ssl).toBeUndefined();
    expect(cfg.requires.db.pool).toMatchObject({ max: 20, acquireTimeoutMillis: 30000 });
    expect(cfg.requires.kinds.postgres).toMatchObject({ impl: '@cap-js/postgres', dialect: 'postgres', schema_evolution: 'auto' });
  });

  it('maps sslmode: require = unverified TLS, verify-full = verified, allow/prefer/verify-ca refused', () => {
    const base = { ODATANO_HTTP_PASSWORD: 'pw' };
    expect(JSON.parse(run({ ...base, ODATANO_DB_URL: 'postgres://u:p@db/x?sslmode=require' }).out).requires.db.credentials.ssl).toEqual({ rejectUnauthorized: false });
    expect(JSON.parse(run({ ...base, ODATANO_DB_URL: 'postgres://u:p@db/x?sslmode=verify-full' }).out).requires.db.credentials.ssl).toEqual({ rejectUnauthorized: true });
    for (const mode of ['allow', 'prefer', 'verify-ca', 'bogus']) {
      const r = run({ ...base, ODATANO_DB_URL: `postgres://u:p@db/x?sslmode=${mode}` });
      expect(r.code, mode).toBe(2);
    }
  });

  it('--db-only emits the database binding without auth and needs no password', () => {
    const r = run({ ODATANO_DB_URL: 'postgres://u:p@db/x' }, '--db-only');
    expect(r.code).toBe(0);
    const cfg = JSON.parse(r.out);
    expect(cfg.requires.auth).toBeUndefined();
    expect(cfg.requires.db.kind).toBe('postgres');
  });

  it('refuses a non-postgres URL, a missing password and an unknown auth kind (exit 2, secret not echoed)', () => {
    const mysql = run({ ODATANO_HTTP_PASSWORD: 'pw', ODATANO_DB_URL: 'mysql://u:p@db/x' });
    expect(mysql.code).toBe(2);
    expect(mysql.err).toMatch(/must be a postgres:\/\/ URL/);
    const missing = run({});
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/ODATANO_HTTP_PASSWORD is required/);
    const unknown = run({ ODATANO_AUTH: 'saml', ODATANO_HTTP_PASSWORD: 's3cret' });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unsupported ODATANO_AUTH/);
    expect(unknown.err).not.toContain('s3cret');
  });

  it('dummy auth needs no password', () => {
    const cfg = JSON.parse(run({ ODATANO_AUTH: 'dummy' }).out);
    expect(cfg.requires.auth).toEqual({ kind: 'dummy' });
  });
});

describe('scripts/migrate-values.mjs', () => {
  it('converts SQLite representations to what CAP inserts', () => {
    expect(convertValue({ type: 'cds.Boolean' }, 1n)).toBe(true);
    expect(convertValue({ type: 'cds.Boolean' }, 0n)).toBe(false);
    expect(convertValue({ type: 'cds.Integer' }, 42n)).toBe(42);
    expect(convertValue({ type: 'cds.Integer64' }, 9007199254740993n)).toBe('9007199254740993');
    expect(convertValue({ type: 'cds.Decimal' }, 12n)).toBe('12');
    expect(convertValue({ type: 'cds.Decimal' }, 1.5)).toBe(1.5);
    // a REAL beyond 2^53 is copied as the integer the double represents (45e15 lovelace max supply)
    expect(convertValue({ type: 'cds.Decimal' }, 45000000000000000, 'x')).toBe('45000000000000000');
    expect(convertValue({ type: 'cds.Integer64' }, 45000000000000000, 'x')).toBe('45000000000000000');
    expect(() => convertValue({ type: 'cds.Decimal' }, Infinity, 'x')).toThrow(/not an integral value/);
    expect(convertValue({ type: 'cds.String' }, null)).toBeNull();
  });

  it('drops columns the model no longer knows', () => {
    const def = { name: 'T', elements: { a: { type: 'cds.String' }, n: { type: 'cds.Integer' } } };
    expect(convertRow(def, { a: 'x', n: 3n, gone: 'y' })).toEqual({ a: 'x', n: 3 });
  });
});
