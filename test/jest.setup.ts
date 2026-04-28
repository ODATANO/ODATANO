// Disable telemetry plugin before any CDS modules load
// Must be set before @cap-js/telemetry/cds-plugin.js is required
process.env.NO_TELEMETRY = 'true';

// Clear SKIP_AUTO_INIT before every test file's top-level code runs.
// Jest workers reuse OS processes across multiple test files; integration suites
// that need to skip auto-init (e.g. tx-test-suite, signing-services) set this at
// module load and never clean it up, so it leaks into subsequent files in the
// same worker. Files that genuinely need it will re-set it on their own
// top-level line, AFTER this setup file runs.
delete process.env.SKIP_AUTO_INIT;

/**
 * Jest Setup File
 * - Set privileged default user so tests pass @requires: 'authenticated-user' without auth headers
 * - Suppress console output during tests
 */
import cds from '@sap/cds';
cds.User.default = cds.User.Privileged as unknown as cds.User;

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
