/**
 * Runs the transaction service and transaction error suites with the Buildooor
 * builder against a nock-mocked Koios backend.
 */

import { createTxServiceTestSuite } from './tx-test-suite';
import { createTxErrorTestSuite } from './tx-error-handling.builder';

createTxServiceTestSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor'
});

createTxErrorTestSuite({
  backendName: 'koios',
  txBuilderName: 'buildooor'
});