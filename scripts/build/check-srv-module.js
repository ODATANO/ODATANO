// `node scripts/build/check-srv-module.js <gen/srv> <cap major>`, after `npm ci --omit=dev` there.
// Passes when the BTP module's production profile has its own database and login, and every service
// implementation and the server module load as JavaScript from its own node_modules.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || 'gen/srv');
const capMajor = Number(process.argv[3]);
process.chdir(dir);
process.env.NODE_ENV = 'production';

const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1); };
const local = (name) => require.resolve(name, { paths: [dir] });

let cds;
try { cds = require(local('@sap/cds')); } catch { fail(`@sap/cds is not installed in ${dir}`); }
if (!local('@sap/cds').startsWith(dir)) fail('@sap/cds resolves outside the module');
if (Number(String(cds.version).split('.')[0]) !== capMajor) fail(`the module runs @sap/cds ${cds.version}, the plugin is built for ${capMajor}`);
if (cds.env.requires.db?.kind !== 'hana') fail(`production database is ${cds.env.requires.db?.kind}, expected hana`);
const auth = cds.env.requires.auth?.kind;
if (auth !== 'xsuaa') fail(`production login is ${auth}, expected xsuaa`);

const csnFile = path.join(dir, 'srv', 'csn.json');
const csn = JSON.parse(fs.readFileSync(csnFile, 'utf8'));
const impls = Object.entries(csn.definitions).filter(([, d]) => d.kind === 'service' && d['@impl']);
if (!impls.length) fail('the compiled model names no service implementation');
for (const [name, def] of impls) {
  const file = path.resolve(path.dirname(csnFile), def['@impl']);
  let impl;
  try { impl = require(`${file}.js`); } catch (err) { fail(`${name}: ${def['@impl']}.js does not load: ${err.message}`); }
  if (typeof (impl.default ?? impl) !== 'function') fail(`${name}: ${def['@impl']}.js exports no service implementation`);
}
try { require(path.join(dir, 'srv', 'server.js')); } catch (err) { fail(`srv/server.js does not load: ${err.message}`); }
const ts = (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' ? []
    : e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [e.name] : []));
})(path.join(dir, 'srv'));
if (ts.length) fail(`the module still carries ${ts.length} TypeScript sources`);

console.log(`ok   the BTP module runs @sap/cds ${cds.version} on hana with xsuaa; ${impls.length} service implementations and srv/server.js load as JavaScript`);
process.exit(0);
