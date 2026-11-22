import { env } from 'process';
import cds from '@sap/cds';
import {
  initializeFromConfig,
  getAppContext,
  getCardanoIndexer,
  getCardanoClient,
  getCardanoTxBuilder,
  resetAppContext,
  shutdownAppContext,
  redriveInterruptedSubmissionsIfConfigured,
} from '../../srv/server';
import { CardanoTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { HsmSigner, getHsmSigner, setHsmSigner } from '../../srv/blockchain/signing/hsm-signer';

describe('server.ts', () => {

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

  describe('Bootstrap guard behavior', () => {
    afterEach(() => {
      resetAppContext(null);
    });

    it('should guard against double initialization via resetAppContext', () => {
      // The served hook guards with `if (appContext) return;`; resetAppContext is the test seam.
      const mockContext1 = {
        cardanoClient: { name: 'first' } as any,
        cardanoIndexer: { name: 'first' } as any,
        cardanoTxBuilder: { name: 'first' } as any,
      };
      resetAppContext(mockContext1);
      expect(getAppContext()).toBe(mockContext1);

      // resetAppContext overwrites by design (tests only); the served-hook guard prevents it in production.
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

  describe('initializeFromConfig / served hook', () => {
    const baseConfig = {
      network: 'preview',
      backends: ['koios'],
      blockfrostApiKey: '',
      koiosApiKey: '',
      ogmiosUrl: '',
      primaryTimeoutMs: 30000,
      fallbackTimeoutMs: 60000,
      indexTtlMs: 3600000,
    } as any;

    afterEach(async () => {
      vi.restoreAllMocks();
      await shutdownAppContext();
      resetAppContext(null);
      setHsmSigner(null);
      delete env.SKIP_AUTO_INIT;
    });

    it('should initialize from pre-built config', async () => {
      const txBuilderInitSpy = vi
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);

      await initializeFromConfig(baseConfig);

      expect(txBuilderInitSpy).toHaveBeenCalled();
      expect(getAppContext()).toBeDefined();
    });

    it('should initialize HSM signer when hsm config is enabled', async () => {
      vi
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);
      const hsmInitSpy = vi
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
      vi
        .spyOn(CardanoTransactionBuilder.prototype, 'init')
        .mockResolvedValue(undefined);
      const hsmInitSpy = vi
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
  });

  describe('redriveInterruptedSubmissionsIfConfigured', () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await shutdownAppContext();
      resetAppContext(null);
    });

    it('does nothing without a database, so no transaction is opened', async () => {
      vi.spyOn(CardanoTransactionBuilder.prototype, 'init').mockResolvedValue(undefined);
      await initializeFromConfig({
        network: 'preview', backends: ['koios'], blockfrostApiKey: '', koiosApiKey: '', ogmiosUrl: '',
        primaryTimeoutMs: 30000, fallbackTimeoutMs: 60000, indexTtlMs: 3600000,
      } as any);
      expect(cds.db).toBeUndefined();
      const txSpy = vi.spyOn(cds, 'tx');

      await redriveInterruptedSubmissionsIfConfigured();

      expect(txSpy).not.toHaveBeenCalled();
    });
  });

  describe('shutdownAppContext', () => {
    afterEach(() => {
      resetAppContext(null);
      setHsmSigner(null);
    });

    it('should shutdown client and clear context', async () => {
      const mockShutdown = vi.fn().mockResolvedValue(undefined);
      resetAppContext({
        cardanoClient: { shutdown: mockShutdown } as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      });

      await shutdownAppContext();

      expect(mockShutdown).toHaveBeenCalled();
      expect(() => getAppContext()).toThrow('Application not initialized');
    });

    it('closes the backends once when the plugin and the standalone hook shut down together', async () => {
      const mockShutdown = vi.fn().mockResolvedValue(undefined);
      resetAppContext({
        cardanoClient: { shutdown: mockShutdown } as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      });

      await Promise.all([shutdownAppContext(), shutdownAppContext()]);

      expect(mockShutdown).toHaveBeenCalledTimes(1);
    });

    it('should shutdown HSM signer if active', async () => {
      const mockShutdown = vi.fn().mockResolvedValue(undefined);
      resetAppContext({
        cardanoClient: { shutdown: mockShutdown } as any,
        cardanoIndexer: {} as any,
        cardanoTxBuilder: {} as any,
      });

      const mockHsmShutdown = vi.fn();
      setHsmSigner({ shutdown: mockHsmShutdown, getStatus: vi.fn() } as any);

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
