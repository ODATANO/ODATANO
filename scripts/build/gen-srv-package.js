/**
 * After `cds build --production`: turns gen/srv into the BTP module.
 *
 * The plugin's own package.json ships to npm, so it carries no application configuration and names
 * CAP only as a peer. The BTP module is an application: it gets CAP, the HANA adapter and xssec as
 * dependencies, the production configuration of .cdsrc.json, and versions pinned to package-lock.json.
 * It runs the compiled JavaScript of srv/; the TypeScript sources do not ship.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const semver = require('semver');

const projectRoot = path.join(__dirname, '..', '..');

// The Node.js lines CI tests. The CF buildpack installs the newest version a range admits and warns
// on an open one (`>=`), so the module names closed lines inside the plugin's own engines range.
const CF_NODE_RANGE = '^22.5.0 || ^24.0.0';

/** engines.node of the BTP module: the tested lines, refused when the plugin's range does not hold them. */
function cfNodeRange(rootRange) {
  if (!rootRange || !semver.subset(CF_NODE_RANGE, rootRange)) {
    throw new Error(`engines.node ${rootRange} of package.json does not cover ${CF_NODE_RANGE}, the lines the BTP module runs on`);
  }
  return CF_NODE_RANGE;
}

/** Packages the BTP module needs beside the plugin's runtime dependencies. */
const APPLICATION_PACKAGES = ['@sap/cds', '@cap-js/hana', '@sap/xssec'];

/** Exact version of a package in the root lockfile. */
function lockedVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} is not in package-lock.json`);
  return version;
}

/** The package.json of the BTP module, built from the root package.json, lockfile and .cdsrc.json. */
function srvPackage(root, lock, cdsrc) {
  const production = cdsrc.requires?.['[production]'];
  if (!production?.db || !production?.auth) throw new Error('.cdsrc.json has no [production] db and auth');
  const dependencies = { ...root.dependencies };
  for (const name of APPLICATION_PACKAGES) dependencies[name] = lockedVersion(lock, name);
  return {
    name: root.name,
    version: root.version,
    description: root.description,
    imports: root.imports,
    dependencies,
    // pkcs11js for HSM signing; npm skips it where it does not build
    ...(root.optionalDependencies ? { optionalDependencies: root.optionalDependencies } : {}),
    overrides: root.overrides,
    cds: { ...root.cds, requires: { db: production.db, auth: production.auth } },
    engines: { ...root.engines, node: cfNodeRange(root.engines?.node) },
    scripts: { start: 'cds-serve' },
  };
}

// Writes package.json and a lockfile into `dir`. The root lockfile goes in first, so npm keeps its
// resolutions for the packages both trees share; `npm ci` then installs exactly that tree.
function writeSrvPackage(dir, pkg, rootLock = path.join(projectRoot, 'package-lock.json')) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.copyFileSync(rootLock, path.join(dir, 'package-lock.json'));
  execFileSync('npm', ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** Every file below `dir`, recursively. */
function filesBelow(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' ? [] : filesBelow(p)) : [p];
  });
}

/** A TypeScript source, not a declaration. */
const isTsSource = (file) => file.endsWith('.ts') && !file.endsWith('.d.ts');

// Keeps only the compiled JavaScript of gen/srv/srv. Throws when a source has no compiled twin,
// which means `tsc -p tsconfig.build.json` did not run before `cds build`.
function keepCompiledOnly(genSrv) {
  const sources = filesBelow(path.join(genSrv, 'srv')).filter(isTsSource);
  const missing = sources.filter((f) => !fs.existsSync(f.replace(/\.ts$/, '.js'))).map((f) => path.relative(genSrv, f));
  if (missing.length) {
    throw new Error(`gen/srv has no JavaScript for ${missing.length} sources (${missing.slice(0, 3).join(', ')}…). Run npx tsc -p tsconfig.build.json before cds build`);
  }
  for (const f of sources) fs.unlinkSync(f);
  // the plugin entry of the npm package; the BTP module is the application itself
  fs.rmSync(path.join(genSrv, 'cds-plugin.js'), { force: true });
  return sources.length;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
}

/** Turns a `cds build` output folder gen/srv into the BTP module. */
function finishSrvModule(genSrv) {
  if (!fs.existsSync(genSrv)) throw new Error(`${genSrv} does not exist, run cds build first`);
  const compiled = keepCompiledOnly(genSrv);
  const pkg = srvPackage(readJson('package.json'), readJson('package-lock.json'), readJson('.cdsrc.json'));
  writeSrvPackage(genSrv, pkg);
  // #cds-models/* imports resolve inside gen/srv
  const srcModels = path.join(projectRoot, '@cds-models');
  if (!fs.existsSync(srcModels)) throw new Error('@cds-models/ not found, run npm run cds:types first');
  fs.cpSync(srcModels, path.join(genSrv, '@cds-models'), { recursive: true });
  return { compiled, dependencies: Object.keys(pkg.dependencies).length };
}

module.exports = { srvPackage, writeSrvPackage, keepCompiledOnly, finishSrvModule, readJson, APPLICATION_PACKAGES };

if (require.main === module) {
  try {
    const { compiled, dependencies } = finishSrvModule(path.join(projectRoot, 'gen', 'srv'));
    console.log('OK: gen/srv runs %d compiled modules, package.json and package-lock.json written (%d dependencies)', compiled, dependencies);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
