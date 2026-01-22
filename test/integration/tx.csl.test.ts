/**
 * CSL (Cardano Serialization Lib) Transaction Builder Integration Tests
 *
 * This test file runs the Cardano Transaction Service tests specifically with the CSL transaction builder.
 * CSL is Emurgo's cardano-serialization-lib for transaction building.
 *
 * Uses Koios backend with nock mocking for deterministic test results.
 */

// Configure environment to use only CSL transaction builder
process.env.TX_BUILDERS = 'csl';

// Import and run the transaction service test suite
import { createTxServiceTestSuite } from './tx-test-suite';

// Run transaction building tests with CSL
createTxServiceTestSuite({
  name: 'csl',
  enabled: true,
});
