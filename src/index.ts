import cds from '@sap/cds';

const logger = cds.log('ODATANO');

// Re-export key types and classes for programmatic consumers
export { CardanoClient } from '../srv/blockchain/cardano-client';
export type { CardanoClientConfig, Network, BackendName, TransactionBuilderName } from '../srv/blockchain/cardano-client';
export { CardanoIndexer } from '../srv/blockchain/cardano-indexer';
export { CardanoTransactionBuilder } from '../srv/blockchain/cardano-tx-builder';

// Re-export server accessors
export {
  getAppContext,
  getCardanoIndexer,
  getCardanoClient,
  getCardanoTxBuilder,
  loadConfigFromEnv,
  shutdownAppContext,
} from '../srv/server';

/**
 * Initialize the ODATANO plugin.
 * Loads configuration from cds.env.requires["odatano-core"] OR environment variables,
 * then initializes all blockchain components.
 */
export async function initialize(): Promise<void> {
  const { loadConfigFromEnv, initializeFromConfig } = await import('../srv/server');
  const config = loadConfigFromEnv();
  await initializeFromConfig(config);
  logger.info('ODATANO core initialized');
}

/**
 * Shutdown the ODATANO plugin.
 * Cleans up all backend connections (especially Ogmios WebSocket).
 */
export async function shutdown(): Promise<void> {
  const { shutdownAppContext } = await import('../srv/server');
  await shutdownAppContext();
  logger.info('ODATANO core shutdown');
}

/**
 * Get the current status of the plugin.
 */
export function getStatus(): { initialized: boolean; network?: string; backends?: string[] } {
  try {
    const { getAppContext } = require('../srv/server');
    const ctx = getAppContext();
    return {
      initialized: true,
      network: ctx.cardanoClient.network,
    };
  } catch {
    return { initialized: false };
  }
}
