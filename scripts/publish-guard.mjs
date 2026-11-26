#!/usr/bin/env node
// prepublishOnly: publish only a committed, tagged state whose CI passed. npm packs the working tree,
// so an uncommitted change or an untagged HEAD would reach the registry as a version no commit carries.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`publish-guard: ${message}`);
  process.exit(1);
};

// `npm publish --dry-run` runs this hook too; it publishes nothing.
if (process.env.npm_config_dry_run === 'true') process.exit(0);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const dirty = git('status --porcelain');
if (dirty) fail(`working tree is not clean. Commit or stash first:\n${dirty}`);

const tag = `v${version}`;
const tags = git('tag --points-at HEAD').split('\n').filter(Boolean);
if (!tags.includes(tag)) {
  fail(`HEAD is not tagged ${tag} (tags on HEAD: ${tags.join(', ') || 'none'}). Tag the release commit first`);
}

// The release run must have passed on this exact commit. It requires the test suite green on it,
// besides the package checks, the image audit and the image smoke.
const REQUIRED_WORKFLOWS = ['Release'];
const sha = git('rev-parse HEAD');
let runs;
try {
  runs = JSON.parse(execSync(`gh run list --commit ${sha} --limit 50 --json workflowName,status,conclusion`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (err) {
  const detail = String(err?.stderr || err?.message || err).trim();
  fail(`cannot read the CI runs of HEAD with the GitHub CLI (gh): ${detail}`);
}
for (const workflow of REQUIRED_WORKFLOWS) {
  const latest = runs.find((r) => r.workflowName === workflow);
  if (!latest) fail(`no "${workflow}" run for ${sha.slice(0, 7)}. Push the commit and the tag, then wait for CI`);
  if (latest.status !== 'completed') fail(`"${workflow}" is still ${latest.status} for ${sha.slice(0, 7)}`);
  if (latest.conclusion !== 'success') fail(`"${workflow}" ended with ${latest.conclusion} for ${sha.slice(0, 7)}`);
}

console.log(`publish-guard: ${tag} at ${git('rev-parse --short HEAD')}, clean tree, ${REQUIRED_WORKFLOWS.join(' and ')} green`);
