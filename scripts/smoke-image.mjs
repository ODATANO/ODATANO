#!/usr/bin/env node
// `node scripts/smoke-image.mjs <image>`: starts the image, probes it and leaves nothing behind.
// Passes when it answers, asks for credentials, refuses every development user, reaches its database
// on one SQLite connection and comes back after a restart on the same volume.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from './smoke-http.mjs';

const image = process.argv[2];
if (!image) {
  console.error('usage: node scripts/smoke-image.mjs <image>');
  process.exit(2);
}
const password = randomBytes(12).toString('hex');
const basic = (user, pass) => ({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
const AUTH = basic('odatano', password);
/** Every user `.cdsrc.json` names in a profile; they have no password there. */
function repositoryUsers() {
  const requires = JSON.parse(readFileSync(new URL('../.cdsrc.json', import.meta.url), 'utf8')).requires ?? {};
  return Object.values(requires).flatMap((section) => Object.keys(section?.auth?.users ?? {}));
}
/** CAP's own mocked users, which a container would accept if its auth ever became `mocked`. */
const CAP_MOCKED_USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'fred', 'me', 'yves'];
const DEVELOPMENT_USERS = [...new Set([...repositoryUsers(), ...CAP_MOCKED_USERS, `smoke-${randomBytes(4).toString('hex')}`])];

// Runs in the container with the configuration the server got. With one SQLite connection a second
// transaction waits for the first; with several, the first one's write after the second one's
// commit fails with "database is locked".
const SQLITE_ONE_WRITER = `
const cds = require('@sap/cds');
const fail = (what) => { console.error('FAIL ' + what); process.exit(1); };
(async () => {
  const config = cds.env.requires.db;
  if (config.kind !== 'sqlite') fail('the database is ' + config.kind);
  if (config.pool?.max !== 1) fail('the SQLite pool allows ' + config.pool?.max + ' connections');
  const db = await cds.connect.to('probe', { ...config, credentials: { url: '/tmp/one-writer.sqlite' } });
  await db.run('CREATE TABLE probe (id INTEGER)');
  const first = db.tx();
  await first.run('SELECT count(*) AS n FROM probe');
  const second = db.tx(async (tx) => { await tx.run('INSERT INTO probe VALUES (2)'); });
  await first.run('INSERT INTO probe VALUES (1)');
  await first.commit();
  await second;
  const [{ n }] = await db.run('SELECT count(*) AS n FROM probe');
  if (Number(n) !== 2) fail('expected two rows, found ' + n);
  process.exit(0);
})().catch((err) => fail(err.message));
`;
const BLOCKS = '/odata/v4/cardano/Blocks?$top=1';

const started = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (msg) => console.log(`ok   ${msg}`);
/** An error `fail` reported already. */
class Reported extends Error {}
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  try { console.error(docker('logs', '--tail', '60', started.at(-1))); } catch { /* no container */ }
  throw new Reported(msg);
};

/** Starts the image with `env` added and returns the container name and its base URL. */
function start(suffix, ...env) {
  const name = `odatano-smoke-${process.pid}-${suffix}`;
  started.push(name);
  docker('run', '-d', '--name', name, '-v', `${name}:/data`, '-p', '127.0.0.1::4004',
    '-e', `ODATANO_HTTP_PASSWORD=${password}`, '-e', 'NETWORK=preview', '-e', 'BACKENDS=koios',
    ...env.flatMap((e) => ['-e', e]), image);
  // Docker picks the host port, and picks a new one on a restart
  return { name, url: () => `http://127.0.0.1:${docker('port', name, '4004/tcp').split('\n')[0].split(':').pop()}` };
}

async function answering(url) {
  for (let i = 0; i < 180; i++) {
    try {
      if ((await request(`${url}/odata/v4/cardano-indexer/getLiveness()`)).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  fail('the container did not answer getLiveness() within 90 s');
}

async function refusesDevelopmentUsers(url, label) {
  for (const user of DEVELOPMENT_USERS) {
    for (const pass of ['', 'any']) {
      const { status } = await request(`${url}${BLOCKS}`, { headers: basic(user, pass) });
      if (status !== 401) fail(`${label}: the user ${user} answered ${status}, expected 401`);
    }
  }
}

/** Runs the one-writer probe with the configuration the container's server was started with. */
function keepsOneSqliteWriter(name) {
  try {
    docker('exec', '-w', '/app', name, 'sh', '-c', 'CDS_CONFIG="$(node /app/docker/cds-config.mjs)" exec node -e "$0"', SQLITE_ONE_WRITER);
  } catch (err) {
    fail(`two transactions on the SQLite database: ${String(err.stderr || err.message).trim()}`);
  }
}

async function probe(url, label) {
  await answering(url);
  const anonymous = await request(`${url}${BLOCKS}`);
  if (anonymous.status !== 401) fail(`${label}: a read without credentials answered ${anonymous.status}, expected 401`);
  const blocks = await request(`${url}${BLOCKS}`, { headers: AUTH });
  if (blocks.status !== 200) fail(`${label}: a read with credentials answered ${blocks.status}`);
  await refusesDevelopmentUsers(url, label);
  const readiness = (await request(`${url}/odata/v4/cardano-indexer/getReadiness()`)).json();
  if (readiness.database !== true) fail(`${label}: getReadiness() answered ${JSON.stringify(readiness)}`);
  ok(`${label}: alive, 401 without credentials and for ${DEVELOPMENT_USERS.length} development user names, 200 for the operator, database reachable`);
}

try {
  const main = start('main');
  await probe(main.url(), 'first start');
  keepsOneSqliteWriter(main.name);
  ok('SQLite runs on one connection: a second transaction waits for the first');
  docker('restart', main.name);
  await probe(main.url(), 'restart on the same volume');

  // the image holds no user without a password, whatever profile it is started in
  const development = start('development', 'NODE_ENV=development');
  await answering(development.url());
  await refusesDevelopmentUsers(development.url(), 'started with NODE_ENV=development');
  ok('started with NODE_ENV=development: development users get 401');

  console.log(`\nok   ${image} starts and serves`);
} catch (err) {
  process.exitCode = 1;
  if (!(err instanceof Reported)) console.error(`FAIL ${String(err?.stderr || err?.message || err).trim()}`);
} finally {
  for (const name of started) {
    try { docker('rm', '-f', '-v', name); } catch { /* never started */ }
    try { docker('volume', 'rm', name); } catch { /* already gone */ }
  }
}
