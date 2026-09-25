import cds from '@sap/cds';
import { CardanoBackend, isEvaluatingBackend, ChainSyncBackend, PaginatingBackend, EnumeratingBackend, LedgerStateBackend, isChainSyncBackend, isPaginatingBackend, isEnumeratingBackend, isLedgerStateBackend } from './backends/cardano-backend';
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

/** Which backend type to prefer per method. */
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
 * Multi-backend Cardano client: live/state queries prefer Ogmios, historical queries prefer
 * Blockfrost/Koios, with automatic fallback between them.
 */
export class CardanoClient {
  private config: CardanoClientConfig;
  private liveBackend?: CardanoBackend;
  private historicalBackends: CardanoBackend[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private circuitBreaker: CircuitBreakerManager;
  /** Backends whose init failed — kept in rotation and retried lazily per request */
  private uninitializedBackends = new Set<CardanoBackend>();
  network: Network;
  max_age_ms: number = 60000; // default 1 minute for temporary caching
  private protocolParamsCache?: { data: LedgerProtocolParameters; fetchedAt: number };
  private protocolParamsFetchPromise: Promise<LedgerProtocolParameters> | null = null;
  private static readonly PROTOCOL_PARAMS_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Request coalescers — deduplicate concurrent fetches for the same resource
  private txCoalescer = new RequestCoalescer<Transaction>();
  private addrCoalescer = new RequestCoalescer<Address>();
  private credCoalescer = new RequestCoalescer<UTxO[]>();

  /** Builds the configured backends; throws ConfigError when none is configured. */
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
    // indexTtlMs is the cache TTL the indexer reads via max_age_ms
    if (Number.isFinite(clientConfig.indexTtlMs) && clientConfig.indexTtlMs > 0) {
      this.max_age_ms = clientConfig.indexTtlMs;
    }
    logger.info(`CardanoClient instance created (cache TTL ${this.max_age_ms} ms).`);
    this.config = clientConfig;
  }

  /** Names of the configured backends (live + historical), for status reporting. */
  listBackends(): string[] {
    const names: string[] = [];
    if (this.liveBackend) names.push(this.liveBackend.name);
    names.push(...this.historicalBackends.map(b => b.name));
    return names;
  }

