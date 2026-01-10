import { CardanoBackend } from './backends/cardano-backend';
import { BlockfrostBackend } from './backends/blockfrost-backend';
import { KoiosBackend } from './backends/koios-backend';
import { OgmiosBackend } from './backends/ogmios-backend';
import { HybridBackend } from './backends/hybrid-backend';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError } from '../utils/errors';
import logger from '../utils/logger';
import { CONFIG } from '../../config/config';

import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData, 
  DrepData, 
  AccountData,
  LedgerProtocolParameters
} from '../utils/types';

/**
 * Timeout settings for backends 
 */
const PRIMARY_TIMEOUT_MS = Number(CONFIG.primaryTimeoutMs);
const FALLBACK_TIMEOUT_MS = Number(CONFIG.fallbackTimeoutMs);

/** 
 * Export class content CardanoClient - Multi-backend Cardano Client with Fallback and Timeout
 * 
 * Provides a unified interface to interact with multiple Cardano backends (Blockfrost, Koios, Ogmios, Hybrid)
 * with intelligent timeout and fallback mechanisms.
 */
export class CardanoClient {
  private backends: CardanoBackend[];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /** 
   * Constructor for CardanoClient Object Instance initializing multiple backends
   * @param backends list of CardanoBackend instances
   */
  constructor(backends: CardanoBackend[]) {
    if (!backends || backends.length === 0) {
      throw new ConfigError(
        'CardanoClient misconfigured: no backend available. Check CONFIG and API keys.'
      );
    }
    this.backends = backends;
  }

  /** 
   * Ensure backends are initialized
   * @returns {Promise<void>}
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initBackends();
    }
    await this.initPromise;
  }

  /** 
   * Initialize all backends from configuration
   * @returns {Promise<void>}
   */
  private async initBackends(): Promise<void> {
    const initialized: CardanoBackend[] = [];
    const initErrors: BackendInitError[] = [];

    for (const backend of this.backends) {
      try {
        logger.info({ backend: backend.name }, 'Initializing backend');
        await backend.init();
        initialized.push(backend);
        logger.info({ backend: backend.name }, 'Backend initialized successfully');
      } catch (err: any) {
        initErrors.push(new BackendInitError(backend.name, err));
        logger.error({ backend: backend.name, err }, 'Failed to initialize backend');
      }
    }
    if (initialized.length === 0) {
      throw new AllBackendsInitFailedError(initErrors);
    }
    this.backends = initialized;
    this.initialized = true;
  }

