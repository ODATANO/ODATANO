/**
 * The BTP module generator: its package.json carries the application dependencies and the root
 * overrides, and gen/srv keeps only compiled JavaScript, refusing a build that has none.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { srvPackage, keepCompiledOnly, APPLICATION_PACKAGES } from '../../scripts/build/gen-srv-package.js';

const root = {
  name: '@odatano/core', version: '2.0.0', description: 'x', imports: { '#cds-models/*': './@cds-models/*/index.js' },
  dependencies: { bech32: '^2.0.0' }, optionalDependencies: { pkcs11js: '^2.1.6' }, overrides: { ws: '7.5.11' }, cds: { log: { mask_headers: ['/token/i'] } },
  engines: { node: '>=22.5' }, scripts: { prepare: 'npm run build:package' },
};
const lock = { packages: Object.fromEntries(APPLICATION_PACKAGES.map((n: string, i: number) => [`node_modules/${n}`, { version: `1.0.${i}` }])) };
const cdsrc = { requires: { '[production]': { db: { kind: 'hana' }, auth: 'xsuaa' } } };

describe('srvPackage', () => {
  it('pins the application packages to the lockfile and carries the root overrides, but no root scripts', () => {
    const pkg = srvPackage(root, lock, cdsrc);
    expect(pkg.dependencies).toEqual({ bech32: '^2.0.0', '@sap/cds': '1.0.0', '@cap-js/hana': '1.0.1', '@sap/xssec': '1.0.2' });
    expect(pkg.overrides).toEqual({ ws: '7.5.11' });
    expect(pkg.cds.requires).toEqual({ db: { kind: 'hana' }, auth: 'xsuaa' });
    expect(pkg.scripts).toEqual({ start: 'cds-serve' });
  });

  it('carries the optional HSM binding and closed Node.js lines the CF buildpack accepts without a warning', () => {
    const pkg = srvPackage(root, lock, cdsrc);
    expect(pkg.optionalDependencies).toEqual({ pkcs11js: '^2.1.6' });
    expect(pkg.engines).toEqual({ node: '^22.5.0 || ^24.0.0' });
    expect(() => srvPackage({ ...root, engines: { node: '>=24' } }, lock, cdsrc)).toThrow(/does not cover/);
  });

  it('refuses a configuration without a production database and login', () => {
    expect(() => srvPackage(root, lock, { requires: {} })).toThrow(/\[production\] db and auth/);
  });
});

describe('keepCompiledOnly', () => {
  let dir: string;
  const write = (file: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), ''); };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-srv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('removes the TypeScript sources and the plugin entry, keeps JavaScript and declarations', () => {
    for (const f of ['srv/a.ts', 'srv/a.js', 'srv/a.d.ts', 'srv/x/b.ts', 'srv/x/b.js', 'cds-plugin.js']) write(f);
    expect(keepCompiledOnly(dir)).toBe(2);
    const left = ['srv/a.js', 'srv/a.d.ts', 'srv/x/b.js'];
    for (const f of left) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    for (const f of ['srv/a.ts', 'srv/x/b.ts', 'cds-plugin.js']) expect(fs.existsSync(path.join(dir, f))).toBe(false);
  });

  it('refuses a build whose sources were not compiled', () => {
    for (const f of ['srv/a.ts', 'srv/a.js', 'srv/x/b.ts']) write(f);
    expect(() => keepCompiledOnly(dir)).toThrow(/no JavaScript for 1 sources .*b\.ts/);
    expect(fs.existsSync(path.join(dir, 'srv/a.ts'))).toBe(true);
  });
});