  /**
   * Ensure backends are initialized. A rejected init promise is cleared so the next request
   * retries instead of leaving the client permanently broken.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // ??= keeps concurrent callers on one init promise
    this.initPromise ??= this.initBackends().catch((err: unknown) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  /**
   * Transient (retryable) init failures: a backend momentarily unreachable at startup
   * (connection refused/reset, a cut-short health response). Config/validation errors are not.
   */
  private static isTransientInitError(err: unknown): boolean {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e?.code ?? e?.cause?.code ?? '';
    const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`.toLowerCase();
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
    return /premature close|socket hang up|econnreset|econnrefused|etimedout|timeout|fetch failed|terminated|other side closed/.test(msg);
  }

  /**
   * Init a backend, retrying brief transient failures. Kept small (3 attempts, 1 s backoff) so
   * a sustained outage still fails fast and the total stays under the test bootstrap hook.
   */
  private async initBackendWithRetry(backend: CardanoBackend): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await backend.init();
        return;
      } catch (err: unknown) {
        if (attempt >= maxAttempts || !CardanoClient.isTransientInitError(err)) throw err;
        logger.warn(`Init of ${backend.name} failed (attempt ${attempt}/${maxAttempts}) — transient, retrying in 1s`, err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  /**
   * Initialize all backends. Backends whose init fails stay in rotation, tracked in
   * `uninitializedBackends`, and are retried lazily per request (bounded by the circuit breaker).
   */
  private async initBackends(): Promise<void> {
    const initErrors: BackendInitError[] = [];

    // Initialize live backend
    if (this.liveBackend) {
      try {
        logger.debug(`Initializing live backend: ${this.liveBackend.name}`);
        await this.initBackendWithRetry(this.liveBackend);
        this.uninitializedBackends.delete(this.liveBackend);
        logger.debug(`Live backend initialized: ${this.liveBackend.name}`);
      } catch (err: unknown) {
        initErrors.push(new BackendInitError(this.liveBackend.name, err));
        logger.error(`Failed to initialize live backend: ${this.liveBackend.name} — kept for lazy retry`, err);
        this.uninitializedBackends.add(this.liveBackend);
      }
    }

    // Initialize historical backends
    for (const backend of this.historicalBackends) {
      try {
        logger.debug(`Initializing historical backend: ${backend.name}`);
        await this.initBackendWithRetry(backend);
        this.uninitializedBackends.delete(backend);
        logger.debug(`Historical backend initialized: ${backend.name}`);
      } catch (err: unknown) {
        initErrors.push(new BackendInitError(backend.name, err));
        logger.error(`Failed to initialize historical backend: ${backend.name} — kept for lazy retry`, err);
        this.uninitializedBackends.add(backend);
      }
    }

    const totalBackends = (this.liveBackend ? 1 : 0) + this.historicalBackends.length;
    if (initErrors.length >= totalBackends) {
      throw new AllBackendsInitFailedError(initErrors);
    }

    this.initialized = true;
  }

  /**
   * Lazily retry a backend's init when it failed at startup. Returns true when
   * the backend is usable; false (after recording a breaker failure) when the
   * retry failed.
   */
  private async ensureBackendInitialized(backend: CardanoBackend, errors?: BackendError[]): Promise<boolean> {
    if (!this.uninitializedBackends.has(backend)) return true;
    try {
      await backend.init();
      this.uninitializedBackends.delete(backend);
      logger.info(`Backend ${backend.name} recovered (lazy init succeeded)`);
      return true;
    } catch (err: unknown) {
      const initError = new BackendInitError(backend.name, err);
      errors?.push(initError);
      this.circuitBreaker.recordFailure(backend.name);
      logger.debug(`Lazy init retry for ${backend.name} failed: ${initError.message}`);
      return false;
    }
  }

  /** Wrap a promise with a timeout that rejects with ProviderUnavailableError. */
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

  /** Per-backend timeout: Koios gets the fallback timeout, everything else the primary one. */
  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'koios') return this.config.fallbackTimeoutMs;
    return this.config.primaryTimeoutMs;
  }

  /**
   * Single-backend call with the executeWithPriority resilience contract (breaker gate, timeout,
   * success/failure recording, 4xx exempt) for paths that cannot fail over.
   */
  private async callWithResilience<T>(backend: CardanoBackend, fn: () => Promise<T>): Promise<T> {
    if (!this.circuitBreaker.shouldAttempt(backend.name)) {
      throw new ProviderUnavailableError(`Circuit open for ${backend.name}`, backend.name);
    }
    // fast-path sync check — keeps fn() synchronous for the request coalescers
    if (this.uninitializedBackends.has(backend) && !(await this.ensureBackendInitialized(backend))) {
      throw new ProviderUnavailableError(`Backend ${backend.name} is not initialized (lazy retry failed)`, backend.name);
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

  /** Execute on backends in preference order (live vs historical) with automatic fallback. */
  private async executeWithPriority<T>(
    fn: (backend: CardanoBackend) => Promise<T>,
    preferLive: boolean,
    methodName?: string
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
      // capability routing: declared non-support is a skip, not a failure
      if (methodName && backend.unsupportedMethods?.has(methodName)) {
        logger.debug(`${backend.name} does not support ${methodName}, skipping`);
        continue;
      }
      if (!this.circuitBreaker.shouldAttempt(backend.name)) {
        logger.debug(`Circuit open for ${backend.name}, skipping`);
        continue;
      }
      // fast-path sync check — only await the init retry in the rare failure case
      if (this.uninitializedBackends.has(backend) && !(await this.ensureBackendInitialized(backend, errors))) {
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

        // 4xx are definitive verdicts from a healthy backend and must not open the circuit;
        // only 5xx/timeouts/transport errors indicate backend health.
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

  /** Route a call by METHOD_ROUTING (default: historical first). */
  private route<T>(
    methodName: string,
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    const config = METHOD_ROUTING[methodName] ?? { preferLive: false };
    return this.executeWithPriority(fn, config.preferLive, methodName);
  }

  /** Transaction by hash (coalesced across concurrent callers). */
  getTransaction(txHash: string): Promise<Transaction> {
    return this.txCoalescer.get(txHash, () =>
      this.route('getTransaction', b => b.getTransaction(txHash))
    );
  }
  
  /** Address data (coalesced across concurrent callers). */
  getAddress(address: string): Promise<Address> {
    return this.addrCoalescer.get(address, () =>
      this.route('getAddress', b => b.getAddress(address))
    );
  }

  getAddressUtxos(address: string): Promise<UTxO[]> {
    return this.route('getAddressUtxos', b => b.getAddressUtxos(address));
  }

  /**
   * UTxOs by 28-byte payment credential (56-char hex), across all bech32 forms sharing it.
   * Koios-only: no other backend has a credential-keyed endpoint, so this throws without Koios.
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

  getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return this.route('getAddressTransactions', b => b.getAddressTransactions(address, limit));
  }

  getNetworkInformation(): Promise<NetworkInformation> {
    return this.route('getNetworkInformation', b => b.getNetworkInformation());
  }

  getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return this.route('getTransactionMetadata', b => b.getTransactionMetadata(tx_hash));
  }

  getBlock(block_hash: string): Promise<BlockData> {
    return this.route('getBlock', b => b.getBlock(block_hash));
  }

  getEpoch(epochNumber: number): Promise<EpochData> {
    return this.route('getEpoch', b => b.getEpoch(epochNumber));
  }

  getPool(poolId: string): Promise<PoolData> {
    return this.route('getPool', b => b.getPool(poolId));
  }

  getDrep(drepId: string): Promise<DrepData> {
    return this.route('getDrep', b => b.getDrep(drepId));
  }

  getAccount(stakeAddress: string): Promise<AccountData> {
    return this.route('getAccount', b => b.getAccount(stakeAddress));
  }

  /** Asset info (supply, mint history, CIP-25/CIP-26 metadata); Blockfrost and Koios only. */
  getAssetInfo(unit: string): Promise<AssetInfo> {
    return this.route('getAssetInfo', b => b.getAssetInfo(unit));
  }

  /**
   * Latest mint/burn events for an asset, most recent first. Prefers Koios (block timestamps);
   * Blockfrost is the fallback with timestamps left null.
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
   * Transaction hashes for an address; falls back to a full getAddressTransactions when no
   * backend supports the lightweight listing.
   */
  async getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    const allBackends = this.getOrderedBackends();
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

  /** Batch fetch transactions by hash; falls back to individual coalesced getTransaction calls. */
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    const allBackends = this.getOrderedBackends();
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

  /** Backends in historical-first order, for the batch methods. */
  private getOrderedBackends(): CardanoBackend[] {
    const backends: CardanoBackend[] = [...this.historicalBackends];
    if (this.liveBackend) backends.push(this.liveBackend);
    return backends;
  }

  /**
   * A backend that supports streamed chain-sync (Ogmios), or null. Backends whose init failed
   * are skipped: the crawler uses these instances directly, outside the lazy-retry/breaker path.
   */
  getChainSyncBackend(): ChainSyncBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isChainSyncBackend(b)) return b;
    }
    return null;
  }

  /**
   * getChainSyncBackend(), retrying a failed startup init. Polled by the crawler while it runs
   * on pagination because no chain-sync source was usable when it started.
   */
  async recoverChainSyncBackend(): Promise<ChainSyncBackend | null> {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (!b || !isChainSyncBackend(b)) continue;
      if (await this.ensureBackendInitialized(b)) return b;
    }
    return null;
  }

  /** The first usable backend that can dump the UTxO set at a point (Ogmios) — crawler.utxoSet import. */
  getLedgerStateBackend(): LedgerStateBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isLedgerStateBackend(b)) return b;
    }
    return null;
  }

  /**
   * A backend that can enumerate the full pool/DRep set (Koios), or null; without one the epoch
   * snapshots stay off instead of degrading into thousands of single requests.
   */
  getEnumeratingBackend(): EnumeratingBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [...this.historicalBackends, this.liveBackend];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isEnumeratingBackend(b)) return b;
    }
    return null;
  }

  /**
   * A backend that can be walked forward by pagination (Blockfrost/Koios), or null. Koios is
   * preferred: it batches 100 txs per call, Blockfrost needs ~3 calls per tx.
   */
  getPaginatingBackend(): PaginatingBackend | null {
    const usable = this.historicalBackends.filter(
      (b) => !this.uninitializedBackends.has(b) && isPaginatingBackend(b)
    ) as PaginatingBackend[];
    const koios = usable.find((b) => b.name === 'koios');
    if (koios) return koios;
    if (usable.length) return usable[0];
    if (this.liveBackend && !this.uninitializedBackends.has(this.liveBackend) && isPaginatingBackend(this.liveBackend)) {
      return this.liveBackend;
    }
    return null;
  }

  /** Protocol parameters with a 5-minute in-memory cache and coalesced refresh. */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    const now = Date.now();
    if (this.protocolParamsCache && (now - this.protocolParamsCache.fetchedAt) < CardanoClient.PROTOCOL_PARAMS_TTL_MS) {
      logger.debug('Returning cached protocol parameters');
      return this.protocolParamsCache.data;
    }

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

  /** Shut down all backends. */
  async shutdown(): Promise<void> {
    logger.info('Shutting down CardanoClient backends...');

    if (this.liveBackend && 'shutdown' in this.liveBackend && typeof this.liveBackend.shutdown === 'function') {
      try {
        await this.liveBackend.shutdown();
        logger.debug(`Live backend ${this.liveBackend.name} shut down`);
      } catch (err) {
        logger.error(`Error shutting down live backend ${this.liveBackend.name}: ${err}`);
      }
    }

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

  getLatestBlock(): Promise<BlockData> {
    return this.route('getLatestBlock', b => b.getLatestBlock());
  }

  getLatestEpoch(): Promise<EpochData> {
    return this.route('getLatestEpoch', b => b.getLatestEpoch());
  }

  getCurrentSlot(): Promise<number> {
    return this.route('getCurrentSlot', b => b.getCurrentSlot());
  }

  /** True iff the UTxO exists and is unspent. */
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    return this.route('isUtxoUnspent', b => b.isUtxoUnspent(txHash, outputIndex));
  }

  /**
   * Submit a signed transaction (CBOR hex); returns its hash. On failover after a lost response
   * the next backend may answer 409 "already submitted" — callers treat that as success.
   */
  submitTransaction(signedTxCbor: string): Promise<string> {
    return this.route('submitTransaction', b => b.submitTransaction(signedTxCbor));
  }

  /** True when Ogmios is the live backend (script evaluation available). */
  hasOgmiosBackend(): boolean {
    return this.liveBackend?.name === 'ogmios';
  }

  /** Evaluate script execution units of an unsigned transaction (Ogmios only). */
  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    await this.ensureInitialized();

    if (!this.liveBackend || !isEvaluatingBackend(this.liveBackend)) {
      throw new ProviderUnavailableError('Transaction evaluation requires an evaluating backend (e.g., Ogmios)');
    }

    // timeout + breaker, so a hanging socket cannot block Plutus builds
    const backend = this.liveBackend;
    return this.callWithResilience(backend, () => backend.evaluateTransaction(unsignedTxCbor));
  }
}
