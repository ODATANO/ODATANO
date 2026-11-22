import cds from '@sap/cds';
import type { TransactionConfirmations } from '../srv/utils/types';
import { isTxHash } from '../srv/utils/validators';
import { TransactionValidationError } from '../srv/utils/errors';
import { ERROR_CODES } from '../srv/utils/error-codes';

const logger = cds.log('ODATANO');

// Re-export key types and classes for programmatic consumers
export { CardanoClient } from '../srv/blockchain/cardano-client';
export type { CardanoClientConfig, Network, BackendName } from '../srv/blockchain/cardano-client';
export { CardanoIndexer } from '../srv/blockchain/cardano-indexer';
export { CardanoTransactionBuilder } from '../srv/blockchain/cardano-tx-builder';

// Re-export server accessors
export {
  getAppContext,
  getCardanoIndexer,
  getCardanoClient,
  getCardanoTxBuilder,
  startCrawlerIfConfigured,
  startWalletWorkerIfConfigured,
  shutdownAppContext,
} from '../srv/server';
export {
  loadConfigFromEnv,
  loadHsmConfigFromEnv,
  loadCrawlerConfigFromEnv,
  loadWalletWorkerConfigFromEnv,
  loadAgentGrantsConfig,
} from '../srv/config';
export type { AgentGrantsConfig } from '../srv/config';

// Re-export HSM signer for programmatic access
export { getHsmSigner } from '../srv/blockchain/signing/hsm-signer';

// Agent grants: programmatic seams for packages that issue grants or add transport lanes.
export {
  issueAgentGrant,
  updateAgentGrant,
  rotateAgentGrantToken,
  revokeAgentGrantById,
  getGrantUsage,
  resolveUsageWindow,
  hashAgentToken,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_PREFIX,
  AGENT_ROLE,
} from '../srv/utils/agent-grants';
export { agentAccessOf, agentGrantableActions } from '../srv/utils/agent-access';
export type { AgentAccess } from '../srv/utils/agent-access';
export type {
  IssueAgentGrantInput,
  IssuedAgentGrant,
  AgentGrantStatus,
  UpdateAgentGrantInput,
  UpdateAgentGrantResult,
  RotatedAgentGrant,
  AgentGrantUsage,
  GrantUsageCall,
  UsageWindow,
} from '../srv/utils/agent-grants';
export { registerTransportLane } from '@odatano/cap-auth';
export type { TransportLane, LaneOutcome } from '@odatano/cap-auth';
export type { HsmConfig, HsmSignResult } from '../srv/utils/types';

// Re-export pure CBOR utilities (no CAP round-trip needed)
export { parseTransaction } from '../srv/cbor';
export type {
  ParsedTransaction,
  ParsedInput,
  ParsedOutput,
  ParsedAsset,
  ParsedWitnesses,
  ParsedWithdrawal,
  ParsedCertificate,
} from '../srv/cbor';
export { verifyTxWitnesses } from '../srv/blockchain/signing/signature-verifier';
export { posixToSlot, slotToPosixMs } from '../srv/utils/epoch-slots';
export type { TxWitnessVerification, TransactionConfirmations } from '../srv/utils/types';

// Pure script helpers (no initialize() needed)
export { applyScriptParameters, plutusScriptHash } from '../srv/utils/tx-build-helper';

// Reads config from cds.env.requires["odatano-core"] or env vars.
// Starts all blockchain components plus the optional crawler and wallet worker.
export async function initialize(): Promise<void> {
  const { initializeFromConfig, getAppContext } = await import('../srv/server');
  const { loadConfigFromEnv, loadHsmConfigFromEnv } = await import('../srv/config');
  let alreadyInitialized = false;
  try {
    getAppContext();
    alreadyInitialized = true;
  } catch {
    // Not initialized yet. initializeFromConfig creates the context.
  }
  const config = loadConfigFromEnv();
  const hsmConfig = loadHsmConfigFromEnv();
  await initializeFromConfig(config, undefined, hsmConfig);
  if (!alreadyInitialized) {
    logger.info('ODATANO core initialized');
  }

  // Optional subsystems; each is non-fatal.
  const { startCrawlerIfConfigured, startWalletWorkerIfConfigured, redriveInterruptedSubmissionsIfConfigured } = await import('../srv/server');
  await startCrawlerIfConfigured();
  await startWalletWorkerIfConfigured();
  await redriveInterruptedSubmissionsIfConfigured();
}

/** Shut down the plugin and close all backend connections. */
export async function shutdown(): Promise<void> {
  const { shutdownAppContext } = await import('../srv/server');
  await shutdownAppContext();
  logger.info('ODATANO core shutdown');
}

/** Confirmations of a transaction; needs initialize(). See CardanoIndexer.resolveTransactionConfirmations. */
export async function getTransactionConfirmations(txHash: string): Promise<TransactionConfirmations> {
  if (!isTxHash(txHash)) throw new TransactionValidationError(`Invalid transaction hash: ${txHash}`, undefined, ERROR_CODES.INVALID_INPUT);
  const { getCardanoIndexer } = await import('../srv/server');
  return cds.tx((tx) => getCardanoIndexer().resolveTransactionConfirmations(tx, txHash));
}

/** Current plugin status. */
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
