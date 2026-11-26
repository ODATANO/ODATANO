#!/usr/bin/env node
// Release workflow: reuse the Tests run that main's push started for the tagged commit.
// Writes result=passed | none to GITHUB_OUTPUT and fails when that run failed.
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const POLL_MS = 30_000;
const WAIT_LIMIT_MS = 55 * 60_000;
// commit and tag pushed together: the Tests run can appear a little after the Release run
const APPEAR_LIMIT_MS = 2 * 60_000;
// a cancelled or skipped run tested nothing, so the release runs the tests itself
const PASSED = new Set(['success']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
const api = process.env.GITHUB_API_URL || 'https://api.github.com';
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
  console.error('main-tests-result: GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  process.exit(1);
}
const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

const setResult = (result) => {
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `result=${result}\n`);
  console.log(`main-tests-result: ${result}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newestRun() {
  const query = new URLSearchParams({ head_sha: sha, event: 'push', branch: 'main', per_page: '20' });
  const res = await fetch(`${api}/repos/${GITHUB_REPOSITORY}/actions/workflows/test.yaml/runs?${query}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}: ${await res.text()}`);
  const { workflow_runs: runs } = await res.json();
  return runs.length ? runs.reduce((a, b) => (a.created_at >= b.created_at ? a : b)) : null;
}

const started = Date.now();
for (;;) {
  const run = await newestRun();
  const waited = Date.now() - started;
  if (!run && waited >= APPEAR_LIMIT_MS) {
    console.log(`No Tests run on main for ${sha.slice(0, 7)}; the release runs the tests.`);
    setResult('none');
    break;
  }
  if (run?.status === 'completed') {
    if (PASSED.has(run.conclusion)) {
      console.log(`Tests passed on main for ${sha.slice(0, 7)}: ${run.html_url}`);
      setResult('passed');
    } else if (FAILED.has(run.conclusion)) {
      console.error(`Tests ended with ${run.conclusion} on main for ${sha.slice(0, 7)}: ${run.html_url}`);
      console.error('Re-run that workflow, then re-run this release.');
      process.exit(1);
    } else {
      console.log(`Tests ended with ${run.conclusion} on main for ${sha.slice(0, 7)}; the release runs the tests.`);
      setResult('none');
    }
    break;
  }
  if (waited >= WAIT_LIMIT_MS) {
    console.error(`Tests on main for ${sha.slice(0, 7)} still ${run.status} after ${WAIT_LIMIT_MS / 60_000} min: ${run.html_url}`);
    process.exit(1);
  }
  if (run) console.log(`Tests on main for ${sha.slice(0, 7)} ${run.status}, waiting: ${run.html_url}`);
  await sleep(POLL_MS);
}
