import { CardanoClient, CardanoClientConfig, Network } from '../../srv/blockchain/cardano-client';
import { isEvaluatingBackend } from '../../srv/blockchain/backends/cardano-backend';
import { ConfigError, AllBackendsInitFailedError, AllBackendsFailedError, ProviderUnavailableError } from '../../srv/utils/errors';
import nock from 'nock';

const NETWORK: Network = 'preview';
const TIMEOUT_MS = 5000;
const KOIOS_BASE_URL = 'https://preview.koios.rest/api/v1';
const BLOCKFROST_BASE_URL = 'https://cardano-preview.blockfrost.io';

/**
 * Create a CardanoClientConfig for testing
 */
function createTestConfig(overrides: Partial<CardanoClientConfig> = {}): CardanoClientConfig {
  return {
    network: NETWORK,
    backends: ['koios'],
    blockfrostApiKey: 'test-blockfrost-key',
    koiosApiKey: 'test-koios-key',
    ogmiosUrl: 'ws://localhost:1337',
    transactionBuilders: ['buildooor'],
    primaryTimeoutMs: TIMEOUT_MS,
    fallbackTimeoutMs: TIMEOUT_MS * 2,
    indexTtlMs: 3600000,
    ...overrides,
  };
}

/**
 * Setup nock mocks for Koios tip endpoint (used for initialization)
 */
function setupKoiosTipMock() {
  nock(KOIOS_BASE_URL)
    .get('/tip')
    .reply(200, [{
      hash: 'test-block-hash',
      epoch_no: 100,
      abs_slot: 50000000,
      epoch_slot: 100000,
      block_no: 1000000,
      block_time: 1704067200,
    }]);
}

/**
 * Setup nock mocks for Blockfrost init endpoint — BlockfrostBackend.init() calls
 * api.blocksLatest(), which hits /api/v0/blocks/latest.
 */
function setupBlockfrostHealthMock() {
  nock(BLOCKFROST_BASE_URL)
    .get('/api/v0/blocks/latest')
    .reply(200, { hash: 'test-block-hash', height: 1000000 });
}

/**
 * Setup nock mocks for network information
 */
function setupNetworkInfoMocks() {
  // Koios network info (GET with query params)
  nock(KOIOS_BASE_URL)
    .get('/totals')
    .query({ order: 'epoch_no.desc', limit: '1' })
    .reply(200, [{
      epoch_no: 100,
      circulation: '35000000000000000',
      treasury: '1000000000000000',
      reward: '500000000000000',
      supply: '35000000000000000',
      reserves: '10000000000000000',
    }]);
}

