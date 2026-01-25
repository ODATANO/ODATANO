/**
 * Jest Setup File
 * Suppress console output during tests
 */

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleDebug = console.debug;
const originalConsoleError = console.error;
const originalConsoleDir = console.dir;

// Check if we should suppress logs (default: yes in test environment)
const suppressLogs = process.env.LOG_LEVEL === 'error' || process.env.NODE_ENV === 'test';

if (suppressLogs) {
  // Suppress all console output in tests
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
  console.error = () => {};
  console.dir = () => {};
}

// Restore console after all tests (for cleanup)
afterAll(() => {
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.debug = originalConsoleDebug;
  console.error = originalConsoleError;
  console.dir = originalConsoleDir;
});
