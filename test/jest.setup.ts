/**
 * Jest Setup File
 * Suppress console output during tests
 */

/* eslint-disable no-console */

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

// Restore console and cleanup app context after all tests
afterAll(async () => {
  // Shutdown app context if it exists (to close backend connections)
  try {
    const { shutdownAppContext } = await import('../srv/server');
    await shutdownAppContext();
  } catch {
    // Ignore if server module not imported or context doesn't exist
  }

  // Also shutdown the legacy singleton if it exists
  try {
    const { cardanoClient } = await import('../srv/blockchain/cardano-client');
    if (cardanoClient && typeof cardanoClient.shutdown === 'function') {
      await cardanoClient.shutdown();
    }
  } catch {
    // Ignore if not initialized or already shut down
  }

  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.debug = originalConsoleDebug;
  console.error = originalConsoleError;
  console.dir = originalConsoleDir;
});
