import cds from '@sap/cds';
import { CardanoClient, CardanoClientConfig, Network,BackendName,TransactionBuilderName } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import type { LedgerProtocolParameters, HsmConfig } from './utils/types';
import { HsmSigner, getHsmSigner, setHsmSigner } from './blockchain/signing/hsm-signer';
import { ConfigError, ProviderUnavailableError } from './utils/errors';
import { setActiveNetwork } from './utils/network-context';
import { startCrawler, stopCrawler } from './blockchain/crawler';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

import { env } from 'process';

const logger = cds.log('ODATANO');

const VALID_NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];
const VALID_BACKENDS: BackendName[] = ['blockfrost', 'koios', 'ogmios'];

/**
 * Application context holding initialized blockchain components
 * These are created once during CAP bootstrap and shared across services
 */
interface AppContext {
  cardanoClient: CardanoClient;
  cardanoIndexer: CardanoIndexer;
  cardanoTxBuilder: CardanoTransactionBuilder;
}

let appContext: AppContext | null = null;
let bootstrapError: Error | null = null;

/**
 * Initialize the application context with blockchain components
 * Called once during CAP server startup via cds.on('served')
 * @param config - CardanoClientConfig
 * @param protocolParams - Optional protocol parameters (for tests to skip backend call)
 */
async function initializeAppContext(
  config: CardanoClientConfig,
  protocolParams?: LedgerProtocolParameters,
  hsmConfig?: HsmConfig,
): Promise<AppContext> {
  logger.debug('Initializing blockchain components...');

  // Create CardanoClient from configuration
  const cardanoClient = new CardanoClient(config);

  // Publish the active network for leaf utilities (e.g. network-aware validators)
  // without forcing them to import this module / the full server graph.
  setActiveNetwork(config.network);

  // Create CardanoTransactionBuilder with the client
  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init(protocolParams);

  // Create CardanoIndexer with client and transaction builder
  const cardanoIndexer = new CardanoIndexer(cardanoClient, cardanoTxBuilder);

  // Initialize HSM signer if configured (failure is non-fatal — won't crash the app)
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

/**
 * Get the application context (must be called after bootstrap)
 * @throws {ProviderUnavailableError} 503 when uninitialized — request handlers using
 *   handleRequest/mapError translate this into a clean 503 response instead of a raw 500.
 *   If bootstrap actively failed, the cause is appended to the message.
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

/**
 * Get the CardanoIndexer instance
 * Convenience function for services
 */
export function getCardanoIndexer(): CardanoIndexer {
  return getAppContext().cardanoIndexer;
}

/**
 * Get the CardanoClient instance
 * Convenience function for services
 */
export function getCardanoClient(): CardanoClient {
  return getAppContext().cardanoClient;
}

/**
 * Get the CardanoTransactionBuilder instance
 * Convenience function for services and plugin consumers
 */
export function getCardanoTxBuilder(): CardanoTransactionBuilder {
  return getAppContext().cardanoTxBuilder;
}

let hsmConfigInstance: HsmConfig | undefined;

/**
 * Get the HSM configuration (if HSM is enabled).
 * Used by sign service to check requiresRole.
 */
export function getHsmConfig(): HsmConfig | undefined {
  return hsmConfigInstance;
}

/**
 * Initialize from a pre-built config (used by plugin's src/index.ts)
 * @param config - validated CardanoClientConfig
 * @param protocolParams - Optional protocol parameters (for tests)
 */
export async function initializeFromConfig(config: CardanoClientConfig, protocolParams?: LedgerProtocolParameters, hsmConfig?: HsmConfig): Promise<void> {
  // Idempotent: a previous call (plugin's cds.on('served'), server.ts's served hook,
  // or an earlier programmatic initialize()) already built the context. Direct callers
  // such as @odatano/x402's bridge must not produce a duplicate CardanoClient.
  // Tests that need to reinitialize should use resetAppContext() / createTestContext().
  if (appContext) {
    logger.debug('initializeFromConfig: appContext already initialized, skipping');
    return;
  }
  hsmConfigInstance = hsmConfig;
  try {
    appContext = await initializeAppContext(config, protocolParams, hsmConfig);
    bootstrapError = null;
  } catch (err) {
    // Capture the cause so getAppContext() surfaces a structured 503 with diagnostics
    // even in PLUGIN mode (src/plugin.ts only logs the error) — previously bootstrapError
    // stayed null there and the failure showed up as a causeless "not initialized".
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    throw err; // still propagate so the plugin/programmatic caller sees it
  }
}

/**
 * Reset the application context (for testing only)
 * Allows tests to inject their own instances
 */
export function resetAppContext(context: AppContext | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetAppContext() is not available in production');
  }
  appContext = context;
  bootstrapError = null;
  // Keep the published network in sync with the injected context (or clear it).
  setActiveNetwork(context?.cardanoClient.network ?? null);
  logger.debug('Application context reset');
}

