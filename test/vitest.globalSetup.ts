/**
 * Removes the compiled `.js` twins before any test file runs.
 *
 * `build:plugin` compiles in place (the published package resolves CDS `@impl`
 * to `<package-root>/srv/*.js`), so after a build every `.ts` source has a `.js`
 * sibling. CAP loads service implementations itself — `@(impl: './cardano-service')`
 * goes through `require.resolve()` in `@sap/cds/lib/srv/factory.js`, and Node
 * tries `.js` before the `.ts` that ts-node appends. So with a twin present,
 * `cds.test()` boots the LAST BUILD, not the sources under test: a source fix
 * looks broken, and broken sources look fixed. `resolve.extensions` in
 * vitest.config.ts cannot prevent this — it only governs imports vite resolves.
 *
 * The npm scripts already guard this via their `pretest*` hooks; this makes a
 * bare `npx vitest run <file>` behave the same.
 *
 * Keep the glob in sync with the `clean` script in package.json.
 */
import { globSync, unlinkSync } from 'node:fs';

export default function setup(): void {
  const files = globSync('{srv,db,src}/**/*.{js,js.map,d.ts,d.ts.map}').filter(
    (f) => !f.includes('node_modules')
  );
  for (const f of files) unlinkSync(f);
  if (files.length) {
    // eslint-disable-next-line no-console -- one-line run banner, mirrors the `clean` script
    console.log(`[vitest] removed ${files.length} compiled artefact(s) — tests run against the TypeScript sources`);
  }
}
