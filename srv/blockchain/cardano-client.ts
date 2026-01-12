import { CardanoBackend } from './backends/cardano-backend';
import { BlockfrostBackend } from './backends/blockfrost-backend';
import { KoiosBackend } from './backends/koios-backend';
import { OgmiosBackend } from './backends/ogmios-backend';
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
 * CardanoClient - Smart Multi-backend Cardano Client
 * 
 * Routes requests to appropriate backends:
 * - Live/State queries → Ogmios (if available)
 * - Historical queries → Blockfrost/Koios (if available)
 * - Automatic fallback between backends
 */
export class CardanoClient {
  private liveBackend?: CardanoBackend;
  private historicalBackends: CardanoBackend[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /** 
   * Constructor for CardanoClient
   * @param liveBackend - Optional backend for live/state queries (typically Ogmios)
   * @param historicalBackends - Optional backends for historical queries (typically Blockfrost/Koios)
   */
  constructor(
    liveBackend?: CardanoBackend,
    historicalBackends: CardanoBackend[] = []
  ) {
    if (!liveBackend && historicalBackends.length === 0) {
      throw new ConfigError(
        'CardanoClient misconfigured: no backend available. Check CONFIG and API keys.'
      );
    }
    this.liveBackend = liveBackend;
    this.historicalBackends = historicalBackends;
    
    logger.info({
      live: liveBackend?.name ?? 'none',
      historical: historicalBackends.map(b => b.name).join(', ') || 'none'
    }, '[CardanoClient] Initialized with backends');
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
    const initErrors: BackendInitError[] = [];

    // Initialize live backend
    if (this.liveBackend) {
      try {
        logger.info({ backend: this.liveBackend.name }, 'Initializing live backend');
        await this.liveBackend.init();
        logger.info({ backend: this.liveBackend.name }, 'Live backend initialized');
      } catch (err: any) {
        initErrors.push(new BackendInitError(this.liveBackend.name, err));
        logger.error({ backend: this.liveBackend.name, err }, 'Failed to initialize live backend');
        this.liveBackend = undefined; // remove failed backend
      }
    }

    // Initialize historical backends
    const initializedHistorical: CardanoBackend[] = [];
    for (const backend of this.historicalBackends) {
      try {
        logger.info({ backend: backend.name }, 'Initializing historical backend');
        await backend.init();
        initializedHistorical.push(backend);
        logger.info({ backend: backend.name }, 'Historical backend initialized');
      } catch (err: any) {
        initErrors.push(new BackendInitError(backend.name, err));
        logger.error({ backend: backend.name, err }, 'Failed to initialize historical backend');
      }
    }
    this.historicalBackends = initializedHistorical;

    if (!this.liveBackend && this.historicalBackends.length === 0) {
      throw new AllBackendsInitFailedError(initErrors);
    }
    
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
    if (backend.name === 'ogmios') return PRIMARY_TIMEOUT_MS;
    if (backend.name === 'blockfrost') return PRIMARY_TIMEOUT_MS;
    if (backend.name === 'koios') return FALLBACK_TIMEOUT_MS;
    return PRIMARY_TIMEOUT_MS;
  }

  /** 
   * Execute with live backend first, fallback to historical
   * Used for queries that prefer live data but can fall back to historical
   */
  private async withLiveFirst<T>(
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();
    const errors: BackendError[] = [];

    // Try live backend first
    if (this.liveBackend) {
      try {
        logger.debug({ backend: this.liveBackend.name }, 'Calling live backend');
        const result = await this.withTimeout(
          fn(this.liveBackend),
          this.getTimeoutForBackend(this.liveBackend),
          this.liveBackend.name
        );
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, this.liveBackend.name);
        errors.push(backendError);
        logger.warn({ backend: this.liveBackend.name, error: backendError.message }, 'Live backend failed, trying historical');
      }
    }

    // Fallback to historical backends
    for (const backend of this.historicalBackends) {
      try {
        logger.debug({ backend: backend.name }, 'Calling historical backend');
        const result = await this.withTimeout(
          fn(backend),
          this.getTimeoutForBackend(backend),
          backend.name
        );
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        
        if (backendError.statusCode === 404) {
          logger.debug({ backend: backend.name, error: backendError.message }, 'Backend: resource not found');
        } else {
          logger.warn({ backend: backend.name, error: backendError.message }, 'Backend failed');
        }
      }
    }

    throw new AllBackendsFailedError(errors);
  }

