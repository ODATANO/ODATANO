/**
 * Buildooor Transaction Builder Integration Tests
 *
 * This test file runs the Cardano Transaction Service tests specifically with the Buildooor transaction builder.
 * Buildooor is a transaction building library from HarmonicLabs.
 *
 * Uses Koios backend with nock mocking for deterministic test results.
 */

// Configure environment BEFORE any imports to ensure correct backend initialization
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

// Import and run the transaction service test suite
import { createTxServiceTestSuite } from './tx-test-suite';
import { createTxErrorTestSuite } from './tx-error-handling.builder';

// Run transaction building tests with Buildooor
createTxServiceTestSuite({
  name: 'buildooor',
  enabled: true,
});

// Run transaction error handling tests with Buildooor
createTxErrorTestSuite({
  name: 'buildooor',
  enabled: true,
});