  /**
   * Wrap a promise with a timeout
   * @param promise - the promise to wrap
   * @param ms - timeout in milliseconds
   * @param backendName - name of the backend (for error context)
   * @returns {Promise<T>} the result of the promise or a timeout error
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    backendName: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new ProviderUnavailableError('Backend timeout', backendName, ms)),
          ms
        )
      ),
    ]);
  }

  /** 
   * Get timeout for specific backend
   * @param backend CardanoBackend instance
   * @returns {number} timeout in milliseconds
   */
  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'blockfrost') return PRIMARY_TIMEOUT_MS;
    if (backend.name === 'koios') return FALLBACK_TIMEOUT_MS;
    // add more backends with custom timeouts here
    return PRIMARY_TIMEOUT_MS;
  }

  /** 
   * Execute a backend method with fallback between configured backends
   * @param fn - function that takes a CardanoBackend and returns a Promise<T>
   * @returns {Promise<T>} the result from the first successful backend call
   */
  private async withFallback<T>(
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const errors: BackendError[] = [];

    for (const backend of this.backends) {
      const timeoutMs = this.getTimeoutForBackend(backend);
      try {
        logger.debug({ backend: backend.name }, 'Calling backend');
        const result = await this.withTimeout(
          fn(backend),
          timeoutMs,
          backend.name
        );
        return result;
      } catch (err: any) {

        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        
        // 404 errors are expected - log as debug, not warn
        if (backendError.statusCode === 404) {
          logger.debug(
            { 
              backend: backend.name, 
              error: backendError.message,
              code: backendError.code 
            }, 
            'Backend: resource not found'
          );
        } else {
          logger.warn(
            { 
              backend: backend.name, 
              error: backendError.message,
              statusCode: backendError.statusCode,
              code: backendError.code 
            }, 
            'Backend failed'
          );
        }
      }
    }

    throw new AllBackendsFailedError(errors);
  }

  /** 
   * Get transaction by hash with fallback between backends
   * @param txHash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  getTransaction(txHash: string): Promise<Transaction> {
    return this.withFallback(b => b.getTransaction(txHash));
  }
  /** 
   * Get address by bech32 address with fallback between backends
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  getAddress(address: string): Promise<Address> {
    return this.withFallback(b => b.getAddress(address));
  }
  
  /** 
   * Get address UTxOs with fallback between backends
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  getAddressUtxos(address: string): Promise<UTxO[]> {
    return this.withFallback(b => b.getAddressUtxos(address));
  }
  
  /** 
   * Get network information with fallback between backends
   * @returns {Promise<Network>} network information
   */
  getNetworkInformation(): Promise<Network> {
    return this.withFallback(b => b.getNetworkInformation());
  }
  
  /** 
   * Get transaction metadata with fallback between backends
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata
   */
  getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return this.withFallback(b => b.getTransactionMetadata(tx_hash));
  }
  
  /** 
   * Get block data with fallback between backends
   * @param block_hash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  getBlock(block_hash: string): Promise<BlockData> {
    return this.withFallback(b => b.getBlock(block_hash));
  }
  
  /** 
   * Get epoch data with fallback between backends
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  getEpoch(epochNumber: Number): Promise<EpochData> {
    return this.withFallback(b => b.getEpoch(epochNumber));
  }
  
  /** 
   * Get Pool data with fallback between backends
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  getPool(poolId: string): Promise<PoolData> {
    return this.withFallback(b => b.getPool(poolId));
  }
  
  /** 
   * Get drep data with fallback between backends
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  getDrep(drepId: string): Promise<DrepData> {
    return this.withFallback(b => b.getDrep(drepId));
  }
  
  /** 
   * Get account data with fallback between backends
   * @param stakeAddress stake address
   * @returns {Promise<AccountData>} account data
   */
  getAccount(stakeAddress: string): Promise<AccountData> {
    return this.withFallback(b => b.getAccount(stakeAddress));
  }
  
  /** 
   * Get protocol parameters with fallback between backends
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return this.withFallback(b => b.getProtocolParameters());
  }
  
  /** 
   * Get latest block data with fallback between backends
   * @returns {Promise<BlockData>} latest block data
   */
  getLatestBlock(): Promise<BlockData> {
    return this.withFallback(b => b.getLatestBlock());
  }

  /** 
   * Get latest epoch data with fallback between backends
   * @returns {Promise<EpochData>} latest epoch data
   */
  getLatestEpoch(): Promise<EpochData> {
    return this.withFallback(b => b.getLatestEpoch());
  }

  /** 
   * Submit transaction with fallback between backends
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  submitTransaction(signedTxCbor: string): Promise<string> {
    return this.withFallback(b => b.submitTransaction(signedTxCbor));
  }
}

/** 
 * CardanoClient singleton instance using configured backends
 */
const backends: CardanoBackend[] = [];

// build backends from configuration
for (const backendName of CONFIG.backends) {
  if (backendName === 'hybrid') {
    // hybrid mode: Ogmios for live data and submit / Blockfrost/Koios for historical data
    logger.info('[CardanoClient] Building Hybrid backend (Ogmios + Blockfrost/Koios)');
    const ogmios = new OgmiosBackend();
    const historical = CONFIG.blockfrostApiKey 
      ? new BlockfrostBackend() 
      : new KoiosBackend();
    backends.push(new HybridBackend(ogmios, historical));
  } else if (backendName === 'blockfrost' && CONFIG.blockfrostApiKey) {
    backends.push(new BlockfrostBackend());
  } else if (backendName === 'koios') {
    backends.push(new KoiosBackend());
  } else if (backendName === 'ogmios') {
    backends.push(new OgmiosBackend());
  }
}

/** CardanoClient exported singleton instance using configured backends */
export const cardanoClient = new CardanoClient(backends);
export default cardanoClient;


/** Create a CardanoClient instance for specified backends ( just used in tests to run against multiple backends individually)
 * @param backendNames list of backend names
 * @returns {CardanoClient} CardanoClient instance
 */
export function createCardanoClientForBackends(backendNames: string[]): CardanoClient {
  const testBackends: CardanoBackend[] = [];

  for (const backendName of backendNames) {
    if (backendName === 'hybrid') {
      const ogmios = new OgmiosBackend();
      const historical = CONFIG.blockfrostApiKey 
        ? new BlockfrostBackend() 
        : new KoiosBackend();
      testBackends.push(new HybridBackend(ogmios, historical));
    } else if (backendName === 'blockfrost' && CONFIG.blockfrostApiKey) {
      testBackends.push(new BlockfrostBackend());
    } else if (backendName === 'koios') {
      testBackends.push(new KoiosBackend());
    } else if (backendName === 'ogmios') {
      testBackends.push(new OgmiosBackend());
    }
  }

  if (testBackends.length === 0) {
    throw new ConfigError(`No valid backends configured: ${backendNames.join(',')}`);
  }

  return new CardanoClient(testBackends);
}
