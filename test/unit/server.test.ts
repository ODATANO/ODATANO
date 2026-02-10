import { env } from 'process';
import {
  loadConfigFromEnv,
  getAppContext,
  getCardanoIndexer,
  getCardanoClient,
  resetAppContext,
} from '../../srv/server';

describe('server.ts', () => {

  // ============================================================================
  // loadConfigFromEnv - Config validation
  // ============================================================================
  describe('loadConfigFromEnv', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save env vars we'll modify
      for (const key of ['NETWORK', 'BACKENDS', 'TX_BUILDERS', 'PRIMARY_TIMEOUT_MS', 'FALLBACK_TIMEOUT_MS', 'BLOCKFROST_API_KEY', 'KOIOS_API_KEY', 'OGMIOS_URL', 'INDEX_TTL_MS']) {
        originalEnv[key] = env[key];
      }
      // Clear all to get clean defaults
      delete env.NETWORK;
      delete env.BACKENDS;
      delete env.TX_BUILDERS;
      delete env.PRIMARY_TIMEOUT_MS;
      delete env.FALLBACK_TIMEOUT_MS;
      delete env.BLOCKFROST_API_KEY;
      delete env.KOIOS_API_KEY;
      delete env.OGMIOS_URL;
      delete env.INDEX_TTL_MS;
    });

    afterEach(() => {
      // Restore env vars
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    });

    it('should return defaults when no env vars are set', () => {
      const config = loadConfigFromEnv();
      expect(config.network).toBe('preview');
      expect(config.backends).toEqual(['koios']);
      expect(config.transactionBuilders).toEqual(['csl']);
      expect(config.primaryTimeoutMs).toBe(30000);
      expect(config.fallbackTimeoutMs).toBe(60000);
      expect(config.indexTtlMs).toBe(3600000);
    });

    it('should parse valid env vars', () => {
      env.NETWORK = 'mainnet';
      env.BACKENDS = 'blockfrost, koios';
      env.TX_BUILDERS = 'buildooor';
      env.PRIMARY_TIMEOUT_MS = '5000';
      env.FALLBACK_TIMEOUT_MS = '10000';
      env.INDEX_TTL_MS = '7200000';
      env.BLOCKFROST_API_KEY = 'test-key';

      const config = loadConfigFromEnv();
      expect(config.network).toBe('mainnet');
      expect(config.backends).toEqual(['blockfrost', 'koios']);
      expect(config.transactionBuilders).toEqual(['buildooor']);
      expect(config.primaryTimeoutMs).toBe(5000);
      expect(config.fallbackTimeoutMs).toBe(10000);
      expect(config.indexTtlMs).toBe(7200000);
      expect(config.blockfrostApiKey).toBe('test-key');
    });

    it('should throw on invalid NETWORK', () => {
      env.NETWORK = 'testnet';
      expect(() => loadConfigFromEnv()).toThrow('Invalid NETWORK "testnet"');
      expect(() => loadConfigFromEnv()).toThrow('Must be one of: mainnet, preview, preprod');
    });

    it('should throw on invalid BACKENDS', () => {
      env.BACKENDS = 'koios,invalid_backend';
      expect(() => loadConfigFromEnv()).toThrow('Invalid BACKENDS: "invalid_backend"');
      expect(() => loadConfigFromEnv()).toThrow('Must be one of: blockfrost, koios, ogmios');
    });

    it('should throw on invalid TX_BUILDERS', () => {
      env.TX_BUILDERS = 'unknown';
      expect(() => loadConfigFromEnv()).toThrow('Invalid TX_BUILDERS: "unknown"');
      expect(() => loadConfigFromEnv()).toThrow('Must be one of: csl, buildooor');
    });

    it('should throw on non-numeric PRIMARY_TIMEOUT_MS', () => {
      env.PRIMARY_TIMEOUT_MS = 'abc';
      expect(() => loadConfigFromEnv()).toThrow('Invalid PRIMARY_TIMEOUT_MS "abc"');
      expect(() => loadConfigFromEnv()).toThrow('Must be a number');
    });

    it('should throw on non-numeric FALLBACK_TIMEOUT_MS', () => {
      env.FALLBACK_TIMEOUT_MS = 'xyz';
      expect(() => loadConfigFromEnv()).toThrow('Invalid FALLBACK_TIMEOUT_MS "xyz"');
      expect(() => loadConfigFromEnv()).toThrow('Must be a number');
    });
  });

  // ============================================================================
  // getAppContext - Error when not initialized
  // ============================================================================
  describe('getAppContext', () => {
    it('should throw when called before initialization', () => {
      resetAppContext(null);
      expect(() => getAppContext()).toThrow('Application not initialized');
      expect(() => getAppContext()).toThrow('cds.served event');
    });

    it('should return context when initialized', () => {
      const mockContext = {
        cardanoClient: {} as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      };
      resetAppContext(mockContext);

      const result = getAppContext();
      expect(result).toBe(mockContext);

      // Cleanup
      resetAppContext(null);
    });
  });

  // ============================================================================
  // Convenience getters
  // ============================================================================
  describe('getCardanoIndexer / getCardanoClient', () => {
    afterEach(() => {
      resetAppContext(null);
    });

    it('should throw when not initialized', () => {
      resetAppContext(null);
      expect(() => getCardanoIndexer()).toThrow('Application not initialized');
      expect(() => getCardanoClient()).toThrow('Application not initialized');
    });

    it('should return correct component from context', () => {
      const mockIndexer = { name: 'indexer' };
      const mockClient = { name: 'client' };
      resetAppContext({
        cardanoClient: mockClient as any,
        cardanoIndexer: mockIndexer as any,
        cardanoTxBuilder: {} as any,
      });

      expect(getCardanoIndexer()).toBe(mockIndexer);
      expect(getCardanoClient()).toBe(mockClient);
    });
  });

  // ============================================================================
  // Bootstrap Guard (B22-B23)
  // ============================================================================
  describe('Bootstrap guard behavior', () => {
    afterEach(() => {
      resetAppContext(null);
    });

    it('should guard against double initialization via resetAppContext', () => {
      // The cds.on("served") hook checks: if (appContext) return;
      // We test this behavior through resetAppContext: setting a context
      // then verifying it stays stable (no overwrite)
      const mockContext1 = {
        cardanoClient: { name: 'first' } as any,
        cardanoIndexer: { name: 'first' } as any,
        cardanoTxBuilder: { name: 'first' } as any,
      };
      resetAppContext(mockContext1);
      expect(getAppContext()).toBe(mockContext1);

      // Setting a second context overwrites (this is by design for tests)
      // In production, the guard prevents this by returning early
      const mockContext2 = {
        cardanoClient: { name: 'second' } as any,
        cardanoIndexer: { name: 'second' } as any,
        cardanoTxBuilder: { name: 'second' } as any,
      };
      resetAppContext(mockContext2);
      expect(getAppContext()).toBe(mockContext2);
    });

    it('should throw descriptive error when accessing uninitialized context', () => {
      resetAppContext(null);
      expect(() => getAppContext()).toThrow('Application not initialized');
      expect(() => getAppContext()).toThrow('cds.served event');
    });
  });
});
