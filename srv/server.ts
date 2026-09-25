import cds from '@sap/cds';
import { CardanoClient, CardanoClientConfig, Network,BackendName,TransactionBuilderName } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import type { LedgerProtocolParameters, HsmConfig } from './utils/types';
import { HsmSigner, getHsmSigner, setHsmSigner } from './blockchain/signing/hsm-signer';
import { ConfigError, ProviderUnavailableError } from './utils/errors';
import { setActiveNetwork } from './utils/network-context';
import { installDbSanitizer } from './utils/db-sanitize';
import { ensureDbIndexes } from './utils/db-indexes';
import { installPostgresOrderNulls } from './utils/pg-order-nulls';
import { startCrawler, stopCrawler } from './blockchain/crawler';
import type { CrawlerConfig } from './blockchain/crawler/crawler';
import { startWalletWorker, stopWalletWorker } from './blockchain/wallet-worker';
import type { WalletWorkerConfig } from './blockchain/wallet-worker';
import type { WorkerWalletConfig } from './blockchain/wallet-worker/signers';
import { activateAgentGrants } from './utils/agent-grants-config';

import { env } from 'process';

const logger = cds.log('ODATANO');

const VALID_NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];
const VALID_BACKENDS: BackendName[] = ['blockfrost', 'koios', 'ogmios'];

const CRAWLER_LIMITS = {
  batchSize: { min: 1, max: 100 },
  confirmationDepth: { min: 0, max: 2160 },
  pollIntervalMs: { min: 1000, max: 3_600_000 },
  assetEnrichRate: { min: 1, max: 20 },
} as const;

const VALID_ASSET_CATALOGUE_MODES = ['off', 'bare', 'enrich'] as const;

/** Parse a boolean crawler flag that defaults to `fallback` when unset. */
function crawlerBoolean(raw: unknown, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be true or false.`);
}

/** Parse an integer without allowing JavaScript's lossy/implicit coercions. */
function crawlerInteger(
  raw: unknown,
  name: string,
  min: number,
  max: number,
  defaultValue?: number,
): number | undefined {
  if (raw == null) return defaultValue;
  if (
    (typeof raw !== 'number' && typeof raw !== 'string')
    || (typeof raw === 'string' && raw.trim() === '')
  ) {
    throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be an integer between ${min} and ${max}.`);
  }

  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/** Blockchain components created once at bootstrap and shared across services. */
interface AppContext {
  cardanoClient: CardanoClient;
  cardanoIndexer: CardanoIndexer;
  cardanoTxBuilder: CardanoTransactionBuilder;
}

let appContext: AppContext | null = null;
let bootstrapError: Error | null = null;

/**
 * Initialize the application context; every start path (standalone hook, plugin) comes through here.
 * @param protocolParams - optional, lets tests skip the backend call
 */
async function initializeAppContext(
  config: CardanoClientConfig,
  protocolParams?: LedgerProtocolParameters,
  hsmConfig?: HsmConfig,
): Promise<AppContext> {
  logger.debug('Initializing blockchain components...');

  // Database first. Postgres ORDER BY without a NULLS clause on key / NOT NULL columns so
  // the indexes serve `$top` / `$orderby`; then the secondary indexes the model cannot declare.
  installPostgresOrderNulls();
  try {
    await ensureDbIndexes();
  } catch (err) {
    logger.warn('secondary indexes not ensured (non-fatal):', err);
  }

  const cardanoClient = new CardanoClient(config);

  // Lets leaf utilities (network-aware validators) read the network without importing this module.
  setActiveNetwork(config.network);

  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init(protocolParams);

  // PostgreSQL rejects U+0000 in text/JSON; one db-level `before` hook covers every write.
  if (installDbSanitizer()) logger.debug('DB NUL sanitizer installed');

  const cardanoIndexer = new CardanoIndexer(cardanoClient, cardanoTxBuilder);

  // HSM signer failure is non-fatal
  if (hsmConfig?.enabled) {
    try {
      const hsmSigner = new HsmSigner(hsmConfig);
      await hsmSigner.init(config.network);
      setHsmSigner(hsmSigner);
      logger.debug('HSM signer initialized');
    } catch (err) {
      logger.error('Failed to initialize HSM signer:', err);
      setHsmSigner(null);
    }
  }

  logger.info('Blockchain components initialized successfully');

  return {
    cardanoClient,
    cardanoIndexer,
    cardanoTxBuilder,
  };
}