/**
 * Create a test context with specific backends and transaction builder
 * Used by integration tests to create isolated test instances
 * @param backends Array of backend names to use (e.g., ['koios'], ['blockfrost'])
 * @param _txBuilderName Deprecated/ignored — Buildooor is the sole transaction builder (kept for signature compatibility)
 * @param protocolParams Optional protocol parameters (to skip backend call during init)
 * @returns Promise<AppContext> The created application context
 */
export async function createTestContext(
  backends: BackendName[],
  _txBuilderName: TransactionBuilderName = 'buildooor', // kept for signature compat; Buildooor is the only builder
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

/**
 * Shutdown the application context (for cleanup in tests)
 * Closes all backend connections to allow process to exit cleanly
 */
export async function shutdownAppContext(): Promise<void> {
  // Stop the crawler first so its in-flight block writes don't hit a torn-down client.
  try {
    await stopCrawler();
  } catch (err) {
    logger.warn('Crawler shutdown failed (continuing):', err);
  }

  if (appContext) {
    logger.info('Shutting down application context...');

    // Shutdown HSM signer if active
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
 * Load and validate CardanoClientConfig from CDS config or environment variables.
 *
 * When used as a plugin, consumers configure via package.json:
 *   { "cds": { "requires": { "odatano-core": { "network": "preview", "backends": ["blockfrost"], ... }}}}
 *
 * Priority: cds.env.requires["odatano-core"].X > process.env.X > default
 *
 * @returns validated CardanoClientConfig
 * @throws {Error} if any config value is invalid
 */
export function loadConfigFromEnv(): CardanoClientConfig {
  // Check CDS plugin config first, fall back to env vars
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

  // Buildooor is the sole transaction builder; any legacy txBuilders/TX_BUILDERS config is ignored.
  const txBuilders: TransactionBuilderName[] = ['buildooor'];

  const primaryTimeout = cdsConfig.primaryTimeoutMs ?? env.PRIMARY_TIMEOUT_MS;
  const fallbackTimeout = cdsConfig.fallbackTimeoutMs ?? env.FALLBACK_TIMEOUT_MS;

  // `!= null` not truthiness: a CDS-config numeric 0 is falsy, so `timeout && …`
  // skipped the <=0 check and 0 then silently became the default via `Number(0)||default`.
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

  // Warn about missing API keys for selected backends
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
 * Load HSM configuration from CDS config or environment variables.
 * Returns undefined if HSM is not enabled.
 *
 * Plugin mode: cds.requires.odatano-core.hsm.enabled = true
 * Env mode:    HSM_ENABLED=true
 *
 * @returns HsmConfig or undefined
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

  // Fail-closed: HSM controls a real signing key. Require an explicit role gate so
  // that an authenticated user cannot drain the HSM-controlled wallet by default.
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
 * Load the chain-crawler configuration from CDS config or environment variables.
 * Returns { enabled:false } when the crawler is not switched on (the default), so
 * existing deployments are unaffected.
 *
 * Plugin mode: cds.requires.odatano-core.crawler.{enabled,startSlot,startBlockHash,...}
 * Env mode:    CRAWLER_ENABLED / CRAWLER_START_SLOT / CRAWLER_START_HASH / ...
 */
export function loadCrawlerConfigFromEnv(): CrawlerConfig {
  const cdsConfig = (cds.env?.requires as Record<string, any>)?.['odatano-core'] ?? {};
  const c = cdsConfig.crawler ?? {};

  const enabled = c.enabled === true || env.CRAWLER_ENABLED === 'true';
  const startSlot = c.startSlot ?? (env.CRAWLER_START_SLOT ? Number(env.CRAWLER_START_SLOT) : undefined);
  const startBlockHash = c.startBlockHash ?? env.CRAWLER_START_HASH ?? undefined;
  const startHeight = c.startHeight ?? (env.CRAWLER_START_HEIGHT ? Number(env.CRAWLER_START_HEIGHT) : undefined);
  const source = (c.source ?? env.CRAWLER_SOURCE ?? 'auto') as CrawlerConfig['source'];
  const batchSize = Number(c.batchSize ?? env.CRAWLER_BATCH_SIZE) || 20;
  const confirmationDepth = Number(c.confirmationDepth ?? env.CRAWLER_CONFIRMATION_DEPTH ?? 3);
  const pollIntervalMs = Number(c.pollIntervalMs ?? env.CRAWLER_POLL_INTERVAL_MS) || 20000;

  if (enabled && (startSlot == null || Number.isNaN(startSlot) || !startBlockHash)) {
    throw new ConfigError(
      'Crawler is enabled but no start block is configured — set crawler.startSlot + crawler.startBlockHash ' +
      '(or CRAWLER_START_SLOT + CRAWLER_START_HASH).'
    );
  }
  if (!['ogmios', 'pagination', 'auto'].includes(source)) {
    throw new ConfigError(`Invalid CRAWLER_SOURCE "${source}". Must be one of: ogmios, pagination, auto.`);
  }

  return { enabled, startSlot, startBlockHash, startHeight, source, batchSize, confirmationDepth, pollIntervalMs };
}

/**
 * Start the chain crawler if it is enabled and the app context is ready. Never throws
 * (crawler failure must not affect request serving) — errors are logged. Idempotent:
 * startCrawler() is a no-op when one is already running.
 */
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

// Bootstrap hook - runs when CAP server has loaded all services
cds.on('served', async () => {
  // Skip if already initialized by plugin (src/plugin.ts runs first)
  if (appContext) return;

  // Skip auto-initialization when SKIP_AUTO_INIT is set (e.g., for tests with mocked backends)
  if (env.SKIP_AUTO_INIT === 'true') {
    logger.info('Skipping auto-initialization (SKIP_AUTO_INIT=true)');
    return;
  }

  // NOTE: config loading is INSIDE the try — loadConfigFromEnv/loadHsmConfigFromEnv
  // throw ConfigError synchronously (missing HSM_PIN, bad slot, no requiresRole…).
  // Outside the try that would crash the host app's bootstrap in plugin mode,
  // violating the plugin contract ("never throw on failure").
  let config: ReturnType<typeof loadConfigFromEnv> | undefined;
  try {
    config = loadConfigFromEnv();
    const hsmConfig = loadHsmConfigFromEnv();
    hsmConfigInstance = hsmConfig;
    appContext = await initializeAppContext(config, undefined, hsmConfig);
    bootstrapError = null;
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    // Don't throw - initialization failure shouldn't crash the host app (plugin contract).
    // Capture the cause so getAppContext() can surface a structured 503 with diagnostics
    // instead of the raw "Application not initialized" Error landing as a generic 500.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    // Write to stderr directly so the cause stays visible even when test runners
    // suppress console.error (jest.setup.ts in this repo silences it).
    const where = config ? `backends={${config.backends.join(',')}} network=${config.network}` : 'config load';
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`[ODATANO] Failed to initialize blockchain components — ${where}\n${msg}\n`);
    logger.error('Failed to initialize blockchain components:', err);
  }

  // Start the pre-sync crawler if configured (standalone mode). Non-fatal.
  await startCrawlerIfConfigured();
});

// Shutdown hook - runs when CAP server is shutting down (e.g., cds.shutdown() in tests)
cds.on('shutdown', async () => {
  await shutdownAppContext();
});
