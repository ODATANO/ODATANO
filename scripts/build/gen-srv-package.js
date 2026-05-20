/**
 * Post-CDS-build: generates a clean production package.json for gen/srv/
 *
 * Why: cds build --production copies the root package.json verbatim.
 * Its cleanup only strips workspace:/file: references from devDependencies.
 * Since ODATANO uses normal semver versions, nothing gets stripped.
 * This script creates the minimal production package.json that CF needs.
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const root = require(path.join(projectRoot, 'package.json'));
const genSrvPkg = path.join(projectRoot, 'gen', 'srv', 'package.json');

if (!fs.existsSync(path.dirname(genSrvPkg))) {
  console.error('ERROR: gen/srv/ does not exist — run cds build first');
  process.exit(1);
}

const srvPkg = {
  name: root.name,
  version: root.version,
  description: root.description,
  imports: root.imports,
  dependencies: {
    ...root.dependencies,
    "@cap-js/hana": "^2",
    "@sap/xssec": "^4",
    "passport": "^0.7.0"
  },
  cds: root.cds,
  engines: { node: ">=20" },
  scripts: { start: "cds-serve" }
};

fs.writeFileSync(genSrvPkg, JSON.stringify(srvPkg, null, 2) + '\n');
console.log('OK: gen/srv/package.json generated (%d dependencies)', Object.keys(srvPkg.dependencies).length);

// Copy @cds-models/ to gen/srv/ for #cds-models/* imports
const srcModels = path.join(projectRoot, '@cds-models');
const destModels = path.join(projectRoot, 'gen', 'srv', '@cds-models');
if (fs.existsSync(srcModels)) {
  fs.cpSync(srcModels, destModels, { recursive: true });
  console.log('OK: @cds-models/ copied to gen/srv/');
} else {
  console.error('WARN: @cds-models/ not found — run cds-typer first');
}