/** Agent-grant feature switch; its own module so src/plugin.ts can read it at load. */
export { loadAgentGrantsConfig, activateAgentGrants } from './utils/agent-grants-config';

// Standalone mode never loads src/plugin.ts, so swap the auth impl here as well
// (bin/serve.js imports this file before the middlewares exist). Idempotent.
activateAgentGrants();

/**
 * The application context.
 * @throws {ProviderUnavailableError} 503 when uninitialized; a bootstrap failure is appended as cause.
 */
export function getAppContext(): AppContext {
  if (!appContext) {
    const base = 'Application not initialized. This should be called after cds.served event.';
    const msg = bootstrapError
      ? `${base} Bootstrap failed: ${bootstrapError.message}`
      : base;
    throw new ProviderUnavailableError(msg, 'odatano-bootstrap', undefined, bootstrapError ?? undefined);
  }
  return appContext;
}

export function getCardanoIndexer(): CardanoIndexer {
  return getAppContext().cardanoIndexer;
}

export function getCardanoClient(): CardanoClient {
  return getAppContext().cardanoClient;
}

export function getCardanoTxBuilder(): CardanoTransactionBuilder {
  return getAppContext().cardanoTxBuilder;
}

let hsmConfigInstance: HsmConfig | undefined;

/** HSM configuration when enabled; the sign service reads requiresRole from it. */
export function getHsmConfig(): HsmConfig | undefined {
  return hsmConfigInstance;
}

/**
 * Initialize from a pre-built config (plugin path). Idempotent: a second call must not
 * create a duplicate CardanoClient; tests reinitialize via resetAppContext() / createTestContext().
 */
export async function initializeFromConfig(config: CardanoClientConfig, protocolParams?: LedgerProtocolParameters, hsmConfig?: HsmConfig): Promise<void> {
  if (appContext) {
    logger.debug('initializeFromConfig: appContext already initialized, skipping');
    return;
  }
  hsmConfigInstance = hsmConfig;
  try {
    appContext = await initializeAppContext(config, protocolParams, hsmConfig);
    bootstrapError = null;
  } catch (err) {
    // Keep the cause so getAppContext() can surface a structured 503 in plugin mode too.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    throw err;
  }
}

/** Reset the application context (tests only); lets tests inject their own instances. */
export function resetAppContext(context: AppContext | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetAppContext() is not available in production');
  }
  appContext = context;
  bootstrapError = null;
  setActiveNetwork(context?.cardanoClient.network ?? null);
  logger.debug('Application context reset');
}

/**
 * Create an isolated test context with the given backends.
 * @param _txBuilderName ignored; Buildooor is the sole builder (kept for signature compatibility)
 * @param protocolParams optional, skips the backend call during init
 */
export async function createTestContext(
  backends: BackendName[],
  _txBuilderName: TransactionBuilderName = 'buildooor',
  protocolParams?: LedgerProtocolParameters
): Promise<AppContext> {
  const config: CardanoClientConfig = {
    network: (env.NETWORK as Network) || 'preview',
    backends,
    blockfrostApiKey: env.BLOCKFROST_API_KEY || '',
    blockfrostCustomBackend: env.BLOCKFROST_CUSTOM_BACKEND || undefined,
    koiosApiKey: env.KOIOS_API_KEY || '',
    ogmiosUrl: env.OGMIOS_URL || '',
    transactionBuilders: ['buildooor'],
    primaryTimeoutMs: Number(env.PRIMARY_TIMEOUT_MS) || 30000,   // || intentional: NaN (missing env var) falls back to default
    fallbackTimeoutMs: Number(env.FALLBACK_TIMEOUT_MS) || 60000,
    indexTtlMs: Number(env.INDEX_TTL_MS) || 3600000,
  };

  return await initializeAppContext(config, protocolParams);
}