  /** 
   * Execute with historical backend first, fallback to live
   * Used for historical queries that should prefer historical data sources
   */
  private async withHistoricalFirst<T>(
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();
    const errors: BackendError[] = [];

    // Try historical backends first
    for (const backend of this.historicalBackends) {
      try {
        logger.debug({ backend: backend.name }, 'Calling historical backend');
        const result = await this.withTimeout(
          fn(backend),
          this.getTimeoutForBackend(backend),
          backend.name
        );
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        
        if (backendError.statusCode === 404) {
          logger.debug({ backend: backend.name, error: backendError.message }, 'Backend: resource not found');
        } else {
          logger.warn({ backend: backend.name, error: backendError.message }, 'Backend failed');
        }
      }
    }

    // Fallback to live backend
    if (this.liveBackend) {
      try {
        logger.debug({ backend: this.liveBackend.name }, 'Calling live backend as fallback');
        const result = await this.withTimeout(
          fn(this.liveBackend),
          this.getTimeoutForBackend(this.liveBackend),
          this.liveBackend.name
        );
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, this.liveBackend.name);
        errors.push(backendError);
        logger.warn({ backend: this.liveBackend.name, error: backendError.message }, 'Live backend failed');
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
    return this.withHistoricalFirst(b => b.getTransaction(txHash));
  }
  
  /** 
   * Get address by bech32 address with fallback between backends
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  getAddress(address: string): Promise<Address> {
    return this.withLiveFirst(b => b.getAddress(address));
  }

  /** 
   * Get address UTxOs with fallback between backends
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  getAddressUtxos(address: string): Promise<UTxO[]> {
    return this.withLiveFirst(b => b.getAddressUtxos(address));
  }

  /** 
   * Get network information with fallback between backends
   * @returns {Promise<Network>} network information
   */
  getNetworkInformation(): Promise<Network> {
    return this.withLiveFirst(b => b.getNetworkInformation());
  }

  /** 
   * Get transaction metadata with fallback between backends
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata
   */
  getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return this.withHistoricalFirst(b => b.getTransactionMetadata(tx_hash));
  }

  /** 
   * Get block data with fallback between backends
   * @param block_hash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  getBlock(block_hash: string): Promise<BlockData> {
    return this.withHistoricalFirst(b => b.getBlock(block_hash));
  }

  /** 
   * Get epoch data with fallback between backends
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  getEpoch(epochNumber: number): Promise<EpochData> {
    return this.withHistoricalFirst(b => b.getEpoch(epochNumber));
  }

  /** 
   * Get Pool data with fallback between backends
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  getPool(poolId: string): Promise<PoolData> {
    return this.withLiveFirst(b => b.getPool(poolId));
  }

  /** 
   * Get drep data with fallback between backends
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  getDrep(drepId: string): Promise<DrepData> {
    return this.withHistoricalFirst(b => b.getDrep(drepId));
  }

  /** 
   * Get account data with fallback between backends
   * @param stakeAddress stake address
   * @returns {Promise<AccountData>} account data
   */
  getAccount(stakeAddress: string): Promise<AccountData> {
    return this.withLiveFirst(b => b.getAccount(stakeAddress));
  }

