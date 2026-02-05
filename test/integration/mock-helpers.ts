/**
 * Mock Helpers
 * Nock-based HTTP mocking utilities for integration tests
 *
 * IMPORTANT: Only import this file in tests that need HTTP mocking (mock tests).
 * Real backend tests should only import from test-fixtures.ts to avoid
 * loading nock and its @mswjs/interceptors dependency.
 */
import nock from 'nock';
import { mockUtxosAdaOnly, mockProtocolParams, TEST_FIXTURES } from './test-fixtures';

export function setupKoiosMocks(utxos = mockUtxosAdaOnly) {
  // Mock /tip endpoint for backend initialization
  nock('https://preview.koios.rest')
    .get('/api/v1/tip')
    .reply(200, [{
      hash: 'test-block-hash',
      epoch_no: 100,
      abs_slot: 50000000,
      epoch_slot: 100000,
      block_no: 1000000,
      block_time: 1704067200,
    }])
    .persist();

  nock('https://preview.koios.rest')
    .get('/api/v1/cli_protocol_params')
    .reply(200, mockProtocolParams)
    .persist();

  nock('https://preview.koios.rest')
    .post('/api/v1/address_utxos', (body: any) => body._addresses !== undefined)
    .reply(200, utxos)
    .persist();
}

export function setupTxResponseMock() {
  nock('https://preview.koios.rest')
    .post('/api/v1/submit_tx')
    .reply(200, [{ tx_hash: TEST_FIXTURES.txHash }]);
}

export function setupUtxoMock(utxos: any[]) {
  // Clear existing mocks but keep nock active
  nock.cleanAll();

  // Re-enable network blocking after cleanAll (cleanAll doesn't reset this, but be safe)
  nock.disableNetConnect();
  nock.enableNetConnect(/localhost/);

  // Setup fresh mocks including /tip for backend initialization
  nock('https://preview.koios.rest')
    .get('/api/v1/tip')
    .reply(200, [{
      hash: 'test-block-hash',
      epoch_no: 100,
      abs_slot: 50000000,
      epoch_slot: 100000,
      block_no: 1000000,
      block_time: 1704067200,
    }])
    .persist();

  nock('https://preview.koios.rest')
    .get('/api/v1/cli_protocol_params')
    .reply(200, mockProtocolParams)
    .persist();

  nock('https://preview.koios.rest')
    .post('/api/v1/address_utxos', (body: any) => body._addresses !== undefined)
    .reply(200, utxos)
    .persist();
}

export function setupNocks() {
  nock.cleanAll();
  nock.restore();
  nock.activate();
  nock.disableNetConnect();
  nock.enableNetConnect(/localhost/);
}

export function teardownKoiosMocks() {
  nock.cleanAll();
  nock.restore();
  nock.enableNetConnect();
}

export function resetKoiosMocks() {
  nock.cleanAll();
  nock.restore();
  nock.enableNetConnect();  // Re-enable network to prevent circular reference errors from failed requests
}

// Re-export nock for direct use in tests
export { nock };
