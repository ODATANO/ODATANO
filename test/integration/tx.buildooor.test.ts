/**
 * Buildooor Transaction Builder Integration Tests
 *
 * This test file runs the Cardano Transaction Service tests specifically with the Buildooor transaction builder.
 * Buildooor is a transaction building library from HarmonicLabs.
 *
 * Uses Koios backend with nock mocking for deterministic test results.
 */

// Import and run the transaction service test suite
import { createTxServiceTestSuite } from './tx-test-suite';
import { createTxErrorTestSuite } from './tx-error-handling.builder';

// Run transaction building tests with Buildooor
createTxServiceTestSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor'
});

// Run transaction error handling tests with Buildooor
createTxErrorTestSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor'
});