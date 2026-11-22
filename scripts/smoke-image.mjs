#!/usr/bin/env node
// `node scripts/smoke-image.mjs <image>`: starts the Docker image and probes it.
// Passes when the container answers, asks for credentials, reaches its database and comes back
// after a restart on the same data volume. Leaves nothing behind.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from './smoke-http.mjs';

const image = process.argv[2];
if (!image) {
  console.error('usage: node scripts/smoke-image.mjs <image>');
  process.exit(2);
}
const name = `odatano-smoke-${process.pid}`;
const password = randomBytes(12).toString('hex');
const AUTH = { authorization: `Basic ${Buffer.from(`odatano:${password}`).toString('base64')}` };

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (msg) => console.log(`ok   ${msg}`);
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  try { console.error(docker('logs', '--tail', '60', name)); } catch { /* no container */ }
  throw new Error(msg);
};

async function answering(url) {
  for (let i = 0; i < 180; i++) {
    try {
      if ((await request(`${url}/odata/v4/cardano-indexer/getLiveness()`)).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  fail('the container did not answer getLiveness() within 90 s');
}

async function probe(url, label) {
  await answering(url);
  const anonymous = await request(`${url}/odata/v4/cardano/Blocks?$top=1`);
  if (anonymous.status !== 401) fail(`${label}: a read without credentials answered ${anonymous.status}, expected 401`);
  const blocks = await request(`${url}/odata/v4/cardano/Blocks?$top=1`, { headers: AUTH });
  if (blocks.status !== 200) fail(`${label}: a read with credentials answered ${blocks.status}`);
  const readiness = (await request(`${url}/odata/v4/cardano-indexer/getReadiness()`)).json();
  if (readiness.database !== true) fail(`${label}: getReadiness() answered ${JSON.stringify(readiness)}`);
  ok(`${label}: alive, 401 without credentials, 200 with them, database reachable`);
}

try {
  docker('run', '-d', '--name', name, '-v', `${name}:/data`, '-p', '127.0.0.1::4004',
    '-e', `ODATANO_HTTP_PASSWORD=${password}`, '-e', 'NETWORK=preview', '-e', 'BACKENDS=koios', image);
  // Docker picks the host port, and picks a new one on a restart
  const url = () => `http://127.0.0.1:${docker('port', name, '4004/tcp').split('\n')[0].split(':').pop()}`;

  await probe(url(), 'first start');
  docker('restart', name);
  await probe(url(), 'restart on the same volume');
  console.log(`\nok   ${image} starts and serves`);
} catch (err) {
  process.exitCode = 1;
  if (!String(err?.message).length) console.error(err);
} finally {
  try { docker('rm', '-f', '-v', name); } catch { /* never started */ }
  try { docker('volume', 'rm', name); } catch { /* already gone */ }
}