  /** 
   * Get protocol parameters with fallback between backends
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return this.withLiveFirst(b => b.getProtocolParameters());
  }

  /** 
   * Get latest block data with fallback between backends
   * @returns {Promise<BlockData>} latest block data
   */
  getLatestBlock(): Promise<BlockData> {
    return this.withLiveFirst(b => b.getLatestBlock());
  }

  /** 
   * Get latest epoch data with fallback between backends
   * @returns {Promise<EpochData>} latest epoch data
   */
  getLatestEpoch(): Promise<EpochData> {
    return this.withLiveFirst(b => b.getLatestEpoch());
  }

  /** 
   * Submit transaction with fallback between backends
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  submitTransaction(signedTxCbor: string): Promise<string> {
    return this.withLiveFirst(b => b.submitTransaction(signedTxCbor));
  }
}

/** 
 * CardanoClient singleton instance using configured backends
 */
let liveBackend: CardanoBackend | undefined;
const historicalBackends: CardanoBackend[] = [];

// Build backends based on configuration
const configuredBackends = CONFIG.backends;

// Check if we should use Ogmios (either explicitly or via 'hybrid')
if (configuredBackends.includes('ogmios') || configuredBackends.includes('hybrid')) {
  logger.info('[CardanoClient] Configuring Ogmios as live backend');
  liveBackend = new OgmiosBackend();
}

// Check for historical backends (Blockfrost or Koios)
if (configuredBackends.includes('blockfrost') || 
    (configuredBackends.includes('hybrid') && CONFIG.blockfrostApiKey)) {
  if (CONFIG.blockfrostApiKey) {
    logger.info('[CardanoClient] Adding Blockfrost as historical backend');
    historicalBackends.push(new BlockfrostBackend());
  } else {
    logger.warn('[CardanoClient] Blockfrost configured but no API key found');
  }
}

if (configuredBackends.includes('koios') || 
    (configuredBackends.includes('hybrid') && CONFIG.koiosApiKey && !CONFIG.blockfrostApiKey)) {
  logger.info('[CardanoClient] Adding Koios as historical backend');
  historicalBackends.push(new KoiosBackend());
}

// Fallback: if no backends configured, use defaults based on available API keys
if (!liveBackend && historicalBackends.length === 0) {
  logger.warn('[CardanoClient] No backends explicitly configured, using defaults based on API keys');
  
  if (CONFIG.blockfrostApiKey) {
    logger.info('[CardanoClient] Using Blockfrost as default backend');
    historicalBackends.push(new BlockfrostBackend());
  } else {
    logger.info('[CardanoClient] Using Koios as default backend');
    historicalBackends.push(new KoiosBackend());
  }
}

/** CardanoClient exported singleton instance */
export const cardanoClient = new CardanoClient(liveBackend, historicalBackends);
export default cardanoClient;


/** Create a CardanoClient instance for specified backends (used in tests)
 * @param backendNames list of backend names
 * @returns {CardanoClient} CardanoClient instance
 */
export function createCardanoClientForBackends(backendNames: string[]): CardanoClient {
  let testLiveBackend: CardanoBackend | undefined;
  const testHistoricalBackends: CardanoBackend[] = [];

  for (const backendName of backendNames) {
    if (backendName === 'ogmios' || backendName === 'hybrid') {
      testLiveBackend = new OgmiosBackend();
    }
    
    if (backendName === 'blockfrost' || (backendName === 'hybrid' && CONFIG.blockfrostApiKey)) {
      if (CONFIG.blockfrostApiKey) {
        testHistoricalBackends.push(new BlockfrostBackend());
      }
    }
    
    if (backendName === 'koios' || (backendName === 'hybrid' && CONFIG.koiosApiKey && !CONFIG.blockfrostApiKey)) {
      testHistoricalBackends.push(new KoiosBackend());
    }
  }

  if (!testLiveBackend && testHistoricalBackends.length === 0) {
    throw new ConfigError(`No valid backends configured: ${backendNames.join(',')}`);
  }

  return new CardanoClient(testLiveBackend, testHistoricalBackends);
}
