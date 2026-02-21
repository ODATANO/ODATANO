/**
 * CSL (Cardano Serialization Lib) Transaction Builder Integration Tests
 *
 * This test file runs the Cardano Transaction Service tests specifically with the CSL transaction builder.
 * CSL is Emurgo's cardano-serialization-lib for transaction building.
 *
 * Uses Koios backend with nock mocking for deterministic test results.
 */

// Import and run the transaction service test suite
import { createTxServiceTestSuite } from './tx-test-suite';
import { createTxErrorTestSuite } from './tx-error-handling.builder';

// Run transaction building tests with CSL
createTxServiceTestSuite({
  backendName: 'koios',
  txBuilderName: 'csl'
});

// Run transaction error handling tests with CSL
createTxErrorTestSuite({
  backendName: 'koios',
  txBuilderName: 'csl'
});
