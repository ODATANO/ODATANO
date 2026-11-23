#!/usr/bin/env node
// The login package that ships reads every option the image hands it (ODATANO_TRUST_PROXY): the
// package.json range admits no release before MIN, the lockfile pins one, and that one is installed.
// Run by scripts/release-check.mjs and by release.yml. Exits 1 with the reason.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import semver from 'semver';

export const MIN = '0.2.0';
const NAME = '@odatano/cap-auth';

/** The reason the shipped login package falls short, or null. */
export function loginPackageProblem(pkg, lock, installed) {
  const range = pkg.dependencies?.[NAME];
  const locked = lock.packages?.[`node_modules/${NAME}`]?.version;
  if (!range || !semver.validRange(range) || semver.lt(semver.minVersion(range), MIN)) return `package.json allows ${NAME} ${range}; it must start at ${MIN}`;
  if (!locked || semver.lt(locked, MIN)) return `package-lock.json pins ${NAME} ${locked}; it must be ${MIN} or later`;
  if (typeof installed?.trustedProxyCount !== 'function') return `the installed ${NAME} predates trustProxy; run npm ci`;
  return null;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const problem = loginPackageProblem(pkg, lock, createRequire(import.meta.url)(NAME));
  if (problem) {
    console.error(`FAIL ${problem}`);
    process.exit(1);
  }
  console.log(`ok   ${NAME} ${lock.packages[`node_modules/${NAME}`].version} (${pkg.dependencies[NAME]}) reads trustProxy`);
}
