#!/usr/bin/env node
// prepublishOnly: publish only a committed, tagged state. npm packs the working tree, so an
// uncommitted change or an untagged HEAD would reach the registry as a version no commit carries.
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
if (dirty) fail(`working tree is not clean — commit or stash first:\n${dirty}`);

const tag = `v${version}`;
const tags = git('tag --points-at HEAD').split('\n').filter(Boolean);
if (!tags.includes(tag)) {
  fail(`HEAD is not tagged ${tag} (tags on HEAD: ${tags.join(', ') || 'none'}) — tag the release commit first`);
}

console.log(`publish-guard: ${tag} at ${git('rev-parse --short HEAD')}, clean tree`);
