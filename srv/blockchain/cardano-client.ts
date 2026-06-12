import cds from '@sap/cds';
import { CardanoBackend, isEvaluatingBackend } from './backends/cardano-backend';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError } from '../utils/errors';
import { CircuitBreakerManager, type CircuitBreakerConfig } from './circuit-breaker';
import { RequestCoalescer } from './request-coalescer';

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
  AssetInfo,
  AssetHistoryEntry,
  LedgerProtocolParameters,
  ScriptEvaluationResult
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
  getAddressUtxos: { preferLive: false },
  getAddressTransactions: { preferLive: false },
  getNetworkInformation: { preferLive: true },
  getTransactionMetadata: { preferLive: false },
  getBlock: { preferLive: false },
  getEpoch: { preferLive: false },
  getLatestEpoch: { preferLive: true },
  getLatestBlock: { preferLive: true },
  getCurrentSlot: { preferLive: true },
  isUtxoUnspent: { preferLive: true },
  getPool: { preferLive: true },
  getDrep: { preferLive: false },
  getAccount: { preferLive: true },
  getAssetInfo: { preferLive: false },
  getProtocolParameters: { preferLive: true },
  submitTransaction: { preferLive: true },
};

export type Network = 'mainnet' | 'preview' | 'preprod';
export type BackendName = 'blockfrost' | 'koios' | 'ogmios';
export type TransactionBuilderName = 'buildooor';

