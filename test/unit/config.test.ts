import { env } from 'process';
import cds from '@sap/cds';
import {
  loadConfigFromEnv,
  loadCrawlerConfigFromEnv,
  loadHsmConfigFromEnv,
  loadPoolMetadataFetchFromEnv,
  loadWalletWorkerConfigFromEnv,
} from '../../srv/config';

// CAP copies a local .env into process.env on the first read of cds.env. Read it here, so the
// hooks below clear variables after that and not before.
void cds.env;

describe('config.ts', () => {

  describe('loadConfigFromEnv', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save env vars we'll modify
      for (const key of ['NETWORK', 'BACKENDS', 'PRIMARY_TIMEOUT_MS', 'FALLBACK_TIMEOUT_MS', 'BLOCKFROST_API_KEY', 'KOIOS_API_KEY', 'OGMIOS_URL', 'INDEX_TTL_MS', 'ODATANO_URL', 'ODATANO_API_KEY']) {
        originalEnv[key] = env[key];
      }
      // Clear all to get clean defaults
      delete env.NETWORK;
      delete env.BACKENDS;
      delete env.PRIMARY_TIMEOUT_MS;
      delete env.FALLBACK_TIMEOUT_MS;
      delete env.BLOCKFROST_API_KEY;
      delete env.KOIOS_API_KEY;
      delete env.OGMIOS_URL;
      delete env.INDEX_TTL_MS;
      delete env.ODATANO_URL;
      delete env.ODATANO_API_KEY;
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
      expect(config.primaryTimeoutMs).toBe(30000);
      expect(config.fallbackTimeoutMs).toBe(60000);
      expect(config.indexTtlMs).toBe(3600000);
    });

    it('reads the odatano backend URL and key', () => {
      env.BACKENDS = 'ogmios,odatano';
      env.ODATANO_URL = 'https://api.preprod.odatano.dev';
      env.ODATANO_API_KEY = 'oda_test';
      const config = loadConfigFromEnv();
      expect(config.backends).toEqual(['ogmios', 'odatano']);
      expect(config).toMatchObject({ odatanoUrl: 'https://api.preprod.odatano.dev', odatanoApiKey: 'oda_test' });
    });

    it('rejects a non-http ODATANO_URL and needs one for odatano on mainnet', () => {
      env.BACKENDS = 'odatano';
      env.ODATANO_URL = 'api.odatano.dev';
      expect(() => loadConfigFromEnv()).toThrow(/Invalid ODATANO_URL/);
      delete env.ODATANO_URL;
      env.NETWORK = 'mainnet';
      expect(() => loadConfigFromEnv()).toThrow(/ODATANO_URL is required/);
    });

    it('should parse valid env vars', () => {
      env.NETWORK = 'mainnet';
      env.BACKENDS = 'blockfrost, koios';
      env.PRIMARY_TIMEOUT_MS = '5000';
      env.FALLBACK_TIMEOUT_MS = '10000';
      env.INDEX_TTL_MS = '7200000';
      env.BLOCKFROST_API_KEY = 'test-key';

      const config = loadConfigFromEnv();
      expect(config.network).toBe('mainnet');
      expect(config.backends).toEqual(['blockfrost', 'koios']);
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

    it('should throw on non-numeric PRIMARY_TIMEOUT_MS', () => {
      env.PRIMARY_TIMEOUT_MS = 'abc';
      expect(() => loadConfigFromEnv()).toThrow('Invalid PRIMARY_TIMEOUT_MS "abc"');
      expect(() => loadConfigFromEnv()).toThrow('Must be a number');
    });

    it('should reject a CDS-config numeric 0 timeout instead of silently defaulting', async () => {
      const cds = await import('@sap/cds');
      const reqs = (cds.env.requires ??= {} as any);
      const prev = reqs['odatano-core'];
      reqs['odatano-core'] = { backends: ['koios'], primaryTimeoutMs: 0 };
      try {
        // 0 is falsy; a truthiness guard would skip the <=0 check and silently default to 30000.
        expect(() => loadConfigFromEnv()).toThrow('Must be a positive number');
      } finally {
        if (prev === undefined) delete reqs['odatano-core']; else reqs['odatano-core'] = prev;
      }
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

  describe('loadPoolMetadataFetchFromEnv', () => {
    const original = env.POOL_METADATA_FETCH;
    const requires = () => ((cds as any).env.requires ??= {});
    let previousCoreConfig: unknown;

    beforeEach(() => {
      previousCoreConfig = requires()['odatano-core'];
      delete requires()['odatano-core'];
      delete env.POOL_METADATA_FETCH;
    });

    afterEach(() => {
      if (previousCoreConfig === undefined) delete requires()['odatano-core'];
      else requires()['odatano-core'] = previousCoreConfig;
      if (original === undefined) delete env.POOL_METADATA_FETCH;
      else env.POOL_METADATA_FETCH = original;
    });

    it('is off unless configured, and the CDS config wins over the environment', () => {
      expect(loadPoolMetadataFetchFromEnv()).toBe(false);
      env.POOL_METADATA_FETCH = 'true';
      expect(loadPoolMetadataFetchFromEnv()).toBe(true);
      requires()['odatano-core'] = { poolMetadataFetch: false };
      expect(loadPoolMetadataFetchFromEnv()).toBe(false);
    });

    it('refuses a value that is not true or false', () => {
      env.POOL_METADATA_FETCH = 'yes';
      expect(() => loadPoolMetadataFetchFromEnv()).toThrow('Invalid POOL_METADATA_FETCH');
    });
  });

  describe('loadCrawlerConfigFromEnv', () => {
    const crawlerEnvKeys = [
      'CRAWLER_ENABLED',
      'CRAWLER_START_SLOT',
      'CRAWLER_START_HASH',
      'CRAWLER_START_HEIGHT',
      'CRAWLER_SOURCE',
      'CRAWLER_BATCH_SIZE',
      'CRAWLER_CONFIRMATION_DEPTH',
      'CRAWLER_POLL_INTERVAL_MS',
      'CRAWLER_ASSET_HISTORY',
      'CRAWLER_ASSET_CATALOGUE',
      'CRAWLER_ASSET_ENRICH_RATE',
      'CRAWLER_EPOCH_SNAPSHOTS',
      'CRAWLER_ACCOUNT_SNAPSHOTS',
      'CRAWLER_CERTIFICATES',
      'CRAWLER_UTXO_SET',
      'CRAWLER_AUTHORITATIVE',
      'CRAWLER_INPUT_ASSET_COPIES',
    ];
    const originalEnv: Record<string, string | undefined> = {};
    let previousCoreConfig: unknown;

    function setCdsCrawlerConfig(crawler: Record<string, unknown>): void {
      const runtime = cds as any;
      const requires = (runtime.env.requires ??= {});
      requires['odatano-core'] = { crawler };
    }

    beforeEach(() => {
      const runtime = cds as any;
      const requires = (runtime.env.requires ??= {});
      previousCoreConfig = requires['odatano-core'];
      delete requires['odatano-core'];
      for (const key of crawlerEnvKeys) {
        originalEnv[key] = env[key];
        delete env[key];
      }
    });

    afterEach(() => {
      const runtime = cds as any;
      const requires = (runtime.env.requires ??= {});
      if (previousCoreConfig === undefined) delete requires['odatano-core'];
      else requires['odatano-core'] = previousCoreConfig;
      for (const key of crawlerEnvKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    });

    it('returns safe defaults when the crawler is not configured', () => {
      expect(loadCrawlerConfigFromEnv()).toEqual({
        enabled: false,
        startSlot: undefined,
        startBlockHash: undefined,
        startHeight: undefined,
        source: 'auto',
        batchSize: 20,
        confirmationDepth: 3,
        pollIntervalMs: 20_000,
        // analytics coverage: the free by-products on, the provider-billed ones off
        assetHistory: true,
        assetCatalogue: 'bare',
        assetEnrichRate: 2,
        epochSnapshots: false,
        accountSnapshots: false,
        certificates: false,
        utxoSet: false,
        authoritative: false,
        inputAssetCopies: false,
      });
    });

    it('parses valid environment values including numeric boundaries', () => {
      env.CRAWLER_ENABLED = 'true';
      env.CRAWLER_START_SLOT = '0';
      env.CRAWLER_START_HASH = 'a'.repeat(64);
      env.CRAWLER_START_HEIGHT = String(Number.MAX_SAFE_INTEGER);
      env.CRAWLER_SOURCE = 'pagination';
      env.CRAWLER_BATCH_SIZE = '100';
      env.CRAWLER_CONFIRMATION_DEPTH = '0';
      env.CRAWLER_POLL_INTERVAL_MS = '1000';
      env.CRAWLER_ASSET_HISTORY = 'false';
      env.CRAWLER_ASSET_CATALOGUE = 'enrich';
      env.CRAWLER_ASSET_ENRICH_RATE = '20';
      env.CRAWLER_EPOCH_SNAPSHOTS = 'true';
      env.CRAWLER_ACCOUNT_SNAPSHOTS = 'true';
      env.CRAWLER_CERTIFICATES = 'true';
      env.CRAWLER_UTXO_SET = 'true';
      env.CRAWLER_AUTHORITATIVE = 'true';
      env.CRAWLER_INPUT_ASSET_COPIES = 'true';

      expect(loadCrawlerConfigFromEnv()).toEqual({
        enabled: true,
        startSlot: 0,
        startBlockHash: 'a'.repeat(64),
        startHeight: Number.MAX_SAFE_INTEGER,
        source: 'pagination',
        batchSize: 100,
        confirmationDepth: 0,
        pollIntervalMs: 1000,
        assetHistory: false,
        assetCatalogue: 'enrich',
        assetEnrichRate: 20,
        epochSnapshots: true,
        accountSnapshots: true,
        certificates: true,
        utxoSet: true,
        authoritative: true,
        inputAssetCopies: true,
      });
    });

    it('lets an explicit CDS false override CRAWLER_ENABLED=true', () => {
      env.CRAWLER_ENABLED = 'true';
      setCdsCrawlerConfig({ enabled: false });

      expect(loadCrawlerConfigFromEnv().enabled).toBe(false);
    });

    it('rejects an unknown asset-catalogue mode', () => {
      env.CRAWLER_ASSET_CATALOGUE = 'full';
      expect(() => loadCrawlerConfigFromEnv()).toThrow('Invalid CRAWLER_ASSET_CATALOGUE');
    });

    it('refuses account snapshots without epoch snapshots', () => {
      env.CRAWLER_ACCOUNT_SNAPSHOTS = 'true';
      expect(() => loadCrawlerConfigFromEnv()).toThrow('CRAWLER_ACCOUNT_SNAPSHOTS needs CRAWLER_EPOCH_SNAPSHOTS');
      env.CRAWLER_EPOCH_SNAPSHOTS = 'true';
      expect(loadCrawlerConfigFromEnv()).toMatchObject({ epochSnapshots: true, accountSnapshots: true });
    });

    it.each(['CRAWLER_ASSET_HISTORY', 'CRAWLER_EPOCH_SNAPSHOTS', 'CRAWLER_ACCOUNT_SNAPSHOTS', 'CRAWLER_CERTIFICATES', 'CRAWLER_UTXO_SET', 'CRAWLER_AUTHORITATIVE'])('rejects a non-boolean %s', (key) => {
      env[key] = 'sometimes';
      expect(() => loadCrawlerConfigFromEnv()).toThrow(`Invalid ${key}`);
    });

    it('lets CDS config override the coverage knobs, including explicit false', () => {
      env.CRAWLER_ASSET_HISTORY = 'true';
      setCdsCrawlerConfig({ assetHistory: false, assetCatalogue: 'off', epochSnapshots: true, certificates: true });

      const config = loadCrawlerConfigFromEnv();
      expect(config.assetHistory).toBe(false);
      expect(config.assetCatalogue).toBe('off');
      expect(config.epochSnapshots).toBe(true);
      expect(config.certificates).toBe(true);
    });

    it('rejects non-boolean enabled values', () => {
      env.CRAWLER_ENABLED = 'yes';
      expect(() => loadCrawlerConfigFromEnv()).toThrow('Invalid CRAWLER_ENABLED');
    });

    it('requires a complete start point when enabled', () => {
      env.CRAWLER_ENABLED = 'true';
      env.CRAWLER_START_SLOT = '1';
      expect(() => loadCrawlerConfigFromEnv()).toThrow('no start block is configured');
    });

    it.each(['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
      'rejects invalid block hash %p',
      (value) => {
        setCdsCrawlerConfig({ startBlockHash: value });
        expect(() => loadCrawlerConfigFromEnv()).toThrow('exactly 64 hexadecimal characters');
      },
    );

    it.each([
      ['CRAWLER_START_SLOT', '-1'],
      ['CRAWLER_START_SLOT', '1.5'],
      ['CRAWLER_START_SLOT', 'Infinity'],
      ['CRAWLER_START_SLOT', String(Number.MAX_SAFE_INTEGER + 1)],
      ['CRAWLER_START_HEIGHT', '-1'],
      ['CRAWLER_START_HEIGHT', 'NaN'],
      ['CRAWLER_BATCH_SIZE', '0'],
      ['CRAWLER_BATCH_SIZE', '101'],
      ['CRAWLER_BATCH_SIZE', '1.5'],
      ['CRAWLER_CONFIRMATION_DEPTH', '-1'],
      ['CRAWLER_CONFIRMATION_DEPTH', '2161'],
      ['CRAWLER_CONFIRMATION_DEPTH', 'Infinity'],
      ['CRAWLER_POLL_INTERVAL_MS', '999'],
      ['CRAWLER_POLL_INTERVAL_MS', '3600001'],
      ['CRAWLER_POLL_INTERVAL_MS', '1.5'],
      ['CRAWLER_ASSET_ENRICH_RATE', '0'],
      ['CRAWLER_ASSET_ENRICH_RATE', '21'],
      ['CRAWLER_ASSET_ENRICH_RATE', '2.5'],
    ])('rejects invalid %s=%s', (key, value) => {
      env[key] = value;
      expect(() => loadCrawlerConfigFromEnv()).toThrow(`Invalid ${key}`);
    });
  });

  describe('loadHsmConfigFromEnv', () => {
    const hsmKeys = ['HSM_ENABLED', 'HSM_PKCS11_MODULE', 'HSM_PIN', 'HSM_SLOT', 'HSM_KEY_ID', 'HSM_KEY_LABEL', 'HSM_REQUIRES_ROLE'];
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
      env.HSM_REQUIRES_ROLE = 'HsmSigner';

      const config = loadHsmConfigFromEnv();
      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.pkcs11Module).toBe('/usr/lib/pkcs11/yubihsm.so');
      expect(config!.pin).toBe('1234');
      expect(config!.slot).toBe(2);
      expect(config!.keyId).toBe('0x0001');
      expect(config!.keyLabel).toBe('my-key');
      expect(config!.requiresRole).toBe('HsmSigner');
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
      env.HSM_REQUIRES_ROLE = 'HsmSigner';

      const config = loadHsmConfigFromEnv();
      expect(config!.slot).toBe(0);
    });

    it('should throw when HSM_REQUIRES_ROLE is missing (fail-closed)', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      env.HSM_PIN = '1234';
      expect(() => loadHsmConfigFromEnv()).toThrow('HSM_REQUIRES_ROLE');
    });

    it('should throw on invalid negative HSM slot', () => {
      env.HSM_ENABLED = 'true';
      env.HSM_PKCS11_MODULE = '/usr/lib/pkcs11/yubihsm.so';
      env.HSM_PIN = '1234';
      env.HSM_SLOT = '-1';

      expect(() => loadHsmConfigFromEnv()).toThrow('Invalid HSM slot');
    });
  });

  describe('loadWalletWorkerConfigFromEnv', () => {
    const workerKeys = ['WALLET_WORKER_ENABLED', 'WALLET_WORKER_WALLETS'];
    const originalEnv: Record<string, string | undefined> = {};
    const wallets = (entries: unknown[]) => { env.WALLET_WORKER_WALLETS = JSON.stringify(entries); };

    beforeEach(() => {
      for (const key of workerKeys) {
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

    it('is off without configuration', () => {
      expect(loadWalletWorkerConfigFromEnv()).toMatchObject({ enabled: false, wallets: [] });
    });

    it('reads wallets and leaves requiresRole out where the entry has none', () => {
      env.WALLET_WORKER_ENABLED = 'true';
      wallets([
        { walletId: 'treasury', signerType: 'software', keyEnv: 'TREASURY_KEY', requiresRole: ' Treasurer ' },
        { walletId: 'payouts', signerType: 'software', keyEnv: 'PAYOUT_KEY', requiresRole: null },
        { walletId: 'vault', signerType: 'hsm' },
      ]);

      expect(loadWalletWorkerConfigFromEnv().wallets).toEqual([
        { walletId: 'treasury', signerType: 'software', keyEnv: 'TREASURY_KEY', requiresRole: 'Treasurer' },
        { walletId: 'payouts', signerType: 'software', keyEnv: 'PAYOUT_KEY' },
        { walletId: 'vault', signerType: 'hsm', keyEnv: undefined },
      ]);
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['not a string', 7],
      ['longer than 100 characters', 'r'.repeat(101)],
    ])('rejects a requiresRole that is %s', (_label, requiresRole) => {
      wallets([{ walletId: 'treasury', signerType: 'software', keyEnv: 'TREASURY_KEY', requiresRole }]);
      expect(() => loadWalletWorkerConfigFromEnv()).toThrow('Wallet "treasury": requiresRole must be a role name');
    });

    it('rejects a software wallet without keyEnv and a duplicate walletId', () => {
      wallets([{ walletId: 'treasury', signerType: 'software' }]);
      expect(() => loadWalletWorkerConfigFromEnv()).toThrow('has no keyEnv');

      wallets([{ walletId: 'vault', signerType: 'hsm' }, { walletId: 'vault', signerType: 'hsm' }]);
      expect(() => loadWalletWorkerConfigFromEnv()).toThrow('Duplicate walletId "vault"');
    });

    it('refuses to enable the worker without wallets', () => {
      env.WALLET_WORKER_ENABLED = 'true';
      expect(() => loadWalletWorkerConfigFromEnv()).toThrow('no wallets are configured');
    });
  });
});
