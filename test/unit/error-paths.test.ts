import { CardanoClient, CardanoClientConfig, Network } from '../../srv/blockchain/cardano-client';
import { AllBackendsFailedError } from '../../srv/utils/errors';
import nock from 'nock';

const NETWORK: Network = 'preview';
const TIMEOUT_MS = 2000;
const KOIOS_BASE = 'https://preview.koios.rest/api/v1';
const BLOCKFROST_BASE = 'https://cardano-preview.blockfrost.io';

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

function setupBlockfrostHealth() {
  nock(BLOCKFROST_BASE)
    .get('/api/v0/blocks/latest')
    .reply(200, { hash: 'test-block-hash', height: 1000000 });
}

describe('Error Path Tests', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  // ==========================================================================
  // 503 - Provider Unavailable with Failover
  // ==========================================================================

  describe('503 Provider Unavailable – Failover', () => {
    it('should failover from blockfrost 503 to koios', async () => {
      // Blockfrost init succeeds but network query returns 503
      setupBlockfrostHealth();
      nock(BLOCKFROST_BASE)
        .get('/api/v0/network')
        .reply(503, { error: 'Service Unavailable' });

      // Koios succeeds
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(200, [{
          epoch_no: 100, circulation: '35000000000000000', treasury: '1000000000000000',
          reward: '500000000000000', supply: '35000000000000000', reserves: '10000000000000000',
        }]);

      const client = new CardanoClient(createConfig({ backends: ['blockfrost', 'koios'] }));
      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
      expect(result.supply).toBeDefined();
    });

    it('should throw AllBackendsFailedError when all backends return 503', async () => {
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(503, { error: 'Service Unavailable' });

      const client = new CardanoClient(createConfig({ backends: ['koios'] }));
      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
    });
  });

  // ==========================================================================
  // 429 - Rate Limiting
  // ==========================================================================

  describe('429 Rate Limiting', () => {
    it('should failover on 429 rate limit from first backend', async () => {
      // Blockfrost returns 429
      setupBlockfrostHealth();
      nock(BLOCKFROST_BASE)
        .get('/api/v0/network')
        .reply(429, { error: 'Rate limit exceeded' }, { 'retry-after': '1' });

      // Koios succeeds
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(200, [{
          epoch_no: 100, circulation: '35000000000000000', treasury: '1000000000000000',
          reward: '500000000000000', supply: '35000000000000000', reserves: '10000000000000000',
        }]);

      const client = new CardanoClient(createConfig({ backends: ['blockfrost', 'koios'] }));
      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
    });

    it('should throw AllBackendsFailedError when all backends rate-limited', async () => {
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(429, { error: 'Rate limit exceeded' });

      const client = new CardanoClient(createConfig({ backends: ['koios'] }));
      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
    });
  });

  // ==========================================================================
  // Timeout Failover
  // ==========================================================================

  describe('Timeout Failover', () => {
    it('should failover when first backend times out', async () => {
      // Blockfrost init succeeds but hangs on query
      setupBlockfrostHealth();
      nock(BLOCKFROST_BASE)
        .get('/api/v0/network')
        .delay(3000) // exceeds 2s timeout
        .reply(200, { supply: {} });

      // Koios succeeds
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(200, [{
          epoch_no: 100, circulation: '35000000000000000', treasury: '1000000000000000',
          reward: '500000000000000', supply: '35000000000000000', reserves: '10000000000000000',
        }]);

      const client = new CardanoClient(createConfig({ backends: ['blockfrost', 'koios'] }));
      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
    });

    it('should throw AllBackendsFailedError when all backends time out', async () => {
      setupKoiosTip();
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .delay(5000) // exceeds fallback timeout (4s)
        .reply(200, {});

      const client = new CardanoClient(createConfig({ backends: ['koios'] }));
      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
    }, 10000);
  });

  // ==========================================================================
  // Circuit Breaker Integration
  // ==========================================================================

  describe('Circuit Breaker Integration', () => {
    it('should skip backend after repeated failures', async () => {
      const config = createConfig({
        backends: ['blockfrost', 'koios'],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
      });

      // Both backends init
      setupBlockfrostHealth();
      setupKoiosTip();

      // Blockfrost fails on every HTTP attempt. Use .persist() because got (inside
      // blockfrost-js) retries 5xx internally — a single backend-level call may
      // consume multiple HTTP requests, so nock .times(N) counting is unreliable.
      nock(BLOCKFROST_BASE)
        .persist()
        .get('/api/v0/network')
        .reply(500, { error: 'Internal error' });

      // Koios succeeds every time
      nock(KOIOS_BASE)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .times(3)
        .reply(200, [{
          epoch_no: 100, circulation: '35000000000000000', treasury: '1000000000000000',
          reward: '500000000000000', supply: '35000000000000000', reserves: '10000000000000000',
        }]);

      const client = new CardanoClient(config);
      // Spy on the blockfrost backend after init so we can count how many times the
      // circuit breaker actually let the request through (independent of HTTP retries).
      // Only ogmios is a live backend; blockfrost + koios live in historicalBackends.
      const blockfrostBackend = (client as any).historicalBackends.find(
        (b: any) => b.name === 'blockfrost'
      );
      expect(blockfrostBackend?.name).toBe('blockfrost');
      const blockfrostSpy = jest.spyOn(blockfrostBackend, 'getNetworkInformation');

      // First two calls: blockfrost fails, koios succeeds (circuit records 2 failures → opens)
      await client.getNetworkInformation();
      await client.getNetworkInformation();

      // Third call: blockfrost circuit is open → must be skipped at the CardanoClient
      // layer before hitting the backend.
      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();

      // Blockfrost backend.getNetworkInformation was invoked twice (not three times).
      expect(blockfrostSpy).toHaveBeenCalledTimes(2);

      // Clean up the persisted mock so it doesn't leak into the next test.
      nock.cleanAll();
    });

    it('should not open circuit on 404 errors', async () => {
      const config = createConfig({
        backends: ['koios'],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
      });

      setupKoiosTip();

      // Return 404 multiple times (resource not found, not a backend failure)
      nock(KOIOS_BASE)
        .post('/tx_info')
        .times(3)
        .reply(404, { error: 'Not found' });

      const client = new CardanoClient(config);

      // Multiple 404s should NOT open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(client.getTransaction('nonexistent')).rejects.toThrow(AllBackendsFailedError);
      }

      // Circuit should still be closed (404s don't count as failures)
      // The 3rd call should still have attempted the backend (not skipped)
      expect(nock.isDone()).toBe(true);
    });
  });
});
