import cds from '@sap/cds';
import { CardanoClient, CardanoClientFactory } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';

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
 */
async function initializeAppContext(): Promise<AppContext> {
  logger.info('Initializing blockchain components...');

  // Create CardanoClient from configuration
  const cardanoClient = CardanoClientFactory.createFromConfig();

  // Create CardanoTransactionBuilder with the client
  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init();

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
 * Get the CardanoTransactionBuilder instance
 * Convenience function for services
 */
export function getCardanoTxBuilder(): CardanoTransactionBuilder {
  return getAppContext().cardanoTxBuilder;
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

/**
 * Create application context for testing with specific backends
 * @param backendNames - List of backend names to use
 * @param txBuilderName - Optional transaction builder name ('csl' or 'buildooor')
 */
export async function createTestContext(
  backendNames?: string[],
  txBuilderName?: string
): Promise<AppContext> {
  // Set TX_BUILDERS env var if specified (for TxBuilderRegistry.createDefault())
  if (txBuilderName) {
    process.env.TX_BUILDERS = txBuilderName;
  }

  const cardanoClient = backendNames
    ? CardanoClientFactory.createForBackends(backendNames)
    : CardanoClientFactory.createFromConfig();

  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init();

  const cardanoIndexer = new CardanoIndexer(cardanoClient, cardanoTxBuilder);

  return {
    cardanoClient,
    cardanoIndexer,
    cardanoTxBuilder,
  };
}

// Bootstrap hook - runs when CAP server has loaded all services
cds.on('served', async () => {
  try {
    appContext = await initializeAppContext();
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    logger.error('Failed to initialize blockchain components:', err);
    throw err;
  }
});
