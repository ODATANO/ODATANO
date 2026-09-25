/**
 * Nock-based HTTP mocks for Koios integration tests. Import only in mock tests;
 * real-backend tests import test-fixtures.ts to avoid loading nock.
 */
import nock from 'nock';
import { mockUtxosAdaOnly, mockProtocolParams, TEST_FIXTURES, SCRIPT_UTXO_ADDRESS, scriptUtxoKoiosEntry } from './test-fixtures';

// The script address answers with its live script UTxO so the BuildPlutusSpendTransaction
// unspent pre-check passes; every other address gets the configured sender UTxOs.
function addressUtxosReply(utxos: any[]) {
  return function (_uri: string, body: any) {
    if (Array.isArray(body?._addresses) && body._addresses.includes(SCRIPT_UTXO_ADDRESS)) {
      return [scriptUtxoKoiosEntry];
    }
    return utxos;
  };
}

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
    .reply(200, addressUtxosReply(utxos))
    .persist();
}

export function setupTxResponseMock() {
  nock('https://preview.koios.rest')
    .post('/api/v1/submittx')
    .reply(200, TEST_FIXTURES.txHash);
}

export function setupUtxoMock(utxos: any[]) {
  nock.cleanAll();

  // cleanAll() leaves net-connect blocking untouched; re-apply it anyway.
  nock.disableNetConnect();
  nock.enableNetConnect(/localhost/);

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
    .reply(200, addressUtxosReply(utxos))
    .persist();
}

export function setupTxInfoMock(txInfoResponse: any[]) {
  nock('https://preview.koios.rest')
    .post('/api/v1/tx_info', (body: any) => body._tx_hashes !== undefined)
    .reply(200, txInfoResponse)
    .persist();
}

export function setupNocks() {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/localhost/);
}

export function teardownKoiosMocks() {
  nock.cleanAll();
  nock.enableNetConnect();
}

export function resetKoiosMocks() {
  nock.cleanAll();
  nock.enableNetConnect();
}

export { nock };
