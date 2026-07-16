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
  loadHsmConfigFromEnv,
  shutdownAppContext,
} from '../srv/server';

// Re-export HSM signer for programmatic access
export { getHsmSigner } from '../srv/blockchain/signing/hsm-signer';
export type { HsmConfig, HsmSignResult } from '../srv/utils/types';

// Re-export pure CBOR utilities (no CAP round-trip needed)
export { parseTransaction } from '../srv/cbor';
export type {
  ParsedTransaction,
  ParsedInput,
  ParsedOutput,
  ParsedAsset,
  ParsedWitnesses,
} from '../srv/cbor';

/**
 * Initialize the ODATANO plugin.
 * Loads configuration from cds.env.requires["odatano-core"] OR environment variables,
 * then initializes all blockchain components.
 */
export async function initialize(): Promise<void> {
  const { loadConfigFromEnv, loadHsmConfigFromEnv, initializeFromConfig, getAppContext } = await import('../srv/server');
  let alreadyInitialized = false;
  try {
    getAppContext();
    alreadyInitialized = true;
  } catch {
    // not initialized yet — initializeFromConfig will create the context
  }
  const config = loadConfigFromEnv();
  const hsmConfig = loadHsmConfigFromEnv();
  await initializeFromConfig(config, undefined, hsmConfig);
  if (!alreadyInitialized) {
    logger.info('ODATANO core initialized');
  }

  // Re-drive deferred submissions interrupted by a restart (plugin mode). Non-fatal.
  const { redriveInterruptedSubmissionsIfConfigured } = await import('../srv/server');
  await redriveInterruptedSubmissionsIfConfigured();
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
      backends: ctx.cardanoClient.listBackends(),
    };
  } catch {
    return { initialized: false };
  }
}