/** Stop worker and crawler, then close all backend connections. */
export async function shutdownAppContext(): Promise<void> {
  // Worker and crawler first: their in-flight writes must not hit a torn-down client.
  try {
    await stopWalletWorker();
  } catch (err) {
    logger.warn('Wallet worker shutdown failed (continuing):', err);
  }

  try {
    await stopCrawler();
  } catch (err) {
    logger.warn('Crawler shutdown failed (continuing):', err);
  }

  if (appContext) {
    logger.info('Shutting down application context...');

    const hsm = getHsmSigner();
    if (hsm) {
      hsm.shutdown();
      setHsmSigner(null);
      logger.debug('HSM signer shutdown');
    }

    await appContext.cardanoClient.shutdown();
    appContext = null;
    setActiveNetwork(null);
  }
}


/**
 * Load and validate CardanoClientConfig.
 * Priority: cds.env.requires["odatano-core"].X > process.env.X > default.
 * @throws {ConfigError} if any value is invalid
 */
export function loadConfigFromEnv(): CardanoClientConfig {
  const cdsConfig = (cds.env?.requires as Record<string, any>)?.['odatano-core'] ?? {};

  const network = (cdsConfig.network || env.NETWORK || 'preview') as Network;
  if (!VALID_NETWORKS.includes(network)) {
    throw new ConfigError(`Invalid NETWORK "${cdsConfig.network || env.NETWORK}". Must be one of: ${VALID_NETWORKS.join(', ')}`);
  }

  const backendStrings: string[] = cdsConfig.backends
    || (env.BACKENDS ? env.BACKENDS.split(',').map(b => b.trim()) : ['koios']);
  const invalidBackends = backendStrings.filter(b => !(VALID_BACKENDS as readonly string[]).includes(b));
  if (invalidBackends.length > 0) {
    throw new ConfigError(`Invalid BACKENDS: "${invalidBackends.join(', ')}". Must be one of: ${VALID_BACKENDS.join(', ')}`);
  }
  const backends = backendStrings as BackendName[];

  // Buildooor is the sole transaction builder; txBuilders/TX_BUILDERS config is ignored.
  const txBuilders: TransactionBuilderName[] = ['buildooor'];

  const primaryTimeout = cdsConfig.primaryTimeoutMs ?? env.PRIMARY_TIMEOUT_MS;
  const fallbackTimeout = cdsConfig.fallbackTimeoutMs ?? env.FALLBACK_TIMEOUT_MS;

  // `!= null`, not truthiness: a CDS-config 0 must reach the <= 0 check.
  if (primaryTimeout != null && isNaN(Number(primaryTimeout))) {
    throw new ConfigError(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a number.`);
  }
  if (primaryTimeout != null && Number(primaryTimeout) <= 0) {
    throw new ConfigError(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a positive number.`);
  }
  if (fallbackTimeout != null && isNaN(Number(fallbackTimeout))) {
    throw new ConfigError(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a number.`);
  }
  if (fallbackTimeout != null && Number(fallbackTimeout) <= 0) {
    throw new ConfigError(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a positive number.`);
  }

  const blockfrostApiKey = cdsConfig.blockfrostApiKey || env.BLOCKFROST_API_KEY || '';
  const blockfrostCustomBackend = cdsConfig.blockfrostCustomBackend || env.BLOCKFROST_CUSTOM_BACKEND || '';
  if (blockfrostCustomBackend && !/^https?:\/\//i.test(blockfrostCustomBackend)) {
    throw new ConfigError(
      `Invalid BLOCKFROST_CUSTOM_BACKEND "${blockfrostCustomBackend}". Must be an http(s) URL ` +
      `(e.g. http://localhost:3010/api/v0).`
    );
  }
  const koiosApiKey = cdsConfig.koiosApiKey || env.KOIOS_API_KEY || '';
  const ogmiosUrl = cdsConfig.ogmiosUrl || env.OGMIOS_URL || '';

  if (backends.includes('blockfrost') && !blockfrostApiKey && !blockfrostCustomBackend) {
    logger.warn('Neither BLOCKFROST_API_KEY nor BLOCKFROST_CUSTOM_BACKEND is set but blockfrost is listed in BACKENDS');
  } else if (backends.includes('blockfrost') && blockfrostCustomBackend) {
    logger.info(`Blockfrost will use customBackend: ${blockfrostCustomBackend}`);
  }
  if (backends.includes('ogmios') && !ogmiosUrl) {
    logger.warn('OGMIOS_URL is not set but ogmios is listed in BACKENDS');
  }

  return {
    network,
    backends,
    blockfrostApiKey,
    blockfrostCustomBackend: blockfrostCustomBackend || undefined,
    koiosApiKey,
    ogmiosUrl,
    transactionBuilders: txBuilders,
    primaryTimeoutMs: Number(primaryTimeout) || 30000,   // || intentional: NaN (missing config) falls back to default
    fallbackTimeoutMs: Number(fallbackTimeout) || 60000,
    indexTtlMs: Number(cdsConfig.indexTtlMs ?? env.INDEX_TTL_MS) || 3600000,
  };
}

