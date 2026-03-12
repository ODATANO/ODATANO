import cds from '@sap/cds';
import { env } from 'process';
import {
  loadConfigFromEnv,
  loadHsmConfigFromEnv,
  initializeFromConfig,
  getAppContext,
  getCardanoIndexer,
  getCardanoClient,
  getCardanoTxBuilder,
  resetAppContext,
  shutdownAppContext,
} from '../../srv/server';
import { CardanoTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { HsmSigner, getHsmSigner, setHsmSigner } from '../../srv/blockchain/signing/hsm-signer';

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

    it('should throw when PRIMARY_TIMEOUT_MS is zero', () => {
      env.PRIMARY_TIMEOUT_MS = '0';
      expect(() => loadConfigFromEnv()).toThrow('Invalid PRIMARY_TIMEOUT_MS "0"');
      expect(() => loadConfigFromEnv()).toThrow('Must be a positive number');
    });

    it('should throw when FALLBACK_TIMEOUT_MS is negative', () => {
      env.FALLBACK_TIMEOUT_MS = '-1';
      expect(() => loadConfigFromEnv()).toThrow('Invalid FALLBACK_TIMEOUT_MS "-1"');
      expect(() => loadConfigFromEnv()).toThrow('Must be a positive number');
    });

    it('should warn but succeed when blockfrost backend has no API key', () => {
      env.BACKENDS = 'blockfrost';
      // No BLOCKFROST_API_KEY set — should still return config (warning is logged)
      const config = loadConfigFromEnv();
      expect(config.backends).toEqual(['blockfrost']);
      expect(config.blockfrostApiKey).toBe('');
    });

    it('should warn but succeed when ogmios backend has no URL', () => {
      env.BACKENDS = 'ogmios';
      // No OGMIOS_URL set — should still return config (warning is logged)
      const config = loadConfigFromEnv();
      expect(config.backends).toEqual(['ogmios']);
      expect(config.ogmiosUrl).toBe('');
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

    it('should throw when resetAppContext is called in production mode', () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      expect(() => resetAppContext(null)).toThrow('resetAppContext() is not available in production');

      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });
  });

  // ============================================================================
  // Convenience getters
  // ============================================================================
  describe('getCardanoIndexer / getCardanoClient / getCardanoTxBuilder', () => {
    afterEach(() => {
      resetAppContext(null);
    });

    it('should throw when not initialized', () => {
      resetAppContext(null);
      expect(() => getCardanoIndexer()).toThrow('Application not initialized');
      expect(() => getCardanoClient()).toThrow('Application not initialized');
      expect(() => getCardanoTxBuilder()).toThrow('Application not initialized');
    });

    it('should return correct component from context', () => {
      const mockIndexer = { name: 'indexer' };
      const mockClient = { name: 'client' };
      const mockTxBuilder = { name: 'txBuilder' };
      resetAppContext({
        cardanoClient: mockClient as any,
        cardanoIndexer: mockIndexer as any,
        cardanoTxBuilder: mockTxBuilder as any,
      });

      expect(getCardanoIndexer()).toBe(mockIndexer);
      expect(getCardanoClient()).toBe(mockClient);
      expect(getCardanoTxBuilder()).toBe(mockTxBuilder);
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

  // ============================================================================
  // loadHsmConfigFromEnv
  // ============================================================================
  describe('loadHsmConfigFromEnv', () => {
    const hsmKeys = ['HSM_ENABLED', 'HSM_PKCS11_MODULE', 'HSM_PIN', 'HSM_SLOT', 'HSM_KEY_ID', 'HSM_KEY_LABEL'];
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of hsmKeys) {
        originalEnv[key] = env[key];
        delete env[key];
      }
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    });

    it('should return undefined when HSM is not enabled', () => {
      expect(loadHsmConfigFromEnv()).toBeUndefined();
    });

    it('should return config when HSM is enabled with all required fields', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      env.HSM_PIN = '1234';
      env.HSM_SLOT = '2';
      env.HSM_KEY_ID = '0x0001';
      env.HSM_KEY_LABEL = 'my-key';

      const config = loadHsmConfigFromEnv();
      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.pkcs11Module).toBe('/usr/lib/pkcs11/yubihsm.so');
      expect(config!.pin).toBe('1234');
      expect(config!.slot).toBe(2);
      expect(config!.keyId).toBe('0x0001');
      expect(config!.keyLabel).toBe('my-key');
    });

    it('should throw when HSM_PKCS11_MODULE is missing', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PIN = '1234';
      expect(() => loadHsmConfigFromEnv()).toThrow('HSM_PKCS11_MODULE is required');
    });

    it('should throw when HSM_PIN is missing', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      expect(() => loadHsmConfigFromEnv()).toThrow('HSM_PIN is required');
    });

    it('should default slot to 0 when not specified', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      env.HSM_PIN = '1234';

      const config = loadHsmConfigFromEnv();
      expect(config!.slot).toBe(0);
    });

    it('should throw on invalid negative HSM slot', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      env.HSM_PIN = '1234';
      env.HSM_SLOT = '-1';

      expect(() => loadHsmConfigFromEnv()).toThrow('Invalid HSM slot');
    });
  });

  // ============================================================================
  // initializeFromConfig / served hook error paths
  // ============================================================================
  describe('initializeFromConfig / served hook', () => {
    const baseConfig = {
      network: 'preview',
      backends: ['koios'],
      blockfrostApiKey: '',
      koiosApiKey: '',
      ogmiosUrl: '',
      transactionBuilders: ['csl'],
      primaryTimeoutMs: 30000,
      fallbackTimeoutMs: 60000,
      indexTtlMs: 3600000,
    } as any;

    afterEach(async () => {
      jest.restoreAllMocks();
      await shutdownAppContext();
      resetAppContext(null);
      setHsmSigner(null);
      delete env.SKIP_AUTO_INIT;
    });

    it('should initialize from pre-built config', async () => {
      const txBuilderInitSpy = jest
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);

      await initializeFromConfig(baseConfig);

      expect(txBuilderInitSpy).toHaveBeenCalled();
      expect(getAppContext()).toBeDefined();
    });

    it('should initialize HSM signer when hsm config is enabled', async () => {
      jest
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);
      const hsmInitSpy = jest
        .spyOn(HsmSigner.prototype, 'init')
        .mockResolvedValue(undefined);

      await initializeFromConfig(baseConfig, undefined, {
        enabled: true,
        pkcs11Module: '/tmp/mock.so',
        slot: 0,
        pin: '1234',
      } as any);

      expect(hsmInitSpy).toHaveBeenCalledWith('preview');
      expect(getHsmSigner()).toBeTruthy();
    });

    it('should not fail app init when HSM init throws', async () => {
      jest
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);
      const hsmInitSpy = jest
        .spyOn(HsmSigner.prototype, 'init')
        .mockRejectedValue(new Error('hsm unavailable'));

      await expect(initializeFromConfig(baseConfig, undefined, {
        enabled: true,
        pkcs11Module: '/tmp/mock.so',
        slot: 0,
        pin: '1234',
      } as any)).resolves.toBeUndefined();

      expect(hsmInitSpy).toHaveBeenCalled();
      expect(getHsmSigner()).toBeNull();
    });

    it('should rethrow served hook initialization errors', async () => {
      const txBuilderInitSpy = jest
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockRejectedValue(new Error('init failed in served'));

      resetAppContext(null);
      delete env.SKIP_AUTO_INIT;

      await expect((cds as any).emit('served')).rejects.toThrow('init failed in served');
      expect(txBuilderInitSpy).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // shutdownAppContext
  // ============================================================================
  describe('shutdownAppContext', () => {
    afterEach(() => {
      resetAppContext(null);
      setHsmSigner(null);
    });

    it('should shutdown client and clear context', async () => {
      const mockShutdown = jest.fn().mockResolvedValue(undefined);
      resetAppContext({
        cardanoClient: { shutdown: mockShutdown } as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      });

      await shutdownAppContext();

      expect(mockShutdown).toHaveBeenCalled();
      expect(() => getAppContext()).toThrow('Application not initialized');
    });

    it('should shutdown HSM signer if active', async () => {
      const mockShutdown = jest.fn().mockResolvedValue(undefined);
      resetAppContext({
        cardanoClient: { shutdown: mockShutdown } as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      });

      const mockHsmShutdown = jest.fn();
      setHsmSigner({ shutdown: mockHsmShutdown, getStatus: jest.fn() } as any);

      await shutdownAppContext();

      expect(mockHsmShutdown).toHaveBeenCalled();
      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should be a no-op when context is null', async () => {
      resetAppContext(null);
      await expect(shutdownAppContext()).resolves.toBeUndefined();
    });
  });
});
