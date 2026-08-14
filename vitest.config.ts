import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // The plugin build (build:plugin) compiles in place, so stale `.js` twins
        // sit next to every `.ts` source. Prefer `.ts` for extensionless imports;
        // otherwise the suite would silently exercise the last build instead of
        // the sources.
        extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
        alias: [
            // ESM-style relative imports with a `.js` extension → strip so the
            // `.ts` source wins over its stale compiled twin.
            { find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' },
            // cds-typer models; mirrors the package.json `#cds-models/*` imports
            // map. The generated models ship as index.js + index.d.ts.
            {
                find: /^#cds-models\/(.*)$/,
                replacement: path.resolve(__dirname, '@cds-models') + '/$1/index.js'
            }
        ]
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['test/vitest.setup.ts'],
        // Fork per test file; forks are killed after the run, which covers the
        // open handles that used to require jest's --forceExit.
        pool: 'forks',
        testTimeout: 120000,
        hookTimeout: 120000,
        slowTestThreshold: 120000,
        coverage: {
            provider: 'v8',
            reportsDirectory: 'coverage',
            include: ['srv/**/*.ts'],
            exclude: ['srv/**/*.d.ts'],
            thresholds: { branches: 75, functions: 75, lines: 75 }
        },
        projects: [
            {
                extends: true,
                test: { name: 'unit', include: ['test/unit/**/*.test.ts'] }
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['test/integration/**/*.test.ts'],
                    // Integration suites boot cds.test() against live Blockfrost/
                    // Koios — concurrent boots trip their rate limits (the reason
                    // for jest's maxWorkers: 1). One file at a time, but each
                    // still gets its own fresh fork.
                    fileParallelism: false
                }
            }
        ]
    }
});
