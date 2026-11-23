#!/usr/bin/env node
// `node scripts/build/verify-btp-module.mjs`: builds the BTP module the way mta.yaml does, into a temp
// folder, installs it from its lockfile, checks that it loads as JavaScript on the plugin's CAP
// major and audits it. Removes the folder whatever the outcome. Used by release-check and release.yml.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const capMajor = String(pkg.peerDependencies['@sap/cds']).replace(/^\D+/, '').split('.')[0];
const { finishSrvModule } = createRequire(import.meta.url)('./gen-srv-package.js');
const buildDir = mkdtempSync(join(tmpdir(), 'odatano-btp-'));
const srvDir = join(buildDir, 'srv');
const quiet = { stdio: ['ignore', 'ignore', 'inherit'] };

let failure = null;
try {
  execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' });
  // the nodejs task of .cdsrc.json, into the temp folder
  execSync(`npx cds build --production --for nodejs --src srv --dest "${srvDir}" --opts contentPackageLockJson=false,contentCdsrcJson=false`, quiet);
  finishSrvModule(srvDir);
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { ...quiet, cwd: srvDir });
  execSync(`node scripts/build/check-srv-module.js "${srvDir}" ${capMajor}`, { stdio: 'inherit' });
  try {
    execSync('npm audit --omit=dev --audit-level=high', { cwd: srvDir, stdio: 'inherit' });
  } catch {
    failure = 'the BTP module has a high or critical advisory';
  }
} catch (err) {
  failure = String(err?.message ?? err).split('\n')[0];
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
if (failure) {
  console.error(`FAIL the BTP module: ${failure}`);
  process.exit(1);
}
console.log('ok   the BTP module builds, installs from its lockfile, loads and passes npm audit');
