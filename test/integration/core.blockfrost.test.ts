/**
 * Runs the shared CardanoService and error-handling suites against Blockfrost only,
 * so no Koios fallback can mask a failure.
 */

process.env.BACKENDS = 'blockfrost';

import { createBackendTestSuite } from './core-test-suite';
import { createErrorBackendSuite } from './error-handling.backend';

if (process.env.BLOCKFROST_API_KEY) {
  createBackendTestSuite({
    backendName: 'blockfrost',
    txBuilderName: 'buildooor',
  });
  createErrorBackendSuite({
    backendName: 'blockfrost',
    txBuilderName: 'buildooor',
  });
}
