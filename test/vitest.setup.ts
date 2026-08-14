/**
 * Vitest global setup (runs before every test file).
 *
 * Uses require() instead of imports: require is not hoisted, so the env vars
 * below are guaranteed to be set before any CDS module loads. @sap/cds is
 * externalized (node_modules CJS), so require() yields the same instance the
 * test files get via import.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

// Test detection for application code (was set in jest.config.cjs)
process.env.NODE_ENV = 'test';

// Disable telemetry plugin before any CDS modules load
// Must be set before @cap-js/telemetry/cds-plugin.js is required
process.env.NO_TELEMETRY = 'true';

// Clear SKIP_AUTO_INIT before every test file's top-level code runs.
// Vitest forks give each test file a fresh process, so cross-file leaks are
// structurally impossible — this guards against a developer's shell env (and
// any future isolate/parallelism tuning). Files that genuinely need it re-set
// it on their own top-level line, AFTER this setup file runs.
delete process.env.SKIP_AUTO_INIT;

// CAP resolves srv/*.ts service impls via native require at cds.test() boot;
// keep the on-the-fly compile hook that jest's setupFilesAfterEnv provided.
require('ts-node/register/transpile-only');

// Set privileged default user so tests pass @requires without auth headers
const cds = require('@sap/cds') as typeof import('@sap/cds');
cds.User.default = cds.User.Privileged as unknown as typeof cds.User.default;

/* eslint-disable no-console */

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleDebug = console.debug;
const originalConsoleError = console.error;
const originalConsoleDir = console.dir;

// Check if we should suppress logs (default: yes in test environment)
// Set LOG_LEVEL=debug to see all console output during tests
const suppressLogs = process.env.LOG_LEVEL !== 'debug' && (process.env.LOG_LEVEL === 'error' || process.env.NODE_ENV === 'test');

if (suppressLogs) {
  // Suppress all console output in tests
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
  console.error = () => {};
  console.dir = () => {};
}

// Restore console after all tests
// Note: App context shutdown is handled by individual test suites
afterAll(() => {
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.debug = originalConsoleDebug;
  console.error = originalConsoleError;
  console.dir = originalConsoleDir;
});
