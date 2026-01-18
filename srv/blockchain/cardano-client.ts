import cds from '@sap/cds';
import { CardanoBackend } from './backends/cardano-backend';
import { BackendRegistry } from './backends/backend-registry';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError } from '../utils/errors';
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
const logger = cds.log('CardanoClient');

/**
 * Method routing configuration - defines which backend type to prefer for each method
 */
const METHOD_ROUTING: Record<string, { preferLive: boolean }> = {
  getTransaction: { preferLive: false },
  getAddress: { preferLive: true },
  getAddressUtxos: { preferLive: true },
  getNetworkInformation: { preferLive: true },
  getTransactionMetadata: { preferLive: false },
  getBlock: { preferLive: false },
  getEpoch: { preferLive: false },
  getLatestEpoch: { preferLive: true },
  getLatestBlock: { preferLive: true },
  getPool: { preferLive: true },
  getDrep: { preferLive: false },
  getAccount: { preferLive: true },
  getProtocolParameters: { preferLive: true },
  submitTransaction: { preferLive: true },
};

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
    logger.info('CardanoClient instance created.');
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
        logger.debug(`Initializing live backend: ${this.liveBackend.name}`);
        await this.liveBackend.init();
        logger.debug(`Live backend initialized: ${this.liveBackend.name}`);
      } catch (err: any) {
        initErrors.push(new BackendInitError(this.liveBackend.name, err));
        logger.error(`Failed to initialize live backend: ${this.liveBackend.name}`, err);
        this.liveBackend = undefined; // remove failed backend
      }
    }

    // Initialize historical backends
    const initializedHistorical: CardanoBackend[] = [];
    for (const backend of this.historicalBackends) {
      try {
        logger.debug(`Initializing historical backend: ${backend.name}`);
        await backend.init();
        initializedHistorical.push(backend);
        logger.debug(`Historical backend initialized: ${backend.name}`);
      } catch (err: any) {
        initErrors.push(new BackendInitError(backend.name, err));
        logger.error(`Failed to initialize historical backend: ${backend.name}`, err);
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
   * Execute with priority-based backend selection and automatic fallback
   * @param fn function to execute on backend
   * @param preferLive whether to prefer live backend over historical
   * @returns {Promise<T>} result from backend
   */
  private async executeWithPriority<T>(
    fn: (backend: CardanoBackend) => Promise<T>,
    preferLive: boolean
  ): Promise<T> {
    await this.ensureInitialized();
    const errors: BackendError[] = [];
    
    // Determine backend order based on preference
    const primaryBackends = preferLive 
      ? (this.liveBackend ? [this.liveBackend] : [])
      : this.historicalBackends;
      
    const fallbackBackends = preferLive
      ? this.historicalBackends
      : (this.liveBackend ? [this.liveBackend] : []);
    
    const allBackends = [...primaryBackends, ...fallbackBackends];
    
    // Try each backend in order
    for (const backend of allBackends) {
      try {
        const backendType = backend === this.liveBackend ? 'live' : 'historical';
        logger.debug(`Calling backend: ${backend.name} (${backendType})`);
        
        const result = await this.withTimeout(
          fn(backend),
          this.getTimeoutForBackend(backend),
          backend.name
        );
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        
        const logLevel = backendError.statusCode === 404 ? 'debug' : 'warn';
        logger[logLevel](
          `Backend failed${backendError.statusCode === 404 ? ': resource not found' : ''}: ${backend.name} - ${backendError.message}`
        );
      }
    }
    
    throw new AllBackendsFailedError(errors);
  }

  /**
   * Route method call to appropriate backend based on method routing configuration
   * @param methodName name of the method being called
   * @param fn function to execute on backend
   * @returns {Promise<T>} result from backend
   */
  private route<T>(
    methodName: string,
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    const config = METHOD_ROUTING[methodName];
    if (!config) {
      logger.warn(`No routing config found for method ${methodName}, defaulting to live-first`);
      return this.executeWithPriority(fn, true);
    }
    return this.executeWithPriority(fn, config.preferLive);
  }

  /** 
   * Get transaction by hash with fallback between backends
   * @param txHash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  getTransaction(txHash: string): Promise<Transaction> {
    return this.route('getTransaction', b => b.getTransaction(txHash));
  }
  
  /** 
   * Get address by bech32 address with fallback between backends
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  getAddress(address: string): Promise<Address> {
    return this.route('getAddress', b => b.getAddress(address));
  }

  /** 
   * Get address UTxOs with fallback between backends
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  getAddressUtxos(address: string): Promise<UTxO[]> {
    return this.route('getAddressUtxos', b => b.getAddressUtxos(address));
  }

  /** 
   * Get network information with fallback between backends
   * @returns {Promise<Network>} network information
   */
  getNetworkInformation(): Promise<Network> {
    return this.route('getNetworkInformation', b => b.getNetworkInformation());
  }

  /** 
   * Get transaction metadata with fallback between backends
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata
   */
  getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return this.route('getTransactionMetadata', b => b.getTransactionMetadata(tx_hash));
  }

  /** 
   * Get block data with fallback between backends
   * @param block_hash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  getBlock(block_hash: string): Promise<BlockData> {
    return this.route('getBlock', b => b.getBlock(block_hash));
  }

  /** 
   * Get epoch data with fallback between backends
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  getEpoch(epochNumber: number): Promise<EpochData> {
    return this.route('getEpoch', b => b.getEpoch(epochNumber));
  }

  /** 
   * Get Pool data with fallback between backends
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  getPool(poolId: string): Promise<PoolData> {
    return this.route('getPool', b => b.getPool(poolId));
  }

  /** 
   * Get drep data with fallback between backends
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  getDrep(drepId: string): Promise<DrepData> {
    return this.route('getDrep', b => b.getDrep(drepId));
  }

  /** 
   * Get account data with fallback between backends
   * @param stakeAddress stake address
   * @returns {Promise<AccountData>} account data
   */
  getAccount(stakeAddress: string): Promise<AccountData> {
    return this.route('getAccount', b => b.getAccount(stakeAddress));
  }

  /** 
   * Get protocol parameters with fallback between backends
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return this.route('getProtocolParameters', b => b.getProtocolParameters());
  }

  /** 
   * Get latest block data with fallback between backends
   * @returns {Promise<BlockData>} latest block data
   */
  getLatestBlock(): Promise<BlockData> {
    return this.route('getLatestBlock', b => b.getLatestBlock());
  }

  /** 
   * Get latest epoch data with fallback between backends
   * @returns {Promise<EpochData>} latest epoch data
   */
  getLatestEpoch(): Promise<EpochData> {
    return this.route('getLatestEpoch', b => b.getLatestEpoch());
  }

  /** 
   * Submit transaction with fallback between backends
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  submitTransaction(signedTxCbor: string): Promise<string> {
    return this.route('submitTransaction', b => b.submitTransaction(signedTxCbor));
  }
}

/**
 * CardanoClientFactory - Factory for creating CardanoClient instances
 */
export class CardanoClientFactory {
  /**
   * Create CardanoClient instance from configuration
   * @returns {CardanoClient} configured client instance
   */
  static createFromConfig(): CardanoClient {
    const liveBackend = BackendRegistry.createLiveBackend();
    const historicalBackends = BackendRegistry.createHistoricalBackends();
    
    return new CardanoClient(liveBackend, historicalBackends);
  }

  /**
   * Create CardanoClient instance for specified backends (used in tests)
   * @param backendNames list of backend names
   * @returns {CardanoClient} CardanoClient instance
   */
  static createForBackends(backendNames: string[]): CardanoClient {
    let testLiveBackend: CardanoBackend | undefined;
    const testHistoricalBackends: CardanoBackend[] = [];

    for (const backendName of backendNames) {
      
      if (backendName === 'blockfrost' && CONFIG.blockfrostApiKey) {
        testHistoricalBackends.push(BackendRegistry.create('blockfrost'));
      }
      
      if (backendName === 'koios') {
        // Koios doesn't require an API key (optional)
        testHistoricalBackends.push(BackendRegistry.create('koios'));
      }
    }

    if (!testLiveBackend && testHistoricalBackends.length === 0) {
      throw new ConfigError(`No valid backends configured: ${backendNames.join(',')}`);
    }

    return new CardanoClient(testLiveBackend, testHistoricalBackends);
  }
}

/**
 * Legacy function for backward compatibility (used in tests)
 * @deprecated Use CardanoClientFactory.createForBackends() instead
 */
export function createCardanoClientForBackends(backendNames: string[]): CardanoClient {
  return CardanoClientFactory.createForBackends(backendNames);
}

/** CardanoClient exported singleton instance */
export const cardanoClient = CardanoClientFactory.createFromConfig();
export default cardanoClient;
