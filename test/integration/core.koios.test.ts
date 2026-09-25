/**
 * Runs the shared CardanoService and error-handling suites against Koios only,
 * so no Blockfrost fallback can mask a failure.
 */

process.env.BACKENDS = 'koios';

if (!process.env.KOIOS_API_URL) {
  process.env.KOIOS_API_URL = 'https://preview.koios.rest/api/v1';
}

// Koios /pool_info on the free preview tier regularly exceeds the 15s CI default;
// 60s keeps the pool reads of this suite from timing out.
process.env.PRIMARY_TIMEOUT_MS = '60000';
process.env.FALLBACK_TIMEOUT_MS = '60000';

import { createBackendTestSuite } from './core-test-suite';
import { createErrorBackendSuite } from './error-handling.backend';

// Koios does not support metadata label queries.
createBackendTestSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor',
});

createErrorBackendSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor',
});
