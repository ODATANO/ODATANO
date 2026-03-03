import cds from '@sap/cds';
import { CardanoClient, CardanoClientConfig, Network,BackendName,TransactionBuilderName } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import type { LedgerProtocolParameters, HsmConfig } from './utils/types';
import { HsmSigner, getHsmSigner, setHsmSigner } from './blockchain/signing/hsm-signer';

import { env } from 'process';

const logger = cds.log('ODATANO');

const VALID_NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];
const VALID_BACKENDS: BackendName[] = ['blockfrost', 'koios', 'ogmios'];
const VALID_TX_BUILDERS: TransactionBuilderName[] = ['csl', 'buildooor'];

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
 * @throws {Error} if called before initialization
 */
export function getAppContext(): AppContext {
  if (!appContext) {
    throw new Error('Application not initialized. This should be called after cds.served event.');
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

/**
 * Initialize from a pre-built config (used by plugin's src/index.ts)
 * @param config - validated CardanoClientConfig
 * @param protocolParams - Optional protocol parameters (for tests)
 */
export async function initializeFromConfig(config: CardanoClientConfig, protocolParams?: LedgerProtocolParameters, hsmConfig?: HsmConfig): Promise<void> {
  appContext = await initializeAppContext(config, protocolParams, hsmConfig);
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
  logger.debug('Application context reset');
}

/**
 * Create a test context with specific backends and transaction builder
 * Used by integration tests to create isolated test instances
 * @param backends Array of backend names to use (e.g., ['koios'], ['blockfrost'])
 * @param txBuilderName Optional transaction builder name ('csl' or 'buildooor'), defaults to 'csl'
 * @param protocolParams Optional protocol parameters (to skip backend call during init)
 * @returns Promise<AppContext> The created application context
 */
export async function createTestContext(
  backends: BackendName[],
  txBuilderName: TransactionBuilderName = 'csl',
  protocolParams?: LedgerProtocolParameters
): Promise<AppContext> {
  // Set TX_BUILDERS env so TxBuilderRegistry.createDefault() uses the correct builder
  const previousTxBuilders = env.TX_BUILDERS;
  env.TX_BUILDERS = txBuilderName;

  try {
    const config: CardanoClientConfig = {
      network: (env.NETWORK as Network) || 'preview',
      backends,
      blockfrostApiKey: env.BLOCKFROST_API_KEY || '',
      koiosApiKey: env.KOIOS_API_KEY || '',
      ogmiosUrl: env.OGMIOS_URL || '',
      transactionBuilders: [txBuilderName],
      primaryTimeoutMs: Number(env.PRIMARY_TIMEOUT_MS) || 30000,   // || intentional: NaN (missing env var) falls back to default
      fallbackTimeoutMs: Number(env.FALLBACK_TIMEOUT_MS) || 60000,
      indexTtlMs: Number(env.INDEX_TTL_MS) || 3600000,
    };

    return await initializeAppContext(config, protocolParams);
  } finally {
    env.TX_BUILDERS = previousTxBuilders;
  }
}

/**
 * Shutdown the application context (for cleanup in tests)
 * Closes all backend connections to allow process to exit cleanly
 */
export async function shutdownAppContext(): Promise<void> {
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
    throw new Error(`Invalid NETWORK "${cdsConfig.network || env.NETWORK}". Must be one of: ${VALID_NETWORKS.join(', ')}`);
  }

  const backendStrings: string[] = cdsConfig.backends
    || (env.BACKENDS ? env.BACKENDS.split(',').map(b => b.trim()) : ['koios']);
  const invalidBackends = backendStrings.filter(b => !(VALID_BACKENDS as readonly string[]).includes(b));
  if (invalidBackends.length > 0) {
    throw new Error(`Invalid BACKENDS: "${invalidBackends.join(', ')}". Must be one of: ${VALID_BACKENDS.join(', ')}`);
  }
  const backends = backendStrings as BackendName[];

  const txBuilderStrings: string[] = cdsConfig.txBuilders
    || (env.TX_BUILDERS ? env.TX_BUILDERS.split(',').map(b => b.trim()) : ['csl']);
  const invalidBuilders = txBuilderStrings.filter(b => !(VALID_TX_BUILDERS as readonly string[]).includes(b));
  if (invalidBuilders.length > 0) {
    throw new Error(`Invalid TX_BUILDERS: "${invalidBuilders.join(', ')}". Must be one of: ${VALID_TX_BUILDERS.join(', ')}`);
  }
  const txBuilders = txBuilderStrings as TransactionBuilderName[];

  const primaryTimeout = cdsConfig.primaryTimeoutMs ?? env.PRIMARY_TIMEOUT_MS;
  const fallbackTimeout = cdsConfig.fallbackTimeoutMs ?? env.FALLBACK_TIMEOUT_MS;

  if (primaryTimeout && isNaN(Number(primaryTimeout))) {
    throw new Error(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a number.`);
  }
  if (primaryTimeout && Number(primaryTimeout) <= 0) {
    throw new Error(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a positive number.`);
  }
  if (fallbackTimeout && isNaN(Number(fallbackTimeout))) {
    throw new Error(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a number.`);
  }
  if (fallbackTimeout && Number(fallbackTimeout) <= 0) {
    throw new Error(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a positive number.`);
  }

  const blockfrostApiKey = cdsConfig.blockfrostApiKey || env.BLOCKFROST_API_KEY || '';
  const koiosApiKey = cdsConfig.koiosApiKey || env.KOIOS_API_KEY || '';
  const ogmiosUrl = cdsConfig.ogmiosUrl || env.OGMIOS_URL || '';

  // Warn about missing API keys for selected backends
  if (backends.includes('blockfrost') && !blockfrostApiKey) {
    logger.warn('BLOCKFROST_API_KEY is not set but blockfrost is listed in BACKENDS');
  }
  if (backends.includes('ogmios') && !ogmiosUrl) {
    logger.warn('OGMIOS_URL is not set but ogmios is listed in BACKENDS');
  }

  return {
    network,
    backends,
    blockfrostApiKey,
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
    throw new Error('HSM_PKCS11_MODULE is required when HSM is enabled');
  }

  const pin = hsmCds.pin || env.HSM_PIN || '';
  if (!pin) {
    throw new Error('HSM_PIN is required when HSM is enabled');
  }

  return {
    enabled: true,
    pkcs11Module,
    slot: Number(hsmCds.slot ?? env.HSM_SLOT ?? 0),
    pin,
    keyId: hsmCds.keyId || env.HSM_KEY_ID,
    keyLabel: hsmCds.keyLabel || env.HSM_KEY_LABEL,
  };
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

  const config = loadConfigFromEnv();
  const hsmConfig = loadHsmConfigFromEnv();

  try {
    appContext = await initializeAppContext(config, undefined, hsmConfig);
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    logger.error('Failed to initialize blockchain components:', err);
    throw err;
  }
});

// Shutdown hook - runs when CAP server is shutting down (e.g., cds.shutdown() in tests)
cds.on('shutdown', async () => {
  await shutdownAppContext();
});