export type CardanoClientConfig = {
  network: Network;
  backends: BackendName[];
  blockfrostApiKey: string;
  blockfrostCustomBackend?: string;
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
  max_age_ms: number = 60000; // default 1 minute for temporary caching
  private protocolParamsCache?: { data: LedgerProtocolParameters; fetchedAt: number };
  private protocolParamsFetchPromise: Promise<LedgerProtocolParameters> | null = null;
  private static readonly PROTOCOL_PARAMS_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Request coalescers — deduplicate concurrent fetches for the same resource
  private txCoalescer = new RequestCoalescer<Transaction>();
  private addrCoalescer = new RequestCoalescer<Address>();
  private credCoalescer = new RequestCoalescer<UTxO[]>();

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
      this.historicalBackends.push(new BlockfrostBackend(
        clientConfig.network,
        clientConfig.primaryTimeoutMs,
        clientConfig.blockfrostApiKey,
        clientConfig.blockfrostCustomBackend,
      ));
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
      } catch (err: unknown) {
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
      } catch (err: unknown) {
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
   * Run a single-backend call with the same resilience contract as
   * executeWithPriority: circuit-breaker gate, timeout, success/failure
   * recording (4xx exempt). For the paths that cannot fail over (Koios-only,
   * Ogmios-only, batch-capable loops) — these previously bypassed timeout AND
   * breaker entirely, so a hanging socket blocked the caller indefinitely.
   */
  private async callWithResilience<T>(backend: CardanoBackend, fn: () => Promise<T>): Promise<T> {
    if (!this.circuitBreaker.shouldAttempt(backend.name)) {
      throw new ProviderUnavailableError(`Circuit open for ${backend.name}`, backend.name);
    }
    try {
      const result = await this.withTimeout(fn(), this.getTimeoutForBackend(backend), backend.name);
      this.circuitBreaker.recordSuccess(backend.name);
      return result;
    } catch (err: unknown) {
      const backendError = normalizeBackendError(err, backend.name);
      const isClientError = backendError.statusCode >= 400 && backendError.statusCode < 500;
      if (!isClientError) {
        this.circuitBreaker.recordFailure(backend.name);
      }
      throw backendError;
    }
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
      } catch (err: unknown) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);

        // 4xx are definitive verdicts from a HEALTHY backend (bad input, not found,
        // conflict, rate limit) — only 5xx/timeouts/transport errors indicate backend
        // health and may open the circuit. Counting client errors opened the breaker
        // on user mistakes and took working backends out of rotation.
        const isClientError = backendError.statusCode >= 400 && backendError.statusCode < 500;
        if (!isClientError) {
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
    const config = METHOD_ROUTING[methodName] ?? { preferLive: false };
    return this.executeWithPriority(fn, config.preferLive);
  }

  /** 
   * Get transaction by hash with fallback between backends
   * @param txHash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  getTransaction(txHash: string): Promise<Transaction> {
    return this.txCoalescer.get(txHash, () =>
      this.route('getTransaction', b => b.getTransaction(txHash))
    );
  }
  
  /** 
   * Get address by bech32 address with fallback between backends
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  getAddress(address: string): Promise<Address> {
    return this.addrCoalescer.get(address, () =>
      this.route('getAddress', b => b.getAddress(address))
    );
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
   * Get UTxOs by 28-byte payment credential. Koios-only — bypasses generic
   * failover because no other backend exposes a credential-keyed UTxO endpoint.
   * Throws ProviderUnavailableError if Koios is not configured.
   * @param credHash 28-byte payment credential as 56-char lowercase hex
   * @returns {Promise<UTxO[]>} list of UTxOs across all bech32 forms sharing the credential
   */
  getCredentialUtxos(credHash: string): Promise<UTxO[]> {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    const koios = candidates.find(b => b?.name === 'koios' && typeof b.getCredentialUtxos === 'function');
    if (!koios) {
      throw new ProviderUnavailableError(
        "getCredentialUtxos requires Koios backend. Configure 'koios' in cds.requires.odatano-core.backends.",
        'koios'
      );
    }
    return this.credCoalescer.get(credHash, () => this.callWithResilience(koios, () => koios.getCredentialUtxos!(credHash)));
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
   * Get asset info (supply, mint history, CIP-25 + CIP-26 metadata) with fallback.
   * Both Blockfrost and Koios implement; Ogmios throws "not supported".
   * @param unit policyId + assetNameHex (concatenated hex)
   * @returns {Promise<AssetInfo>} canonical asset info
   */
  getAssetInfo(unit: string): Promise<AssetInfo> {
    return this.route('getAssetInfo', b => b.getAssetInfo(unit));
  }

  /**
   * Get latest mint/burn events for an asset. Prefers Koios because it provides
   * block timestamps; Blockfrost is the fallback (timestamps left null).
   * Ogmios doesn't implement — fallback skips it via the optional method check.
   * @param unit policyId + assetNameHex (concatenated hex)
   * @param limit max number of events (default 100)
   * @returns {Promise<AssetHistoryEntry[]>} list of mint/burn events (most recent first)
   */
  getAssetHistory(unit: string, limit: number = 100): Promise<AssetHistoryEntry[]> {
    const candidates: (CardanoBackend | undefined)[] = [...this.historicalBackends, this.liveBackend];
    const koios = candidates.find(b => b?.name === 'koios' && typeof b.getAssetHistory === 'function');
    if (koios) return this.callWithResilience(koios, () => koios.getAssetHistory!(unit, limit));
    const anyImpl = candidates.find(b => typeof b?.getAssetHistory === 'function');
    if (!anyImpl) {
      throw new ProviderUnavailableError(
        "getAssetHistory requires Blockfrost or Koios backend.",
        'asset-history'
      );
    }
    return this.callWithResilience(anyImpl, () => anyImpl.getAssetHistory!(unit, limit));
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /**
   * Get transaction hashes for an address (lightweight — no full tx details).
   * Uses getAddressTransactionHashes() if backend supports it, otherwise
   * falls back to getAddressTransactions() and extracts hashes.
   * @param address bech32 address
   * @param limit maximum number of hashes
   * @returns {Promise<string[]>} list of transaction hashes
   */
  async getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    // Try backends with getAddressTransactionHashes support
    const allBackends = this.getOrderedBackends(false); // historical preferred
    for (const backend of allBackends) {
      if (backend.getAddressTransactionHashes) {
        try {
          return await this.callWithResilience(backend, () => backend.getAddressTransactionHashes!(address, limit));
        } catch (err: unknown) {
          logger.debug(`getAddressTransactionHashes failed on ${backend.name}: ${err instanceof Error ? err.message : String(err)} — trying next backend`);
        }
      }
    }
    // Fallback: full fetch and extract hashes
    const txs = await this.getAddressTransactions(address, limit);
    return txs.map(tx => tx.hash);
  }

  /**
   * Batch fetch multiple transactions by hash.
   * Uses getTransactionsBatch() if backend supports it, otherwise
   * falls back to individual getTransaction() calls (still coalesced).
   * @param txHashes array of transaction hashes
   * @returns {Promise<Map<string, Transaction>>} map of hash -> Transaction
   */
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    // Try backends with batch support
    const allBackends = this.getOrderedBackends(false); // historical preferred
    for (const backend of allBackends) {
      if (backend.getTransactionsBatch) {
        try {
          return await this.callWithResilience(backend, () => backend.getTransactionsBatch!(txHashes));
        } catch (err: unknown) {
          logger.debug(`getTransactionsBatch failed on ${backend.name}: ${err instanceof Error ? err.message : String(err)} — trying next backend`);
        }
      }
    }
    // Fallback: individual coalesced calls
    const entries = await Promise.all(
      txHashes.map(h => this.getTransaction(h).then(tx => [h, tx] as const))
    );
    return new Map(entries);
  }

  /**
   * Get ordered backends based on preference (live vs historical).
   * Used by batch methods to find batch-capable backends.
   */
  private getOrderedBackends(preferLive: boolean): CardanoBackend[] {
    const backends: CardanoBackend[] = [];
    if (preferLive && this.liveBackend) backends.push(this.liveBackend);
    backends.push(...this.historicalBackends);
    if (!preferLive && this.liveBackend) backends.push(this.liveBackend);
    return backends;
  }

  /**
   * Get protocol parameters with caching (5 minute TTL)
   * Protocol parameters rarely change (once per epoch at most), so caching improves performance
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    const now = Date.now();
    if (this.protocolParamsCache && (now - this.protocolParamsCache.fetchedAt) < CardanoClient.PROTOCOL_PARAMS_TTL_MS) {
      logger.debug('Returning cached protocol parameters');
      return this.protocolParamsCache.data;
    }

    // Promise coalescing: deduplicate concurrent requests during cache miss
    if (!this.protocolParamsFetchPromise) {
      logger.debug('Fetching fresh protocol parameters');
      this.protocolParamsFetchPromise = this.route('getProtocolParameters', b => b.getProtocolParameters())
        .then(params => {
          this.protocolParamsCache = { data: params, fetchedAt: Date.now() };
          this.protocolParamsFetchPromise = null;
          return params;
        })
        .catch(err => {
          this.protocolParamsFetchPromise = null;
          throw err;
        });
    }
    return this.protocolParamsFetchPromise;
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
        logger.error(`Error shutting down live backend ${this.liveBackend.name}: ${err}`);
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
   * Get the current chain slot with fallback between backends.
   * @returns {Promise<number>} current chain slot
   */
  getCurrentSlot(): Promise<number> {
    return this.route('getCurrentSlot', b => b.getCurrentSlot());
  }

  /**
   * Check whether a UTxO is still unspent with fallback between backends.
   * @param txHash 64-char lowercase hex transaction hash
   * @param outputIndex non-negative integer output index
   * @returns {Promise<boolean>} true iff the UTxO exists and is unspent
   */
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    return this.route('isUtxoUnspent', b => b.isUtxoUnspent(txHash, outputIndex));
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
   * @returns {Promise<ScriptEvaluationResult[]>} evaluation results
   */
  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    await this.ensureInitialized();

    // Evaluation requires an EvaluatingBackend (typically Ogmios)
    if (!this.liveBackend || !isEvaluatingBackend(this.liveBackend)) {
      throw new ProviderUnavailableError('Transaction evaluation requires an evaluating backend (e.g., Ogmios)');
    }

    // timeout + breaker — a hanging Ogmios socket previously blocked Plutus builds indefinitely
    const backend = this.liveBackend;
    return this.callWithResilience(backend, () => backend.evaluateTransaction(unsignedTxCbor));
  }
}
