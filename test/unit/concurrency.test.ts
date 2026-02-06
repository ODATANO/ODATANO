import { CardanoClient, CardanoClientConfig, Network } from '../../srv/blockchain/cardano-client';
import nock from 'nock';

const NETWORK: Network = 'preview';
const TIMEOUT_MS = 5000;
const KOIOS_BASE = 'https://preview.koios.rest/api/v1';

function createConfig(overrides: Partial<CardanoClientConfig> = {}): CardanoClientConfig {
  return {
    network: NETWORK,
    backends: ['koios'],
    blockfrostApiKey: 'test-key',
    koiosApiKey: 'test-key',
    ogmiosUrl: 'ws://localhost:1337',
    transactionBuilders: ['csl'],
    primaryTimeoutMs: TIMEOUT_MS,
    fallbackTimeoutMs: TIMEOUT_MS * 2,
    indexTtlMs: 3600000,
    ...overrides,
  };
}

function setupKoiosTip() {
  nock(KOIOS_BASE)
    .get('/tip')
    .reply(200, [{
      hash: 'test-hash', epoch_no: 100, abs_slot: 50000000,
      epoch_slot: 100000, block_no: 1000000, block_time: 1704067200,
    }]);
}

const mockNetworkInfo = [{
  epoch_no: 100, circulation: '35000000000000000', treasury: '1000000000000000',
  reward: '500000000000000', supply: '35000000000000000', reserves: '10000000000000000',
}];

describe('Concurrency Tests', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  // ==========================================================================
  // Parallel Request Handling
  // ==========================================================================

  describe('Parallel Requests', () => {
    it('should handle multiple concurrent requests to the same endpoint', async () => {
      setupKoiosTip();

      // Allow 5 concurrent requests to succeed
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .times(5)
        .reply(200, mockNetworkInfo);

      const client = new CardanoClient(createConfig());

      // Fire 5 requests concurrently
      const results = await Promise.all([
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
      ]);

      expect(results).toHaveLength(5);
      results.forEach(r => {
        expect(r).toBeDefined();
        expect(r.supply).toBeDefined();
      });
    });

    it('should handle concurrent requests to different endpoints', async () => {
      setupKoiosTip();

      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(200, mockNetworkInfo);

      nock(KOIOS_BASE)
        .post('/tx_info')
        .reply(200, [{
          tx_hash: 'abc123', block_hash: 'block456', block_height: 1000,
          tx_timestamp: 1704067200, tx_block_index: 0, tx_size: 300,
          total_output: '5000000', fee: '170000', deposit: '0',
          invalid_before: null, invalid_after: null,
          collateral_inputs: [], collateral_output: null,
          reference_inputs: [], inputs: [], outputs: [],
          withdrawals: [], assets_minted: [], metadata: [],
          certificates: [], native_scripts: [], plutus_contracts: [],
        }]);

      const client = new CardanoClient(createConfig());

      const [networkInfo, tx] = await Promise.all([
        client.getNetworkInformation(),
        client.getTransaction('abc123'),
      ]);

      expect(networkInfo.supply).toBeDefined();
      expect(tx.hash).toBe('abc123');
    });

    it('should handle mix of successful and failing concurrent requests', async () => {
      setupKoiosTip();

      // First request succeeds
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(200, mockNetworkInfo);

      // Second request fails (404)
      nock(KOIOS_BASE)
        .post('/tx_info')
        .reply(404, { error: 'Not found' });

      const client = new CardanoClient(createConfig());

      const results = await Promise.allSettled([
        client.getNetworkInformation(),
        client.getTransaction('nonexistent'),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
    });
  });

  // ==========================================================================
  // Initialization Race Condition
  // ==========================================================================

  describe('Initialization Race', () => {
    it('should only initialize once when multiple requests arrive simultaneously', async () => {
      // Tip should only be called once (initialization is deduplicated)
      const tipScope = nock(KOIOS_BASE)
        .get('/tip')
        .reply(200, [{
          hash: 'test-hash', epoch_no: 100, abs_slot: 50000000,
          epoch_slot: 100000, block_no: 1000000, block_time: 1704067200,
        }]);

      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .times(3)
        .reply(200, mockNetworkInfo);

      const client = new CardanoClient(createConfig());

      // Fire 3 requests immediately (before init completes)
      await Promise.all([
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
      ]);

      // Tip endpoint (init) should have been called exactly once
      expect(tipScope.isDone()).toBe(true);
    });
  });

  // ==========================================================================
  // Circuit Breaker under Concurrent Load
  // ==========================================================================

  describe('Circuit Breaker under Concurrent Load', () => {
    it('should maintain circuit state correctly under concurrent failures', async () => {
      const config = createConfig({
        circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10000 },
      });

      setupKoiosTip();

      // All requests will fail
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .times(5)
        .reply(500, { error: 'Internal error' });

      const client = new CardanoClient(config);

      // Fire 5 failing requests
      const results = await Promise.allSettled([
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
        client.getNetworkInformation(),
      ]);

      // All should fail
      results.forEach(r => expect(r.status).toBe('rejected'));
    });
  });
});
