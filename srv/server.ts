import cds from '@sap/cds';
import { CardanoClient, CardanoClientConfig, Network,BackendName,TransactionBuilderName } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import type { LedgerProtocolParameters } from './utils/types';

import { env } from 'process';

const logger = cds.log('server');

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
async function initializeAppContext(config: CardanoClientConfig, protocolParams?: LedgerProtocolParameters): Promise<AppContext> {
  logger.info('Initializing blockchain components...');

  // Create CardanoClient from configuration
  const cardanoClient = new CardanoClient(config);

  // Create CardanoTransactionBuilder with the client
  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init(protocolParams);

  // Create CardanoIndexer with client and transaction builder
  const cardanoIndexer = new CardanoIndexer(cardanoClient, cardanoTxBuilder);

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
 * Reset the application context (for testing only)
 * Allows tests to inject their own instances
 */
export function resetAppContext(context: AppContext | null): void {
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
  env.TX_BUILDERS = txBuilderName;

  const config: CardanoClientConfig = {
    network: (env.NETWORK as Network) || 'preview',
    backends,
    blockfrostApiKey: env.BLOCKFROST_API_KEY || '',
    koiosApiKey: env.KOIOS_API_KEY || '',
    ogmiosUrl: env.OGMIOS_URL || '',
    transactionBuilders: [txBuilderName],
    primaryTimeoutMs: Number(env.PRIMARY_TIMEOUT_MS) || 30000,
    fallbackTimeoutMs: Number(env.FALLBACK_TIMEOUT_MS) || 60000,
    indexTtlMs: Number(env.INDEX_TTL_MS) || 3600000,
  };

  return initializeAppContext(config, protocolParams);
}

/**
 * Shutdown the application context (for cleanup in tests)
 * Closes all backend connections to allow process to exit cleanly
 */
export async function shutdownAppContext(): Promise<void> {
  if (appContext) {
    logger.info('Shutting down application context...');
    await appContext.cardanoClient.shutdown();
    appContext = null;
    logger.info('Application context shutdown complete');
  }
}


// Bootstrap hook - runs when CAP server has loaded all services
cds.on('served', async () => {
  // Skip auto-initialization when SKIP_AUTO_INIT is set (e.g., for tests with mocked backends)
  if (env.SKIP_AUTO_INIT === 'true') {
    logger.info('Skipping auto-initialization (SKIP_AUTO_INIT=true)');
    return;
  }

  // Read environment configuration for CardanoClient
  const config: CardanoClientConfig = {
      network: (env.NETWORK as Network) || 'preview',
      backends: env.BACKENDS ? env.BACKENDS.split(',') as BackendName[] : ['koios'],
      blockfrostApiKey: env.BLOCKFROST_API_KEY || '',
      koiosApiKey: env.KOIOS_API_KEY || '',
      ogmiosUrl: env.OGMIOS_URL || '',
      transactionBuilders: env.TX_BUILDERS ? env.TX_BUILDERS.split(',') as TransactionBuilderName[] : ['csl'],
      primaryTimeoutMs: Number(env.PRIMARY_TIMEOUT_MS) || 30000,
      fallbackTimeoutMs: Number(env.FALLBACK_TIMEOUT_MS) || 60000,
      indexTtlMs: Number(env.INDEX_TTL_MS) || 3600000,
  };

  try {
    appContext = await initializeAppContext(config);
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    logger.error('Failed to initialize blockchain components:', err);
    throw err;
  }
});
