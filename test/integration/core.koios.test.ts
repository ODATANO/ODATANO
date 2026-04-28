/**
 * Koios Backend Integration Tests
 * 
 * This test file runs the CardanoService integration tests specifically with the Koios backend.
 * Koios is a public API that's always available, making it ideal for testing without external dependencies.
 * It ensures that Koios is tested independently without fallback from Blockfrost masking failures.
 */

// Configure environment to use only Koios backend
process.env.BACKENDS = 'koios';

// Ensure Koios API URL is configured
if (!process.env.KOIOS_API_URL) {
  process.env.KOIOS_API_URL = 'https://preview.koios.rest/api/v1';
}

// Koios's /pool_info endpoint on the free preview tier reliably takes longer
// than tighter timeout budgets allow. Force the backend timeout to 60s for
// this file regardless of what the env / CI workflow sets globally — the CI
// workflow's 15s default is fine for Blockfrost but consistently fails Koios
// pool reads with "All backends failed: Backend timeout (timeout after 15000ms)".
// This only affects the Koios suite; other test files are untouched.
process.env.PRIMARY_TIMEOUT_MS = '60000';
process.env.FALLBACK_TIMEOUT_MS = '60000';

// Import and run the shared test suite
import { createBackendTestSuite } from './core-test-suite';
import { createErrorBackendSuite } from './error-handling.backend';

// Run tests with Koios backend
// Note: Some features like metadata label queries are not supported by Koios
createBackendTestSuite({
  backendName: 'koios',
  txBuilderName: 'csl',
});

// Also include backend-focused error handling suite in the same file
createErrorBackendSuite({
  backendName: 'koios',
  txBuilderName: 'csl',
});
