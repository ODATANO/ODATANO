import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // build:plugin leaves compiled `.js` twins next to every `.ts` source.
        // Prefer `.ts`, otherwise the suite would test the last build instead of the sources.
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
        // Deletes the compiled `.js` twins first. CAP resolves service impls itself and prefers `.js`.
        globalSetup: ['test/vitest.globalSetup.ts'],
        // Fork per test file; forks are killed after the run, so open handles cannot hang it.
        pool: 'forks',
        // At most six forks, and one core stays free. More forks starve the timing-sensitive tests.
        maxWorkers: Math.min(6, Math.max(os.availableParallelism() - 1, 1)),
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
                    // Integration suites call live providers, and concurrent boots trip their rate limits.
                    fileParallelism: false
                }
            }
        ]
    }
});
