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

// Import and run the shared test suite
import { createBackendTestSuite } from './core-test-suite';

// Run tests with Koios backend
// Note: Some features like metadata label queries are not supported by Koios
createBackendTestSuite({
  name: 'koios',
  enabled: true,
  // Koios limitations on preview network
  skipTests: [
    'MetaData', // Koios does not support metadata for preview network
  ],
});