/**
 * Load the HSM configuration (cds.requires.odatano-core.hsm.* or HSM_* env vars).
 * Returns undefined when HSM is not enabled.
 */
export function loadHsmConfigFromEnv(): HsmConfig | undefined {
  const cdsConfig = (cds.env?.requires as Record<string, any>)?.['odatano-core'] ?? {};
  const hsmCds = cdsConfig.hsm ?? {};

  const hsmEnabled = hsmCds.enabled === true || env.HSM_ENABLED === 'true';
  if (!hsmEnabled) return undefined;

  const pkcs11Module = hsmCds.pkcs11Module || env.HSM_PKCS11_MODULE || '';
  if (!pkcs11Module) {
    throw new ConfigError('HSM_PKCS11_MODULE is required when HSM is enabled');
  }

  const pin = hsmCds.pin || env.HSM_PIN || '';
  if (!pin) {
    throw new ConfigError('HSM_PIN is required when HSM is enabled');
  }

  const slot = Number(hsmCds.slot ?? env.HSM_SLOT ?? 0);
  if (!Number.isInteger(slot) || slot < 0) {
    throw new ConfigError(`Invalid HSM slot: "${hsmCds.slot ?? env.HSM_SLOT}" — must be a non-negative integer`);
  }

  // Fail closed: the HSM holds a real signing key, so an explicit role gate is mandatory.
  const requiresRole = hsmCds.requiresRole || env.HSM_REQUIRES_ROLE || '';
  if (!requiresRole) {
    throw new ConfigError('HSM_REQUIRES_ROLE (or cds.requires.odatano-core.hsm.requiresRole) is required when HSM is enabled — set it to the XSUAA scope name allowed to invoke HSM signing actions');
  }

  return {
    enabled: true,
    pkcs11Module,
    slot,
    pin,
    keyId: hsmCds.keyId || env.HSM_KEY_ID,
    keyLabel: hsmCds.keyLabel || env.HSM_KEY_LABEL,
    requiresRole,
  };
}

/**
 * Load the chain-crawler configuration (cds.requires.odatano-core.crawler.* or CRAWLER_* env vars).
 * Returns { enabled: false } when the crawler is off (the default).
 */
