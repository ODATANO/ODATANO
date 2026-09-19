// The image builds its CDS_CONFIG (auth) from the environment in
// docker/cds-config.mjs. The mapping is what a container boots with, so it
// is pinned.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../docker/cds-config.mjs');

function run(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('docker/cds-config.mjs', () => {
  it('basic auth by default: @odatano/cap-auth, realm odatano, the operator with the Admin role', () => {
    const r = run({ ODATANO_HTTP_PASSWORD: 'pw' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      requires: { auth: { kind: 'basic', impl: '@odatano/cap-auth', realm: 'odatano', users: { odatano: { password: 'pw', roles: ['Admin'] } } } },
    });
  });

  it('honours user and roles', () => {
    const cfg = JSON.parse(run({ ODATANO_HTTP_PASSWORD: 'pw', ODATANO_HTTP_USER: 'ops', ODATANO_HTTP_ROLES: 'Admin, viewer' }).out);
    expect(cfg.requires.auth.users).toEqual({ ops: { password: 'pw', roles: ['Admin', 'viewer'] } });
  });

  it('refuses a missing password and an unknown auth kind (exit 2, secret not echoed)', () => {
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
