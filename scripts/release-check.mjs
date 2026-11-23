#!/usr/bin/env node
// Local mirror of the CI release gates. Run before calling a release "prepared":
//   npm run release:check
// Exits non-zero on the first failure, same as CI.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loginPackageProblem } from './check-login-package.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const mta = (readFileSync('mta.yaml', 'utf8').match(/^version:\s*(.+)$/m) || [])[1]?.trim();
const v = pkg.version;
// A failed gate throws, so the cleanup of a running gate still runs; the process exits at the end.
class GateFailure extends Error {}
const fail = (msg) => {
  throw new GateFailure(msg);
};
const ok = (msg) => console.log(`ok   ${msg}`);

try {
// 1. Version consistency (release.yml "Verify tag matches package.json and mta.yaml")
if (lock.version !== v) fail(`package-lock.json version ${lock.version} != package.json ${v}`);
if (lock.packages?.['']?.version !== v) fail(`package-lock.json root package version != ${v}`);
if (mta !== v) fail(`mta.yaml version ${mta} != package.json ${v}`);
ok(`version ${v} consistent in package.json, package-lock.json, mta.yaml`);

// 1b. The version is a new release: the CHANGELOG has its heading, and no tag of that name points
//     at another commit. A tag on HEAD is this release, tagged before the check ran again.
if (!readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/).some((l) => l.startsWith(`## [v${v}]`))) {
  fail(`CHANGELOG.md has no heading "## [v${v}]"`);
}
let remoteTags = true;
try { execSync('git fetch --tags --quiet', { stdio: 'ignore', timeout: 20000 }); } catch { remoteTags = false; }
const tagged = execSync(`git tag --list v${v}`, { encoding: 'utf8' }).trim();
if (tagged) {
  const tagCommit = execSync(`git rev-list -n 1 v${v}`, { encoding: 'utf8' }).trim();
  const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  if (tagCommit !== head) fail(`tag v${v} already exists on ${tagCommit.slice(0, 7)}; this version is released, bump it`);
}
ok(`v${v} has a CHANGELOG heading and no tag on another commit${remoteTags ? '' : ' (local tags only: git fetch failed)'}`);

// 2. Stale "**Version:** vX.Y.Z" headers in the tracked docs and the project guide.
//    During an rc line the docs carry the placeholder "vX.Y.Z-rc.x", accepted for any rc of the base.
const headerFiles = [
  '.claude/CLAUDE.md',
  'docs/*.md',
  'docs/guides/*.md',
  'docs/concepts & architecture/*.md',
];
const grepArgs = headerFiles.map((f) => `"${f}"`).join(' ');
let headers = '';
try {
  headers = execSync(`git grep -n -E "^(- )?\\*\\*Version:\\*\\* v" -- ${grepArgs}`, { encoding: 'utf8' });
} catch {
  // git grep exits 1 when nothing matches; treat as no headers
}
const rcPlaceholder = /^(\d+\.\d+\.\d+)-rc\.\d+$/.test(v) ? `v${v.replace(/-rc\.\d+$/, '-rc.x')}` : null;
const current = (l) => l.includes(`v${v}`) || (rcPlaceholder != null && l.includes(rcPlaceholder));
const stale = headers.split('\n').filter((l) => l && !current(l));
if (stale.length) fail(`stale version headers:\n${stale.join('\n')}`);
ok(`no stale version headers (${headers.split('\n').filter(Boolean).length} checked)`);

// 3. Same commands as CI (test.yaml / release.yml package-check)
const commands = [
  'npm run typecheck',
  'npm run lint',
  'npm audit --omit=dev --audit-level=high',
  'node scripts/audit-tree.mjs app/router --omit=dev',
  'node scripts/audit-tree.mjs app/wallet',
  'npm pack --dry-run',
  'node scripts/smoke-consumer.mjs',
];
for (const cmd of commands) {
  console.log(`\n$ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    fail(`${cmd} failed`);
  }
  ok(cmd);
}
// 3b. The login package that ships reads the options the image hands it (scripts/check-login-package.mjs).
const loginProblem = loginPackageProblem(pkg, lock, createRequire(import.meta.url)('@odatano/cap-auth'));
if (loginProblem) fail(loginProblem);
ok(`@odatano/cap-auth ${lock.packages['node_modules/@odatano/cap-auth'].version} reads trustProxy`);

// 4. The BTP module as mta.yaml builds it: it loads as JavaScript on the plugin's CAP major and
//    passes npm audit (scripts/build/verify-btp-module.mjs, also run by release.yml).
try {
  execSync('node scripts/build/verify-btp-module.mjs', { stdio: 'inherit' });
} catch {
  fail('the BTP module does not pass scripts/build/verify-btp-module.mjs');
}
ok('node scripts/build/verify-btp-module.mjs');

// 5. The Docker image, where docker runs here. release.yml runs the same smoke before it pushes.
let docker = false;
try { execSync('docker info', { stdio: 'ignore' }); docker = true; } catch { /* no docker */ }
if (docker) {
  const image = `odatano:release-check-${v}`;
  let smoked = false;
  try {
    execSync(`docker build -q -t ${image} --build-arg VERSION=${v} .`, { stdio: ['ignore', 'ignore', 'inherit'] });
    execSync(`node scripts/smoke-image.mjs ${image}`, { stdio: 'inherit' });
    smoked = true;
  } catch { /* reported below, once the image is removed */ } finally {
    try { execSync(`docker rmi ${image}`, { stdio: 'ignore' }); } catch { /* never built */ }
  }
  if (!smoked) fail('the Docker image does not pass scripts/smoke-image.mjs');
  ok('node scripts/smoke-image.mjs');
} else {
  console.log('skip the Docker image: docker is not running here');
}
console.log(`\nok   release ${v} passes every local gate`);
} catch (err) {
  if (!(err instanceof GateFailure)) throw err;
  console.error(`FAIL ${err.message}`);
  process.exitCode = 1;
}