describe('CardanoClient Configuration', () => {

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  // ============================================================================
  // Constructor Validation
  // ============================================================================
  describe('Constructor', () => {
    it('should throw ConfigError when no backends provided', () => {
      const config = createTestConfig({ backends: [] });
      expect(() => new CardanoClient(config)).toThrow(ConfigError);
      expect(() => new CardanoClient(config)).toThrow('No valid backends configured');
    });

    it('should accept koios backend', () => {
      const config = createTestConfig({ backends: ['koios'] });
      expect(() => new CardanoClient(config)).not.toThrow();
    });

    it('should accept blockfrost backend', () => {
      const config = createTestConfig({ backends: ['blockfrost'] });
      expect(() => new CardanoClient(config)).not.toThrow();
    });

    it('should accept ogmios backend', () => {
      const config = createTestConfig({ backends: ['ogmios'] });
      expect(() => new CardanoClient(config)).not.toThrow();
    });

    it('should accept multiple backends', () => {
      const config = createTestConfig({ backends: ['koios', 'blockfrost'] });
      expect(() => new CardanoClient(config)).not.toThrow();
    });

    it('should accept all backends', () => {
      const config = createTestConfig({ backends: ['ogmios', 'blockfrost', 'koios'] });
      expect(() => new CardanoClient(config)).not.toThrow();
    });

    it('should set network from config', () => {
      const config = createTestConfig({ network: 'mainnet', backends: ['koios'] });
      const client = new CardanoClient(config);
      expect(client.network).toBe('mainnet');
    });
  });

  // ============================================================================
  // Backend Initialization
  // ============================================================================
  describe('Backend Initialization', () => {
    it('should initialize koios backend on first operation', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // This will trigger initialization
      await expect(client.getNetworkInformation()).resolves.toBeDefined();
      expect(nock.isDone()).toBe(true);
    });

    it('should throw AllBackendsInitFailedError when backend init fails', async () => {
      // Mock failing tip endpoint
      nock(KOIOS_BASE_URL)
        .get('/tip')
        .reply(500, { error: 'Server error' });

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsInitFailedError);
    });

    it('should continue with working backends when some fail to init', async () => {
      // Koios succeeds
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      // Blockfrost init fails — got retries 500s, so cover all attempts.
      nock(BLOCKFROST_BASE_URL)
        .get('/api/v0/blocks/latest')
        .times(5)
        .reply(500, { error: 'Server error' });

      const config = createTestConfig({ backends: ['blockfrost', 'koios'] });
      const client = new CardanoClient(config);

      // Should still work via koios fallback
      await expect(client.getNetworkInformation()).resolves.toBeDefined();
    });

    it('should only initialize once', async () => {
      // Setup tip mock to be called only once
      const tipScope = nock(KOIOS_BASE_URL)
        .get('/tip')
        .reply(200, [{
          hash: 'test-block-hash',
          epoch_no: 100,
          abs_slot: 50000000,
          epoch_slot: 100000,
          block_no: 1000000,
          block_time: 1704067200,
        }]);

      // Setup network info mock to be called twice
      nock(KOIOS_BASE_URL)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .times(2)
        .reply(200, [{
          epoch_no: 100,
          circulation: '35000000000000000',
          treasury: '1000000000000000',
          reward: '500000000000000',
          supply: '35000000000000000',
          reserves: '10000000000000000',
        }]);

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Call multiple times
      await client.getNetworkInformation();
      await client.getNetworkInformation();

      // Tip should have been called only once (initialization)
      expect(tipScope.isDone()).toBe(true);
    });
  });

  // ============================================================================
  // Fallback Mechanism
  // ============================================================================
  describe('Fallback Mechanism', () => {
    it('should fallback to koios when blockfrost fails', async () => {
      // Blockfrost init succeeds but query fails. got retries on 500 — cover all attempts.
      setupBlockfrostHealthMock();
      nock(BLOCKFROST_BASE_URL)
        .get('/api/v0/network')
        .times(5)
        .reply(500, { error: 'Internal error' });

      // Koios succeeds
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['blockfrost', 'koios'] });
      const client = new CardanoClient(config);

      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
      expect(result.supply).toBeDefined();
    });

    it('should throw AllBackendsFailedError when all backends fail', async () => {
      // Koios init succeeds
      setupKoiosTipMock();

      // /totals network-info query fails (GET, matches koios-backend call)
      nock(KOIOS_BASE_URL)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .reply(500, { error: 'Server error' });

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
    });
  });

  // ============================================================================
  // getTransaction Tests
  // ============================================================================
  describe('getTransaction', () => {
    it('should fetch transaction from backend', async () => {
      setupKoiosTipMock();

      const mockTxResponse = [{
        tx_hash: 'abc123',
        block_hash: 'block456',
        block_height: 1000,
        tx_timestamp: 1704067200,
        tx_block_index: 0,
        tx_size: 300,
        total_output: '5000000',
        fee: '170000',
        deposit: '0',
        invalid_before: null,
        invalid_after: null,
        collateral_inputs: [],
        collateral_output: null,
        reference_inputs: [],
        inputs: [],
        outputs: [],
        withdrawals: [],
        assets_minted: [],
        metadata: [],
        certificates: [],
        native_scripts: [],
        plutus_contracts: [],
      }];

      nock(KOIOS_BASE_URL)
        .post('/tx_info')
        .reply(200, mockTxResponse);

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const result = await client.getTransaction('abc123');
      expect(result.hash).toBe('abc123');
      expect(result.blockHash).toBe('block456');
    });
  });

  // ============================================================================
  // evaluateTransaction Tests
  // ============================================================================
  describe('evaluateTransaction', () => {
    it('should throw error when no ogmios backend is configured', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization first
      await client.getNetworkInformation();

      await expect(client.evaluateTransaction('test-cbor'))
        .rejects.toThrow('Transaction evaluation requires an evaluating backend');
    });
  });

  // ============================================================================
  // hasOgmiosBackend Tests
  // ============================================================================
  describe('hasOgmiosBackend', () => {
    it('should return false when ogmios is not configured', () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);
      expect(client.hasOgmiosBackend()).toBe(false);
    });

    it('should return true when ogmios is configured', () => {
      const config = createTestConfig({ backends: ['ogmios', 'koios'] });
      const client = new CardanoClient(config);
      expect(client.hasOgmiosBackend()).toBe(true);
    });
  });

  // ============================================================================
  // shutdown Tests
  // ============================================================================
  describe('shutdown', () => {
    it('should reset initialization state', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization
      await client.getNetworkInformation();

      // Shutdown
      await client.shutdown();

      // Setup mocks again for re-initialization
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      // Should re-initialize on next call
      await expect(client.getNetworkInformation()).resolves.toBeDefined();
    });

    it('should reset initialized flag (resetCardanoClient behavior)', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization
      await client.getNetworkInformation();

      // Verify initialized before shutdown
      expect((client as any).initialized).toBe(true);

      // Shutdown
      await client.shutdown();

      // Verify state is reset
      expect((client as any).initialized).toBe(false);
      expect((client as any).initPromise).toBeNull();
    });

    it('should allow re-initialization after shutdown', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization
      await client.getNetworkInformation();
      expect((client as any).initialized).toBe(true);

      // Shutdown
      await client.shutdown();
      expect((client as any).initialized).toBe(false);

      // Setup mocks for re-initialization
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      // Re-initialize
      await client.getNetworkInformation();
      expect((client as any).initialized).toBe(true);
    });

    it('should not throw when shutdown errors occur (logs instead)', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization
      await client.getNetworkInformation();

      // Shutdown should not throw even if internal cleanup fails
      await expect(client.shutdown()).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // getProtocolParameters Tests
  // ============================================================================
  describe('getProtocolParameters', () => {
    // Note: Happy path for getProtocolParameters is tested in koios-backend.test.ts
    // and blockfrost-backend.test.ts directly on the backend level

    it('should fallback to historical backend on primary failure', async () => {
      // First backend (koios) init succeeds
      setupKoiosTipMock();

      // But protocol params query fails
      nock(KOIOS_BASE_URL)
        .get('/cli_protocol_params')
        .reply(500, { error: 'Server error' });

      // Fallback to second koios call (in this test, same backend retried)
      nock(KOIOS_BASE_URL)
        .get('/cli_protocol_params')
        .reply(500, { error: 'Server error' });

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Should throw AllBackendsFailedError when all backends fail
      await expect(client.getProtocolParameters()).rejects.toThrow(AllBackendsFailedError);
    });
  });

  // ============================================================================
  // initBackends - Live backend (Ogmios) failure with historical fallback
  // ============================================================================
  describe('initBackends - live backend failure', () => {
    it('should continue with historical backends when live backend (ogmios) fails to init', async () => {
      const config = createTestConfig({ backends: ['ogmios', 'koios'] });
      const client = new CardanoClient(config);

      // Ogmios init will fail (no real Ogmios running) - but we need to ensure
      // koios still works. Mock ogmios to fail and koios to succeed.
      const failingLiveBackend = {
        name: 'ogmios',
        init: jest.fn().mockRejectedValue(new Error('WebSocket connection refused')),
      };
      (client as any).liveBackend = failingLiveBackend;

      // Koios init succeeds
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
      expect(result.supply).toBeDefined();
      // Live backend is KEPT for lazy retry (previously removed permanently) —
      // the request retried its init once before falling through to koios
      expect((client as any).liveBackend).toBe(failingLiveBackend);
      expect((client as any).uninitializedBackends.has(failingLiveBackend)).toBe(true);
      expect(failingLiveBackend.init.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should throw AllBackendsInitFailedError when both live and historical backends fail', async () => {
      const config = createTestConfig({ backends: ['ogmios', 'koios'] });
      const client = new CardanoClient(config);

      // Ogmios fails
      const failingLiveBackend = {
        name: 'ogmios',
        init: jest.fn().mockRejectedValue(new Error('WebSocket connection refused')),
      };
      (client as any).liveBackend = failingLiveBackend;

      // Koios also fails
      nock(KOIOS_BASE_URL)
        .get('/tip')
        .reply(500, { error: 'Server error' });

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsInitFailedError);
    });

    it('retries initialization on the next request after a transient startup failure', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const mockNetworkInfo = { supply: { max: '1', total: '1', circulating: '1', locked: '0', treasury: '0', reserves: '0' }, stake: { live: '0', active: '0' } };
      const backend = {
        name: 'koios',
        init: jest.fn()
          .mockRejectedValueOnce(new Error('transient outage'))
          .mockResolvedValue(true),
        getNetworkInformation: jest.fn().mockResolvedValue(mockNetworkInfo),
      };
      (client as any).historicalBackends = [backend];

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsInitFailedError);

      // previously the rejected initPromise stayed cached — the client was
      // permanently broken until process restart
      const result = await client.getNetworkInformation();
      expect(result).toBe(mockNetworkInfo);
      expect(backend.init).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // withTimeout - Timeout rejection path
  // ============================================================================
  describe('withTimeout', () => {
    it('should reject with ProviderUnavailableError when backend times out', async () => {
      setupKoiosTipMock();

      // Koios network info - delayed beyond timeout
      nock(KOIOS_BASE_URL)
        .get('/totals')
        .query({ order: 'epoch_no.desc', limit: '1' })
        .delay(6000) // longer than fallbackTimeoutMs (10000) ... we'll set a short timeout
        .reply(200, [{ epoch_no: 100, circulation: '35000000000000000', treasury: '1', reward: '1', supply: '35000000000000000', reserves: '1' }]);

      const config = createTestConfig({
        backends: ['koios'],
        primaryTimeoutMs: 100,
        fallbackTimeoutMs: 100, // very short timeout
      });
      const client = new CardanoClient(config);

      await expect(client.getNetworkInformation()).rejects.toThrow(/timeout/i);
    }, 10000);
  });

  // ============================================================================
  // executeWithPriority - Circuit breaker skip
  // ============================================================================
  describe('executeWithPriority - circuit breaker', () => {
    it('should skip backend with open circuit and use fallback', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Inject two mock historical backends and mark as initialized
      const mockNetworkInfo = { supply: { max: '1', total: '1', circulating: '1', locked: '0', treasury: '0', reserves: '0' }, stake: { live: '0', active: '0' } };
      const primaryBackend = { name: 'blockfrost', getNetworkInformation: jest.fn().mockResolvedValue(mockNetworkInfo) };
      const fallbackBackend = { name: 'koios', getNetworkInformation: jest.fn().mockResolvedValue(mockNetworkInfo) };
      (client as any).historicalBackends = [primaryBackend, fallbackBackend];
      (client as any).initialized = true;

      // Force circuit open for primary backend
      const cb = (client as any).circuitBreaker;
      for (let i = 0; i < 6; i++) {
        cb.recordFailure('blockfrost');
      }

      const result = await client.getNetworkInformation();
      expect(result).toBeDefined();
      // Primary should have been skipped, fallback should have been called
      expect(primaryBackend.getNetworkInformation).not.toHaveBeenCalled();
      expect(fallbackBackend.getNetworkInformation).toHaveBeenCalledTimes(1);
    });

    it('should throw AllBackendsFailedError when all backends have open circuits', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Inject mock backend and mark as initialized
      const mockBackend = { name: 'koios', getNetworkInformation: jest.fn() };
      (client as any).historicalBackends = [mockBackend];
      (client as any).initialized = true;

      // Force circuit open for koios
      const cb = (client as any).circuitBreaker;
      for (let i = 0; i < 6; i++) {
        cb.recordFailure('koios');
      }

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
      expect(mockBackend.getNetworkInformation).not.toHaveBeenCalled();
    });

    it('skips backends that declare a method unsupported — without breaker recording', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const mockNetworkInfo = { supply: { max: '1', total: '1', circulating: '1', locked: '0', treasury: '0', reserves: '0' }, stake: { live: '0', active: '0' } };
      const live = {
        name: 'ogmios',
        unsupportedMethods: new Set(['getNetworkInformation']),
        getNetworkInformation: jest.fn().mockResolvedValue({ fabricated: true }),
      };
      const historical = { name: 'koios', getNetworkInformation: jest.fn().mockResolvedValue(mockNetworkInfo) };
      (client as any).liveBackend = live;
      (client as any).historicalBackends = [historical];
      (client as any).initialized = true;

      // getNetworkInformation prefers live — the declared non-support must skip
      // Ogmios entirely (no call, no failure) and serve the historical answer
      const result = await client.getNetworkInformation();
      expect(result).toBe(mockNetworkInfo);
      expect(live.getNetworkInformation).not.toHaveBeenCalled();
      expect((client as any).circuitBreaker.shouldAttempt('ogmios')).toBe(true);
    });

    it('keeps the circuit closed on 4xx client errors but opens it on 5xx', async () => {
      const { TransactionValidationError, RateLimitError, ProviderUnavailableError } = require('../../srv/utils/errors');
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const mockBackend = {
        name: 'koios',
        getNetworkInformation: jest.fn().mockRejectedValue(new TransactionValidationError('bad input')), // 400
      };
      (client as any).historicalBackends = [mockBackend];
      (client as any).initialized = true;
      const cb = (client as any).circuitBreaker;

      // a storm of client errors must NOT take the backend out of rotation
      for (let i = 0; i < 6; i++) {
        await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
      }
      expect(cb.shouldAttempt('koios')).toBe(true);

      mockBackend.getNetworkInformation.mockRejectedValue(new RateLimitError('rate limited', 'koios')); // 429
      for (let i = 0; i < 6; i++) {
        await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
      }
      expect(cb.shouldAttempt('koios')).toBe(true);

      // real backend-health errors (5xx) still open the circuit
      mockBackend.getNetworkInformation.mockRejectedValue(new ProviderUnavailableError('koios down', 'koios')); // 503
      for (let i = 0; i < 6; i++) {
        await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsFailedError);
      }
      expect(cb.shouldAttempt('koios')).toBe(false);
    });
  });

  // ============================================================================
  // Batch/hash fallback helpers
  // ============================================================================
  describe('batch/hash fallback helpers', () => {
    it('should fall back to getAddressTransactions when no backend exposes getAddressTransactionHashes', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      (client as any).historicalBackends = [{ name: 'plain-backend' } as any];
      (client as any).liveBackend = undefined;
      (client as any).initialized = true;

      const txs = [{ hash: 'a'.repeat(64) }, { hash: 'b'.repeat(64) }] as any;
      jest.spyOn(client, 'getAddressTransactions').mockResolvedValue(txs);

      const result = await client.getAddressTransactionHashes('addr_test1x', 2);
      expect(result).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    });

    it('should fall back to individual getTransaction calls when no batch method is available', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      (client as any).historicalBackends = [{ name: 'plain-backend' } as any];
      (client as any).liveBackend = undefined;
      (client as any).initialized = true;

      const txHash1 = 'a'.repeat(64);
      const txHash2 = 'b'.repeat(64);
      const getTxSpy = jest.spyOn(client, 'getTransaction')
        .mockResolvedValueOnce({ hash: txHash1 } as any)
        .mockResolvedValueOnce({ hash: txHash2 } as any);

      const result = await client.getTransactionsBatch([txHash1, txHash2]);

      expect(getTxSpy).toHaveBeenCalledTimes(2);
      expect(result.get(txHash1)?.hash).toBe(txHash1);
      expect(result.get(txHash2)?.hash).toBe(txHash2);
    });
  });

  // ============================================================================
  // shutdown - Historical backends + error handling
  // ============================================================================
  describe('shutdown - backend cleanup', () => {
    it('should call shutdown on backends that have a shutdown method', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Trigger initialization
      await client.getNetworkInformation();

      // Replace historical backends with mocks that have shutdown
      const mockBackend = {
        name: 'mock-historical',
        shutdown: jest.fn().mockResolvedValue(undefined),
      };
      (client as any).historicalBackends = [mockBackend as any];

      await client.shutdown();

      expect(mockBackend.shutdown).toHaveBeenCalledTimes(1);
      expect((client as any).initialized).toBe(false);
    });

    it('should not throw when backend shutdown throws an error', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      await client.getNetworkInformation();

      // Mock backend with failing shutdown
      const failingBackend = {
        name: 'failing-backend',
        shutdown: jest.fn().mockRejectedValue(new Error('Shutdown failed')),
      };
      (client as any).historicalBackends = [failingBackend as any];

      // Should not throw - errors are caught and logged
      await expect(client.shutdown()).resolves.not.toThrow();
      expect(failingBackend.shutdown).toHaveBeenCalledTimes(1);
    });

    it('should call shutdown on live backend when it has a shutdown method', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      await client.getNetworkInformation();

      // Add a mock live backend with shutdown
      const mockLiveBackend = {
        name: 'ogmios',
        shutdown: jest.fn().mockResolvedValue(undefined),
      };
      (client as any).liveBackend = mockLiveBackend;

      await client.shutdown();

      expect(mockLiveBackend.shutdown).toHaveBeenCalledTimes(1);
    });

    it('should catch and continue when live backend shutdown throws', async () => {
      setupKoiosTipMock();
      setupNetworkInfoMocks();

      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      await client.getNetworkInformation();

      const failingLiveBackend = {
        name: 'ogmios',
        shutdown: jest.fn().mockRejectedValue(new Error('live shutdown failed')),
      };
      (client as any).liveBackend = failingLiveBackend;

      await expect(client.shutdown()).resolves.not.toThrow();
      expect(failingLiveBackend.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // evaluateTransaction - success path
  // ============================================================================
  describe('evaluateTransaction - success path', () => {
    it('should return evaluation results from live evaluating backend', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const evaluation = [{ validator: 'v1', budget: { memory: 1000, cpu: 2000 } }];
      (client as any).initialized = true;
      (client as any).liveBackend = {
        name: 'ogmios',
        evaluateTransaction: jest.fn().mockResolvedValue(evaluation),
      };

      const result = await client.evaluateTransaction('deadbeef');
      expect(result).toEqual(evaluation);
    });

    it('times out instead of hanging when the evaluating backend never responds', async () => {
      const config = createTestConfig({ backends: ['koios'], primaryTimeoutMs: 50 });
      const client = new CardanoClient(config);

      (client as any).initialized = true;
      (client as any).liveBackend = {
        name: 'ogmios',
        // hanging socket — previously blocked Plutus builds indefinitely
        evaluateTransaction: jest.fn().mockReturnValue(new Promise(() => { /* never settles */ })),
      };

      await expect(client.evaluateTransaction('deadbeef')).rejects.toThrow(/timeout/i);
    }, 5000);

    it('skips evaluation while the circuit for the evaluating backend is open', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      (client as any).initialized = true;
      (client as any).liveBackend = {
        name: 'ogmios',
        evaluateTransaction: jest.fn().mockResolvedValue([]),
      };
      const cb = (client as any).circuitBreaker;
      for (let i = 0; i < 6; i++) cb.recordFailure('ogmios');

      await expect(client.evaluateTransaction('deadbeef')).rejects.toThrow(/circuit open/i);
      expect((client as any).liveBackend.evaluateTransaction).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Batch methods — resilience (timeout/breaker on the per-backend attempts)
  // ============================================================================
  describe('batch methods - resilience', () => {
    it('fails over to the next batch-capable backend and records the failure', async () => {
      const { ProviderUnavailableError } = require('../../srv/utils/errors');
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const txMap = new Map([['a'.repeat(64), { hash: 'a'.repeat(64) } as any]]);
      const failing = {
        name: 'blockfrost',
        getTransactionsBatch: jest.fn().mockRejectedValue(new ProviderUnavailableError('down', 'blockfrost')),
      };
      const healthy = {
        name: 'koios',
        getTransactionsBatch: jest.fn().mockResolvedValue(txMap),
      };
      (client as any).historicalBackends = [failing, healthy];
      (client as any).initialized = true;

      const result = await client.getTransactionsBatch(['a'.repeat(64)]);
      expect(result).toBe(txMap);
      expect(healthy.getTransactionsBatch).toHaveBeenCalledTimes(1);

      // the 5xx failure was recorded against the failing backend
      const cb = (client as any).circuitBreaker;
      for (let i = 0; i < 5; i++) cb.recordFailure('blockfrost');
      expect(cb.shouldAttempt('blockfrost')).toBe(false); // 1 (recorded) + 5 = threshold reached
    });
  });

  // ============================================================================
  // isEvaluatingBackend Type Guard Tests
  // ============================================================================
  describe('isEvaluatingBackend', () => {
    it('should return false for object without evaluateTransaction', () => {
      const notEvaluating = { name: 'test' };
      expect(isEvaluatingBackend(notEvaluating as any)).toBe(false);
    });

    it('should return true for object with evaluateTransaction function', () => {
      const evaluating = {
        name: 'test',
        evaluateTransaction: async () => [],
      };
      expect(isEvaluatingBackend(evaluating as any)).toBe(true);
    });
  });

  // ============================================================================
  // getCredentialUtxos - Koios-only routing
  // ============================================================================
  describe('getCredentialUtxos', () => {
    const CRED = 'a'.repeat(56);

    it('routes to Koios when configured (live or historical)', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const fakeUtxos = [{ txHash: 'a'.repeat(64), outputIndex: 0, address: 'addr1...', amount: [] }];
      const koiosBackend = {
        name: 'koios',
        getCredentialUtxos: jest.fn().mockResolvedValue(fakeUtxos),
      };
      (client as any).historicalBackends = [koiosBackend];

      const result = await client.getCredentialUtxos(CRED);
      expect(koiosBackend.getCredentialUtxos).toHaveBeenCalledWith(CRED);
      expect(result).toEqual(fakeUtxos);
    });

    it('throws ProviderUnavailableError when only Blockfrost is configured', async () => {
      const config = createTestConfig({ backends: ['blockfrost'] });
      const client = new CardanoClient(config);

      const blockfrostBackend = { name: 'blockfrost' /* no getCredentialUtxos */ };
      (client as any).historicalBackends = [blockfrostBackend];

      expect(() => client.getCredentialUtxos(CRED)).toThrow(ProviderUnavailableError);
      expect(() => client.getCredentialUtxos(CRED)).toThrow(/requires Koios backend/);
    });

    it('throws ProviderUnavailableError when only Ogmios is configured', async () => {
      const config = createTestConfig({ backends: ['ogmios'] });
      const client = new CardanoClient(config);

      const ogmiosBackend = { name: 'ogmios' /* no getCredentialUtxos */ };
      (client as any).liveBackend = ogmiosBackend;
      (client as any).historicalBackends = [];

      expect(() => client.getCredentialUtxos(CRED)).toThrow(ProviderUnavailableError);
    });

    it('throws ProviderUnavailableError when Koios is present but lacks the method (defensive)', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      // Stale backend object without the method — guard against partial implementations
      const staleKoios = { name: 'koios' };
      (client as any).historicalBackends = [staleKoios];

      expect(() => client.getCredentialUtxos(CRED)).toThrow(ProviderUnavailableError);
    });

    it('coalesces concurrent requests for the same credential', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      let resolveBackend: (utxos: any[]) => void = () => {};
      const backendCall = jest.fn(() => new Promise<any[]>(resolve => { resolveBackend = resolve; }));
      (client as any).historicalBackends = [{
        name: 'koios',
        getCredentialUtxos: backendCall,
      }];

      // Fire three concurrent calls for the same credential
      const p1 = client.getCredentialUtxos(CRED);
      const p2 = client.getCredentialUtxos(CRED);
      const p3 = client.getCredentialUtxos(CRED);

      // Backend was called only once
      expect(backendCall).toHaveBeenCalledTimes(1);

      const fakeUtxos = [{ txHash: 'a'.repeat(64), outputIndex: 0, address: 'addr1', amount: [] }];
      resolveBackend(fakeUtxos);

      const results = await Promise.all([p1, p2, p3]);
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
      expect(results[0]).toEqual(fakeUtxos);
    });

    it('does not coalesce different credentials', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const backendCall = jest.fn().mockResolvedValue([]);
      (client as any).historicalBackends = [{
        name: 'koios',
        getCredentialUtxos: backendCall,
      }];

      await Promise.all([
        client.getCredentialUtxos('a'.repeat(56)),
        client.getCredentialUtxos('b'.repeat(56)),
      ]);

      expect(backendCall).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // getCurrentSlot / isUtxoUnspent routing
  // ============================================================================
  describe('getCurrentSlot routing', () => {
    it('prefers the live backend when configured', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const liveSlot = jest.fn().mockResolvedValue(80_000_001);
      const histSlot = jest.fn().mockResolvedValue(80_000_999);
      (client as any).liveBackend = { name: 'ogmios', getCurrentSlot: liveSlot };
      (client as any).historicalBackends = [{ name: 'koios', getCurrentSlot: histSlot }];
      (client as any).initialized = true;

      expect(await client.getCurrentSlot()).toBe(80_000_001);
      expect(liveSlot).toHaveBeenCalledTimes(1);
      expect(histSlot).not.toHaveBeenCalled();
    });

    it('falls back to a historical backend when live backend fails', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const liveSlot = jest.fn().mockRejectedValue(new ProviderUnavailableError('down', 'ogmios'));
      const histSlot = jest.fn().mockResolvedValue(80_000_999);
      (client as any).liveBackend = { name: 'ogmios', getCurrentSlot: liveSlot };
      (client as any).historicalBackends = [{ name: 'koios', getCurrentSlot: histSlot }];
      (client as any).initialized = true;

      expect(await client.getCurrentSlot()).toBe(80_000_999);
      expect(histSlot).toHaveBeenCalledTimes(1);
    });
  });

  describe('isUtxoUnspent routing', () => {
    const TX = 'a'.repeat(64);

    it('prefers the live backend when configured', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const liveCheck = jest.fn().mockResolvedValue(true);
      const histCheck = jest.fn().mockResolvedValue(false);
      (client as any).liveBackend = { name: 'ogmios', isUtxoUnspent: liveCheck };
      (client as any).historicalBackends = [{ name: 'koios', isUtxoUnspent: histCheck }];
      (client as any).initialized = true;

      expect(await client.isUtxoUnspent(TX, 0)).toBe(true);
      expect(liveCheck).toHaveBeenCalledWith(TX, 0);
      expect(histCheck).not.toHaveBeenCalled();
    });

    it('falls back to a historical backend when the live one escalates', async () => {
      const config = createTestConfig({ backends: ['koios'] });
      const client = new CardanoClient(config);

      const liveCheck = jest.fn().mockRejectedValue(new ProviderUnavailableError('field missing', 'blockfrost'));
      const histCheck = jest.fn().mockResolvedValue(true);
      (client as any).liveBackend = { name: 'ogmios', isUtxoUnspent: liveCheck };
      (client as any).historicalBackends = [{ name: 'koios', isUtxoUnspent: histCheck }];
      (client as any).initialized = true;

      expect(await client.isUtxoUnspent(TX, 0)).toBe(true);
      expect(histCheck).toHaveBeenCalledWith(TX, 0);
    });
  });
});
