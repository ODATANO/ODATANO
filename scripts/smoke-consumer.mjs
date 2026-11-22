#!/usr/bin/env node
// `npm run smoke:consumer`: installs the packed tarball into an empty CAP project and serves it.
// Passes when model, service implementations and schema load without the repository.
// Needs the npm registry. Leaves nothing behind.
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from './smoke-http.mjs';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const AUTH = { authorization: `Basic ${Buffer.from('alice:').toString('base64')}` };
const SERVICES = ['cardano', 'cardano-transaction', 'cardano-sign', 'cardano-indexer', 'cardano-worker', 'cardano-backend', 'cardano-agent'];
// One input, one output, no witness.
const TX_CBOR = '84a30081825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000181a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a1011a00958940021a00030d40a0f5f6';
const TX_HASH = '4e30d8c0866a592489d4a7b18660cd7c29c0f7406acb46a5c79d18a3bbfec44b';

// Runs in the consumer project. The package relies on CAP behaviour that is not part of its API:
// a transaction takes its connection with its first statement, and shows that it holds one.
const TRANSACTION_CONTRACT = `
const cds = require('@sap/cds');
const { readOutside, holdsConnection, detachedTx } = require('./node_modules/@odatano/core/srv/utils/tx-utils.js');
const expectThat = (holds, what) => { if (!holds) { console.error('FAIL ' + what); process.exit(1); } };
(async () => {
  cds.db = await cds.connect.to('db');
  await cds.db.run('CREATE TABLE contract_probe (id INTEGER)');
  await cds.tx(async (tx) => {
    expectThat(!holdsConnection(tx), 'a new transaction holds no connection');
    await readOutside(tx, (db) => db.run('SELECT count(*) AS n FROM contract_probe'));
    expectThat(!holdsConnection(tx), 'a read outside the transaction leaves it idle');
    await detachedTx('contract', (db) => db.run('SELECT count(*) AS n FROM contract_probe'), 2000);
    await tx.run('INSERT INTO contract_probe VALUES (1)');
    expectThat(holdsConnection(tx), 'the first statement takes the connection');
    const rows = await readOutside(tx, (db) => db.run('SELECT count(*) AS n FROM contract_probe'));
    expectThat(Number(rows[0].n) === 1, 'a transaction that holds its connection reads itself');
  });
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
`;

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const ok = (msg) => console.log(`ok   ${msg}`);
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });

const freePort = () => new Promise((done, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

async function serving(server, url) {
  let exited = null;
  server.once('exit', (code) => { exited = code; });
  for (let i = 0; i < 120; i++) {
    if (exited !== null) fail(`the server exited with code ${exited} before it answered`);
    try {
      if ((await request(`${url}/odata/v4/cardano-indexer/getLiveness()`)).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  fail('the server did not answer within 60 s');
}

run('npm pack');
// npm names the tarball after the package: scope and name joined by a dash
const tarball = resolve(`${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
const consumer = mkdtempSync(join(tmpdir(), 'odatano-consumer-'));
let server;
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'odatano-consumer-smoke',
    private: true,
    dependencies: { '@sap/cds': '^10', '@cap-js/sqlite': '^3', '@odatano/core': `file:${tarball}` },
    cds: {
      requires: {
        // a host maps its users to the service roles; mocked auth names them per user
        auth: { kind: 'mocked', users: { alice: { roles: ['Read', 'Transact', 'Sign'] }, erin: { roles: [] } } },
        db: { kind: 'sqlite', credentials: { url: ':memory:' } },
        'odatano-core': { network: 'preview', backends: ['koios'] },
      },
    },
  }, null, 2));
  run('npm install --no-audit --no-fund', consumer);
  ok(`${tarball.split(/[\\/]/).pop()} installed into an empty CAP project`);

  writeFileSync(join(consumer, 'transaction-contract.cjs'), TRANSACTION_CONTRACT);
  run('node transaction-contract.cjs', consumer);
  ok('the installed CAP keeps a transaction idle until its first statement');

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output = [];
  server = spawn(process.execPath, [join('node_modules', '@sap', 'cds', 'bin', 'serve.js'), 'all', '--in-memory', '--port', String(port)],
    { cwd: consumer, env: { ...process.env, NODE_ENV: 'development' } });
  server.stdout.on('data', (chunk) => output.push(chunk));
  server.stderr.on('data', (chunk) => output.push(chunk));
  try {
    await serving(server, url);
  } catch (err) {
    console.error(Buffer.concat(output).toString('utf8').split('\n').slice(-40).join('\n'));
    throw err;
  }

  const liveness = (await request(`${url}/odata/v4/cardano-indexer/getLiveness()`)).json();
  if (liveness.status !== 'alive' || liveness.version !== version) fail(`getLiveness() answered ${JSON.stringify(liveness)}`);
  ok(`served, getLiveness() reports version ${liveness.version}`);

  for (const service of SERVICES) {
    const res = await request(`${url}/odata/v4/${service}/$metadata`, { headers: AUTH });
    if (res.status !== 200) fail(`/odata/v4/${service}/$metadata answered ${res.status}`);
  }
  ok(`${SERVICES.length} services answer their $metadata`);

  const anonymous = await request(`${url}/odata/v4/cardano/Blocks?$top=1`);
  if (anonymous.status !== 401) fail(`a read without credentials answered ${anonymous.status}, expected 401`);
  const blocks = await request(`${url}/odata/v4/cardano/Blocks?$top=1`, { headers: AUTH });
  if (blocks.status !== 200 || !Array.isArray(blocks.json().value)) fail(`reading Blocks answered ${blocks.status}`);
  const NO_ROLE = { authorization: `Basic ${Buffer.from('erin:').toString('base64')}` };
  const refused = await request(`${url}/odata/v4/cardano/Blocks?$top=1`, { headers: NO_ROLE });
  if (refused.status !== 403) fail(`a read by a user without the Read role answered ${refused.status}, expected 403`);
  ok('the schema is deployed: Blocks reads, needs credentials and the Read role');

  const parsed = await request(`${url}/odata/v4/cardano/ParseTransactionCbor`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ cbor: TX_CBOR }),
  });
  const body = parsed.json();
  if (parsed.status !== 200 || body.txHash !== TX_HASH) fail(`ParseTransactionCbor answered ${parsed.status} ${JSON.stringify(body).slice(0, 200)}`);
  ok('a service implementation runs: ParseTransactionCbor');
  console.log(`\nok   ${version} works as a package in a separate project`);
} finally {
  // Windows keeps the project folder locked until the server process is gone
  if (server && server.exitCode === null) {
    const gone = new Promise((done) => server.once('exit', done));
    server.kill();
    await gone;
  }
  rmSync(consumer, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  rmSync(tarball, { force: true });
}
