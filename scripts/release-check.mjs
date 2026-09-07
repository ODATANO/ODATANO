#!/usr/bin/env node
// Local mirror of the CI release gates. Run before calling a release "prepared":
//   npm run release:check
// Exits non-zero on the first failure, same as CI.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const mta = (readFileSync('mta.yaml', 'utf8').match(/^version:\s*(.+)$/m) || [])[1]?.trim();
const v = pkg.version;
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok   ${msg}`);

// 1. Version consistency (release.yml "Verify tag matches package.json and mta.yaml")
if (lock.version !== v) fail(`package-lock.json version ${lock.version} != package.json ${v}`);
if (lock.packages?.['']?.version !== v) fail(`package-lock.json root package version != ${v}`);
if (mta !== v) fail(`mta.yaml version ${mta} != package.json ${v}`);
ok(`version ${v} consistent in package.json, package-lock.json, mta.yaml`);

// 2. Stale "**Version:** vX.Y.Z" headers in the tracked docs and the project guide
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
const stale = headers.split('\n').filter((l) => l && !l.includes(`v${v}`));
if (stale.length) fail(`stale version headers:\n${stale.join('\n')}`);
ok(`no stale version headers (${headers.split('\n').filter(Boolean).length} checked)`);

// 3. Same commands as CI (test.yaml / release.yml package-check)
const commands = [
  'npm run typecheck',
  'npm run lint',
  'npm audit --omit=dev --audit-level=high',
  'npm pack --dry-run',
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
console.log(`\nok   release ${v} passes every local gate`);