export function loadCrawlerConfigFromEnv(): CrawlerConfig {
  const cdsConfig = (cds.env?.requires as Record<string, any>)?.['odatano-core'] ?? {};
  const c = cdsConfig.crawler ?? {};

  // A CDS value, including an explicit `false`, wins over the environment.
  const enabledRaw = c.enabled !== undefined ? c.enabled : env.CRAWLER_ENABLED;
  let enabled = false;
  if (enabledRaw === true || enabledRaw === 'true') {
    enabled = true;
  } else if (enabledRaw !== undefined && enabledRaw !== false && enabledRaw !== 'false') {
    throw new ConfigError(`Invalid CRAWLER_ENABLED "${String(enabledRaw)}". Must be true or false.`);
  }

  const startSlot = crawlerInteger(
    c.startSlot ?? env.CRAWLER_START_SLOT,
    'CRAWLER_START_SLOT',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const startHeight = crawlerInteger(
    c.startHeight ?? env.CRAWLER_START_HEIGHT,
    'CRAWLER_START_HEIGHT',
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const startBlockHashRaw = c.startBlockHash ?? env.CRAWLER_START_HASH;
  if (startBlockHashRaw != null && (typeof startBlockHashRaw !== 'string' || !/^[0-9a-f]{64}$/i.test(startBlockHashRaw.trim()))) {
    throw new ConfigError('Invalid CRAWLER_START_HASH. Must be exactly 64 hexadecimal characters.');
  }
  const startBlockHash = startBlockHashRaw?.trim() || undefined;
  const source = (c.source ?? env.CRAWLER_SOURCE ?? 'auto') as CrawlerConfig['source'];
  const batchSize = crawlerInteger(
    c.batchSize ?? env.CRAWLER_BATCH_SIZE,
    'CRAWLER_BATCH_SIZE',
    CRAWLER_LIMITS.batchSize.min,
    CRAWLER_LIMITS.batchSize.max,
    20,
  )!;
  const confirmationDepth = crawlerInteger(
    c.confirmationDepth ?? env.CRAWLER_CONFIRMATION_DEPTH,
    'CRAWLER_CONFIRMATION_DEPTH',
    CRAWLER_LIMITS.confirmationDepth.min,
    CRAWLER_LIMITS.confirmationDepth.max,
    3,
  )!;
  const pollIntervalMs = crawlerInteger(
    c.pollIntervalMs ?? env.CRAWLER_POLL_INTERVAL_MS,
    'CRAWLER_POLL_INTERVAL_MS',
    CRAWLER_LIMITS.pollIntervalMs.min,
    CRAWLER_LIMITS.pollIntervalMs.max,
    20_000,
  )!;

  if (enabled && (startSlot == null || Number.isNaN(startSlot) || !startBlockHash)) {
    throw new ConfigError(
      'Crawler is enabled but no start block is configured — set crawler.startSlot + crawler.startBlockHash ' +
      '(or CRAWLER_START_SLOT + CRAWLER_START_HASH).'
    );
  }
  if (!['ogmios', 'pagination', 'auto'].includes(source)) {
    throw new ConfigError(`Invalid CRAWLER_SOURCE "${source}". Must be one of: ogmios, pagination, auto.`);
  }

  // Analytics coverage: mint/burn and the bare catalogue are free by-products of a crawled
  // block and on by default; enrichment and epoch snapshots cost provider calls and are opt-in.
  const assetHistory = crawlerBoolean(
    c.assetHistory ?? env.CRAWLER_ASSET_HISTORY, 'CRAWLER_ASSET_HISTORY', true,
  );
  const assetCatalogue = (c.assetCatalogue ?? env.CRAWLER_ASSET_CATALOGUE ?? 'bare') as CrawlerConfig['assetCatalogue'];
  if (!VALID_ASSET_CATALOGUE_MODES.includes(assetCatalogue)) {
    throw new ConfigError(
      `Invalid CRAWLER_ASSET_CATALOGUE "${assetCatalogue}". Must be one of: ${VALID_ASSET_CATALOGUE_MODES.join(', ')}.`
    );
  }
  const assetEnrichRate = crawlerInteger(
    c.assetEnrichRate ?? env.CRAWLER_ASSET_ENRICH_RATE,
    'CRAWLER_ASSET_ENRICH_RATE',
    CRAWLER_LIMITS.assetEnrichRate.min,
    CRAWLER_LIMITS.assetEnrichRate.max,
    2,
  )!;
  const epochSnapshots = crawlerBoolean(
    c.epochSnapshots ?? env.CRAWLER_EPOCH_SNAPSHOTS, 'CRAWLER_EPOCH_SNAPSHOTS', false,
  );
  // Certificates + withdrawals are block content (no extra request) but opt-in to keep write volume stable.
  const certificates = crawlerBoolean(
    c.certificates ?? env.CRAWLER_CERTIFICATES, 'CRAWLER_CERTIFICATES', false,
  );
  // UTxO set: opt-in, inert until a snapshot has been imported (importUtxoSet).
  const utxoSet = crawlerBoolean(
    c.utxoSet ?? env.CRAWLER_UTXO_SET, 'CRAWLER_UTXO_SET', false,
  );

  return {
    enabled, startSlot, startBlockHash, startHeight, source, batchSize, confirmationDepth, pollIntervalMs,
    assetHistory, assetCatalogue, assetEnrichRate, epochSnapshots, certificates, utxoSet,
  };
}

/** Start the crawler if enabled and the app context is ready. Never throws; idempotent. */
export async function startCrawlerIfConfigured(): Promise<void> {
  if (env.SKIP_AUTO_INIT === 'true' || !appContext) return;
  let config: CrawlerConfig;
  try {
    config = loadCrawlerConfigFromEnv();
  } catch (err) {
    logger.error('Invalid crawler configuration — crawler not started:', err);
    return;
  }
  if (!config.enabled) return;

  try {
    await startCrawler({
      client: appContext.cardanoClient,
      indexer: appContext.cardanoIndexer,
      network: appContext.cardanoClient.network,
      config,
    });
    logger.info(`Chain crawler started (source=${config.source}, start=${config.startBlockHash})`);
  } catch (err) {
    logger.error('Failed to start chain crawler (non-fatal):', err);
  }
}

const WALLET_WORKER_LIMITS = {
  maxConcurrentWallets: { min: 1, max: 64 },
  confirmationDepth: { min: 1, max: 2160 },
  confirmationTimeoutMs: { min: 30_000, max: 86_400_000 },
  pollIntervalMs: { min: 500, max: 3_600_000 },
  maxAttempts: { min: 1, max: 10 },
} as const;

/**
 * Load the wallet-worker configuration (cds.requires.odatano-core.walletWorker.* or WALLET_WORKER_* env vars).
 * Returns { enabled: false } when the worker is off (the default).
 */
export function loadWalletWorkerConfigFromEnv(): WalletWorkerConfig {
  const cdsConfig = (cds.env?.requires as Record<string, any>)?.['odatano-core'] ?? {};
  const w = cdsConfig.walletWorker ?? {};

  const enabledRaw = w.enabled !== undefined ? w.enabled : env.WALLET_WORKER_ENABLED;
  let enabled = false;
  if (enabledRaw === true || enabledRaw === 'true') {
    enabled = true;
  } else if (enabledRaw !== undefined && enabledRaw !== false && enabledRaw !== 'false') {
    throw new ConfigError(`Invalid WALLET_WORKER_ENABLED "${String(enabledRaw)}". Must be true or false.`);
  }

  let walletsRaw: unknown = w.wallets ?? undefined;
  if (walletsRaw === undefined && env.WALLET_WORKER_WALLETS) {
    try {
      walletsRaw = JSON.parse(env.WALLET_WORKER_WALLETS);
    } catch {
      throw new ConfigError('Invalid WALLET_WORKER_WALLETS — must be a JSON array of { walletId, signerType, keyEnv? }.');
    }
  }
  const wallets: WorkerWalletConfig[] = [];
  if (walletsRaw !== undefined) {
    if (!Array.isArray(walletsRaw)) {
      throw new ConfigError('Invalid walletWorker.wallets — must be an array of { walletId, signerType, keyEnv? }.');
    }
    for (const entry of walletsRaw) {
      const walletId = typeof entry?.walletId === 'string' ? entry.walletId.trim() : '';
      const signerType = entry?.signerType;
      if (!walletId || (signerType !== 'hsm' && signerType !== 'software')) {
        throw new ConfigError(`Invalid wallet entry ${JSON.stringify(entry)} — walletId and signerType (hsm|software) are required.`);
      }
      if (signerType === 'software' && (typeof entry.keyEnv !== 'string' || !entry.keyEnv.trim())) {
        throw new ConfigError(`Wallet "${walletId}" is signerType=software but has no keyEnv (name of the env var holding the signing key).`);
      }
      if (wallets.some((existing) => existing.walletId === walletId)) {
        throw new ConfigError(`Duplicate walletId "${walletId}" in walletWorker.wallets.`);
      }
      wallets.push({ walletId, signerType, keyEnv: entry.keyEnv });
    }
  }

  const maxConcurrentWallets = crawlerInteger(
    w.maxConcurrentWallets ?? env.WALLET_WORKER_MAX_CONCURRENT,
    'WALLET_WORKER_MAX_CONCURRENT',
    WALLET_WORKER_LIMITS.maxConcurrentWallets.min,
    WALLET_WORKER_LIMITS.maxConcurrentWallets.max,
    4,
  )!;
  const confirmationDepth = crawlerInteger(
    w.confirmationDepth ?? env.WALLET_WORKER_CONFIRMATION_DEPTH,
    'WALLET_WORKER_CONFIRMATION_DEPTH',
    WALLET_WORKER_LIMITS.confirmationDepth.min,
    WALLET_WORKER_LIMITS.confirmationDepth.max,
    3,
  )!;
  const confirmationTimeoutMs = crawlerInteger(
    w.confirmationTimeoutMs ?? env.WALLET_WORKER_CONFIRMATION_TIMEOUT_MS,
    'WALLET_WORKER_CONFIRMATION_TIMEOUT_MS',
    WALLET_WORKER_LIMITS.confirmationTimeoutMs.min,
    WALLET_WORKER_LIMITS.confirmationTimeoutMs.max,
    600_000,
  )!;
  const pollIntervalMs = crawlerInteger(
    w.pollIntervalMs ?? env.WALLET_WORKER_POLL_INTERVAL_MS,
    'WALLET_WORKER_POLL_INTERVAL_MS',
    WALLET_WORKER_LIMITS.pollIntervalMs.min,
    WALLET_WORKER_LIMITS.pollIntervalMs.max,
    2_000,
  )!;
  const defaultMaxAttempts = crawlerInteger(
    w.defaultMaxAttempts ?? env.WALLET_WORKER_MAX_ATTEMPTS,
    'WALLET_WORKER_MAX_ATTEMPTS',
    WALLET_WORKER_LIMITS.maxAttempts.min,
    WALLET_WORKER_LIMITS.maxAttempts.max,
    3,
  )!;

  const resubmitRaw = w.resubmitOnRollback !== undefined ? w.resubmitOnRollback : env.WALLET_WORKER_RESUBMIT_ON_ROLLBACK;
  let resubmitOnRollback = true;
  if (resubmitRaw === false || resubmitRaw === 'false') {
    resubmitOnRollback = false;
  } else if (resubmitRaw !== undefined && resubmitRaw !== true && resubmitRaw !== 'true') {
    throw new ConfigError(`Invalid WALLET_WORKER_RESUBMIT_ON_ROLLBACK "${String(resubmitRaw)}". Must be true or false.`);
  }

  if (enabled && wallets.length === 0) {
    throw new ConfigError(
      'Wallet worker is enabled but no wallets are configured — set walletWorker.wallets (or WALLET_WORKER_WALLETS).',
    );
  }

  return {
    enabled,
    wallets,
    maxConcurrentWallets,
    confirmationDepth,
    confirmationTimeoutMs,
    pollIntervalMs,
    defaultMaxAttempts,
    resubmitOnRollback,
  };
}

/** Start the wallet worker if enabled and the app context is ready. Never throws; idempotent. */
export async function startWalletWorkerIfConfigured(): Promise<void> {
  if (env.SKIP_AUTO_INIT === 'true' || !appContext) return;
  let config: WalletWorkerConfig;
  try {
    config = loadWalletWorkerConfigFromEnv();
  } catch (err) {
    logger.error('Invalid wallet-worker configuration — worker not started:', err);
    return;
  }
  if (!config.enabled) return;

  try {
    await startWalletWorker({
      client: appContext.cardanoClient,
      indexer: appContext.cardanoIndexer,
      network: appContext.cardanoClient.network,
      config,
    });
    logger.info(`Wallet worker started (wallets=${config.wallets.map((w2) => w2.walletId).join(',')})`);
  } catch (err) {
    logger.error('Failed to start wallet worker (non-fatal):', err);
  }
}

/**
 * Re-drive deferred submissions claimed as 'submitting' whose detached submit never ran
 * (process died first). Idempotent: an already submitted tx finalizes via
 * TransactionAlreadySubmittedError. Never throws.
 */
export async function redriveInterruptedSubmissionsIfConfigured(): Promise<void> {
  if (env.SKIP_AUTO_INIT === 'true' || !appContext) return;
  try {
    const { redriveInterruptedSubmissions } = require('./blockchain/signing/submission-finalizer') as typeof import('./blockchain/signing/submission-finalizer');
    const attempted = await redriveInterruptedSubmissions();
    if (attempted > 0) logger.info(`Re-drove ${attempted} interrupted deferred submission(s)`);
  } catch (err) {
    logger.error('Failed to re-drive interrupted submissions (non-fatal):', err);
  }
}

// Standalone bootstrap; skipped when the plugin already initialized the context.
cds.on('served', async () => {
  if (appContext) return;

  // SKIP_AUTO_INIT: tests with mocked backends
  if (env.SKIP_AUTO_INIT === 'true') {
    logger.info('Skipping auto-initialization (SKIP_AUTO_INIT=true)');
    return;
  }

  // Config loading stays inside the try: a ConfigError must never crash the host app.
  let config: ReturnType<typeof loadConfigFromEnv> | undefined;
  try {
    config = loadConfigFromEnv();
    const hsmConfig = loadHsmConfigFromEnv();
    hsmConfigInstance = hsmConfig;
    appContext = await initializeAppContext(config, undefined, hsmConfig);
    bootstrapError = null;
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    // Never throw; keep the cause so getAppContext() surfaces a structured 503.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    // stderr directly: the cause stays visible when a test runner silences console.error.
    const where = config ? `backends={${config.backends.join(',')}} network=${config.network}` : 'config load';
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`[ODATANO] Failed to initialize blockchain components — ${where}\n${msg}\n`);
    logger.error('Failed to initialize blockchain components:', err);
  }

  // Optional subsystems; each is non-fatal.
  await startCrawlerIfConfigured();
  await startWalletWorkerIfConfigured();
  await redriveInterruptedSubmissionsIfConfigured();
});

cds.on('shutdown', async () => {
  await shutdownAppContext();
});
