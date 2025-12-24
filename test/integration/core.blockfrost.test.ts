/**
 * Blockfrost Backend Integration Tests
 * 
 * This test file runs the CardanoService integration tests specifically only with the Blockfrost backend.
 * It ensures that Blockfrost is tested independently without fallback to Koios masking failures.
 */

// Configure environment to use only Blockfrost backend
process.env.BACKENDS = 'blockfrost';

// Import and run the shared test suite
import { createBackendTestSuite } from './core-test-suite';
import { createErrorBackendSuite } from './error-handling.backend';

// Run tests only if Blockfrost API key is configured
if (process.env.BLOCKFROST_KEY) {
  createBackendTestSuite({
    name: 'blockfrost',
    enabled: true,
  });
  // Also include backend-focused error handling suite
  createErrorBackendSuite({
    name: 'blockfrost',
    enabled: true,
  });
}
