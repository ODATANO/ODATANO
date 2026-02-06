import cds from '@sap/cds';
import { CardanoBackend, isEvaluatingBackend } from './backends/cardano-backend';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError } from '../utils/errors';
import { CircuitBreakerManager, type CircuitBreakerConfig } from './circuit-breaker';

import {
  Transaction,
  Address,
  UTxO,
  NetworkInformation,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData,
  LedgerProtocolParameters
} from '../utils/types';
import { OgmiosBackend } from './backends/ogmios-backend';
import { BlockfrostBackend } from './backends/blockfrost-backend';
import { KoiosBackend } from './backends/koios-backend';

const logger = cds.log('CardanoClient');

/**
 * Method routing configuration - defines which backend type to prefer for each method
 */
const METHOD_ROUTING: Record<string, { preferLive: boolean }> = {
  getTransaction: { preferLive: false },
  getAddress: { preferLive: true },
  getAddressUtxos: { preferLive: true },
  getAddressTransactions: { preferLive: false },
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

export type Network = 'mainnet' | 'preview' | 'preprod';
export type BackendName = 'blockfrost' | 'koios' | 'ogmios';
export type TransactionBuilderName = 'csl' | 'buildooor';

export type CardanoClientConfig = {
  network: Network;
  backends: BackendName[];
  blockfrostApiKey: string;
  koiosApiKey: string;
  ogmiosUrl: string;
  transactionBuilders: TransactionBuilderName[];
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  indexTtlMs: number;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
}

/**
 * CardanoClient - Smart Multi-backend Cardano Client
 *
 * Routes requests to appropriate backends:
 * - Live/State queries → Ogmios (if available)
 * - Historical queries → Blockfrost/Koios (if available)
 * - Automatic fallback between backends
 */
export class CardanoClient {
  private config: CardanoClientConfig;
  private liveBackend?: CardanoBackend;
  private historicalBackends: CardanoBackend[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private circuitBreaker: CircuitBreakerManager;
  network: Network;
  max_age_ms: number = 60000; // default 10 minutes for temporary caching

  /** 
   * Constructor for CardanoClient
   * @param liveBackend - Optional backend for live/state queries (typically Ogmios)
   * @param historicalBackends - Optional backends for historical queries (typically Blockfrost/Koios)
   */
  constructor( clientConfig: CardanoClientConfig) {
    this.network = clientConfig.network;
   
    const backends = clientConfig.backends;

    if (backends.includes('ogmios')) {
      this.liveBackend = new OgmiosBackend(clientConfig.network, clientConfig.primaryTimeoutMs, clientConfig.ogmiosUrl);
    }

    if (backends.includes('blockfrost')) {
      this.historicalBackends.push(new BlockfrostBackend(clientConfig.network, clientConfig.primaryTimeoutMs, clientConfig.blockfrostApiKey));
    }
    if (backends.includes('koios')) {
      this.historicalBackends.push(new KoiosBackend(clientConfig.network, clientConfig.primaryTimeoutMs, clientConfig.koiosApiKey));
    }

    if (!this.liveBackend && this.historicalBackends.length === 0) {
      throw new ConfigError('No valid backends configured for CardanoClient');
    }

    this.circuitBreaker = new CircuitBreakerManager(clientConfig.circuitBreaker);
    logger.info('CardanoClient instance created.');
    this.config = clientConfig;
  }

  /**
   * Ensure backends are initialized
   * @returns {Promise<void>}
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Use nullish coalescing assignment for atomic operation to prevent race conditions
    this.initPromise ??= this.initBackends();
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
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new ProviderUnavailableError('Backend timeout', backendName, ms)),
        ms
      );
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /** 
   * Get timeout for specific backend
   * @param backend CardanoBackend instance
   * @returns {number} timeout in milliseconds
   */
  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'koios') return this.config.fallbackTimeoutMs;
    return this.config.primaryTimeoutMs;
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
    
    // Try each backend in order, respecting circuit breaker state
    for (const backend of allBackends) {
      if (!this.circuitBreaker.shouldAttempt(backend.name)) {
        logger.debug(`Circuit open for ${backend.name}, skipping`);
        continue;
      }

      try {
        const backendType = backend === this.liveBackend ? 'live' : 'historical';
        logger.debug(`Calling backend: ${backend.name} (${backendType})`);

        const result = await this.withTimeout(
          fn(backend),
          this.getTimeoutForBackend(backend),
          backend.name
        );
        this.circuitBreaker.recordSuccess(backend.name);
        return result;
      } catch (err: any) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);

        // Don't count 404s as backend failures (resource not found is a valid response)
        if (backendError.statusCode !== 404) {
          this.circuitBreaker.recordFailure(backend.name);
        }

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
    return this.executeWithPriority(fn, config?.preferLive ?? true);
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
   * Get address transactions with fallback between backends
   * @param address bech32 address
   * @returns {Promise<Transaction[]>} list of transactions for this address
   */
  getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return this.route('getAddressTransactions', b => b.getAddressTransactions(address, limit));
  }

  /**
   * Get network information with fallback between backends
   * @returns {Promise<Network>} network information
   */
  getNetworkInformation(): Promise<NetworkInformation> {
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
   * Get protocol parameters with caching (5 minute TTL)
   * Protocol parameters rarely change (once per epoch at most), so caching improves performance
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    // Fetch fresh parameters
    logger.debug('Fetching fresh protocol parameters');
    return this.route('getProtocolParameters', b => b.getProtocolParameters());
  }

  /**
   * Shutdown all backends (for cleanup in tests)
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down CardanoClient backends...');

    // Shutdown live backend if it has a shutdown method
    if (this.liveBackend && 'shutdown' in this.liveBackend && typeof this.liveBackend.shutdown === 'function') {
      try {
        await this.liveBackend.shutdown();
        logger.debug(`Live backend ${this.liveBackend.name} shut down`);
      } catch (err) {
        logger.error(`Error shutting down live backend: ${err}`);
      }
    }

    // Shutdown historical backends
    for (const backend of this.historicalBackends) {
      if ('shutdown' in backend && typeof backend.shutdown === 'function') {
        try {
          await backend.shutdown();
          logger.debug(`Historical backend ${backend.name} shut down`);
        } catch (err) {
          logger.error(`Error shutting down historical backend ${backend.name}: ${err}`);
        }
      }
    }

    this.initialized = false;
    this.initPromise = null;
    logger.info('CardanoClient shutdown complete');
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

  /**
   * Check if Ogmios backend is available for transaction evaluation
   * @returns {boolean} true if Ogmios is the live backend
   */
  hasOgmiosBackend(): boolean {
    return this.liveBackend?.name === 'ogmios';
  }

  /**
   * Evaluate transaction script execution units (Ogmios only)
   * @param unsignedTxCbor unsigned transaction in CBOR hex format
   * @returns {Promise<Array<{validator: unknown, budget: {memory: number, cpu: number}}>>} evaluation results
   */
  async evaluateTransaction(unsignedTxCbor: string): Promise<Array<{validator: unknown, budget: {memory: number, cpu: number}}>> {
    await this.ensureInitialized();

    // Evaluation requires an EvaluatingBackend (typically Ogmios)
    if (!this.liveBackend || !isEvaluatingBackend(this.liveBackend)) {
      throw new Error('Transaction evaluation requires an evaluating backend (e.g., Ogmios)');
    }

    return this.liveBackend.evaluateTransaction(unsignedTxCbor);
  }
}
