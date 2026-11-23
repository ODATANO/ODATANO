/**
 * The release gate on the shipped login package: range, lockfile and installed copy must all be a
 * release that reads trustProxy, so a local install of a newer copy cannot hide an old lockfile.
 */
import { loginPackageProblem, MIN } from '../../scripts/check-login-package.mjs';

const pkg = (range: string) => ({ dependencies: { '@odatano/cap-auth': range } });
const lock = (version: string) => ({ packages: { 'node_modules/@odatano/cap-auth': { version } } });
const reads = { trustedProxyCount: () => 0 };

describe('loginPackageProblem', () => {
  it('passes a range, lockfile and installed copy at or after the minimum', () => {
    expect(MIN).toBe('0.2.0');
    expect(loginPackageProblem(pkg('^0.2.0'), lock('0.2.0'), reads)).toBeNull();
    expect(loginPackageProblem(pkg('^0.3.1'), lock('0.3.4'), reads)).toBeNull();
  });

  it('refuses a range that admits an older release, even when a newer copy is installed', () => {
    expect(loginPackageProblem(pkg('^0.1.0'), lock('0.2.0'), reads)).toMatch(/allows @odatano\/cap-auth \^0\.1\.0/);
    expect(loginPackageProblem(pkg('>=0.1.0'), lock('0.2.0'), reads)).toMatch(/must start at 0\.2\.0/);
  });

  it('refuses a lockfile that pins an older release', () => {
    expect(loginPackageProblem(pkg('^0.2.0'), lock('0.1.0'), reads)).toMatch(/pins @odatano\/cap-auth 0\.1\.0/);
    expect(loginPackageProblem(pkg('^0.2.0'), { packages: {} }, reads)).toMatch(/pins @odatano\/cap-auth undefined/);
  });

  it('refuses an installed copy without trustedProxyCount', () => {
    expect(loginPackageProblem(pkg('^0.2.0'), lock('0.2.0'), {})).toMatch(/run npm ci/);
  });
});
