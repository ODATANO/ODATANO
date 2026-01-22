/**
 * Buildooor Transaction Builder Integration Tests
 *
 * This test file runs the Cardano Transaction Service tests specifically with the Buildooor transaction builder.
 * Buildooor is a transaction building library from HarmonicLabs.
 *
 * Uses Koios backend with nock mocking for deterministic test results.
 */

// Configure environment to use only Buildooor transaction builder
process.env.TX_BUILDERS = 'buildooor';

// Import and run the transaction service test suite
import { createTxServiceTestSuite } from './tx-test-suite';

// Run transaction building tests with Buildooor
createTxServiceTestSuite({
  name: 'buildooor',
  enabled: true,
});
