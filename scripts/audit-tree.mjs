#!/usr/bin/env node
// Audits one dependency tree. Fails on a high or critical advisory without a dated exception.
//   node scripts/audit-tree.mjs <dir> [--omit=dev]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [dir = '.', ...flags] = process.argv.slice(2);
const allExceptions = JSON.parse(readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8'));
const exceptions = new Map((allExceptions[dir] ?? []).map((e) => [e.id, e]));
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execSync(`npm audit --json ${flags.join(' ')}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the report is still on stdout.
  raw = err.stdout;
}
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error(`FAIL npm audit in ${dir} returned no report`);
  process.exit(1);
}
if (report.error) {
  console.error(`FAIL npm audit in ${dir}: ${report.error.summary ?? report.error.code}`);
  process.exit(1);
}

const advisories = new Map();
for (const pkg of Object.values(report.vulnerabilities ?? {})) {
  for (const via of pkg.via) {
    if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
    advisories.set(via.url.split('/').pop(), via);
  }
}

const blocking = [];
for (const [id, advisory] of advisories) {
  const exception = exceptions.get(id);
  if (!exception) blocking.push(`${advisory.severity} ${id} ${advisory.name}: ${advisory.title}`);
  else if (exception.until < today) blocking.push(`${id} ${advisory.name}: exception expired on ${exception.until}`);
  else console.log(`note ${id} ${advisory.name}: excepted until ${exception.until} (${exception.reason})`);
}
for (const id of exceptions.keys()) {
  if (!advisories.has(id)) console.log(`note ${id}: exception no longer needed, remove it from scripts/audit-exceptions.json`);
}
if (blocking.length) {
  console.error(`FAIL ${dir}: ${blocking.length} high or critical advisories\n${blocking.join('\n')}`);
  process.exit(1);
}
console.log(`ok   ${dir}: no high or critical advisory outside the dated exceptions`);
