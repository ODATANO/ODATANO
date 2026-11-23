import cds from '@sap/cds';
import { CardanoBackend, isEvaluatingBackend, ChainSyncBackend, PaginatingBackend, EnumeratingBackend, LedgerStateBackend, EpochStateBackend, isEpochStateBackend, isChainSyncBackend, isPaginatingBackend, isEnumeratingBackend, isLedgerStateBackend, TokenRegistryBackend, isTokenRegistryBackend, RewardAccountStateBackend, isRewardAccountStateBackend } from './backends/cardano-backend';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError, TransactionAlreadySubmittedError, isBackendVerdict, errorText } from '../utils/errors';
import { PendingSpends } from './pending-spends';
import { DEFAULT_INDEX_TTL_MS, PROTOCOL_PARAMS_TTL_MS } from '../utils/const';
import { CircuitBreakerManager, type CircuitBreakerConfig } from './circuit-breaker';
import { RequestCoalescer } from './request-coalescer';
import { withCallSignal } from './backends/call-signal';

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

// A backend module loads when its backend is configured, and its provider SDK with it.
const backendModules = {
  ogmios: () => require('./backends/ogmios-backend') as typeof import('./backends/ogmios-backend'),
  blockfrost: () => require('./backends/blockfrost-backend') as typeof import('./backends/blockfrost-backend'),
  koios: () => require('./backends/koios-backend') as typeof import('./backends/koios-backend'),
  odatano: () => require('./backends/odatano-backend') as typeof import('./backends/odatano-backend'),
};

const logger = cds.log('CardanoClient');

/** Which backend type to prefer per method. */
const METHOD_ROUTING: Record<string, { preferLive: boolean; finalOnClientError?: boolean }> = {
  getTransaction: { preferLive: false },
  // node first: UTxOs at the tip; Ogmios decodes the type itself (base/enterprise/…, not shelley/byron)
  getAddress: { preferLive: true },
  getAddressUtxos: { preferLive: true },
  getAddressTransactions: { preferLive: false },
  // providers first: they report circulation; Ogmios only has treasury and reserves
  getNetworkInformation: { preferLive: false },
  getTransactionMetadata: { preferLive: false },
  getBlock: { preferLive: false },
  getEpoch: { preferLive: false },
  getLatestEpoch: { preferLive: true },
  getLatestBlock: { preferLive: true },
  getCurrentSlot: { preferLive: true },
  isUtxoUnspent: { preferLive: true },
  getPool: { preferLive: true },
  // node first; a DRep the ledger no longer lists (retired) falls through to the providers
  getDrep: { preferLive: true },
  getAccount: { preferLive: true },
  getAssetInfo: { preferLive: false },
  getProtocolParameters: { preferLive: true },
  // a node's rejection (4xx) is final: another backend submits to the same ledger
  submitTransaction: { preferLive: true, finalOnClientError: true },
};

export type Network = 'mainnet' | 'preview' | 'preprod';

/** A backend that reads unspent outputs by reference. */
interface OutputLookupBackend {
  getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[]>;
}
export type BackendName = 'blockfrost' | 'koios' | 'ogmios' | 'odatano';

export type CardanoClientConfig = {
  network: Network;
  backends: BackendName[];
  blockfrostApiKey: string;
  blockfrostCustomBackend?: string;
  koiosApiKey: string;
  ogmiosUrl: string;
  /** Remote ODATANO for the `odatano` backend; defaults to the public API of the network. */
  odatanoUrl?: string;
  /** Key for the remote ODATANO (a gateway `oda_…` key or an agent grant token). */
  odatanoApiKey?: string;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  indexTtlMs: number;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
}

// Multi-backend client. Live state queries prefer Ogmios, historical queries prefer Blockfrost
// or Koios, with automatic fallback between them.
export class CardanoClient {
  private config: CardanoClientConfig;
  private liveBackend?: CardanoBackend;
  private historicalBackends: CardanoBackend[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private circuitBreaker: CircuitBreakerManager;
  /** Backends whose init failed. They stay in rotation and init is retried per request. */
  private uninitializedBackends = new Set<CardanoBackend>();
  /** Running init retry per backend, shared by concurrent callers. */
  private initRetries = new Map<CardanoBackend, Promise<boolean>>();
  network: Network;
  max_age_ms: number = DEFAULT_INDEX_TTL_MS;
  /** Transactions submitted through this client that the ledger view does not show yet. */
  readonly pendingSpends = new PendingSpends();
  private protocolParamsCache?: { data: LedgerProtocolParameters; fetchedAt: number };
  private protocolParamsFetchPromise: Promise<LedgerProtocolParameters> | null = null;
  /** Last protocol parameters the live backend (node) answered. */
  private lastLiveProtocolParams?: LedgerProtocolParameters;

  // Deduplicate concurrent fetches for the same resource.
  private txCoalescer = new RequestCoalescer<Transaction>();
  private addrCoalescer = new RequestCoalescer<Address>();
  private credCoalescer = new RequestCoalescer<UTxO[]>();

  /** Builds the configured backends; throws ConfigError when none is configured. */
  constructor( clientConfig: CardanoClientConfig) {
    this.network = clientConfig.network;
   
    const backends = clientConfig.backends;

    if (backends.includes('ogmios')) {
      const { OgmiosBackend } = backendModules.ogmios();
      this.liveBackend = new OgmiosBackend(clientConfig.network, clientConfig.primaryTimeoutMs, clientConfig.ogmiosUrl);
    }

    if (backends.includes('blockfrost')) {
      const { BlockfrostBackend } = backendModules.blockfrost();
      this.historicalBackends.push(new BlockfrostBackend(
        clientConfig.network,
        clientConfig.primaryTimeoutMs,
        clientConfig.blockfrostApiKey,
        clientConfig.blockfrostCustomBackend,
      ));
    }
    if (backends.includes('koios')) {
      const { KoiosBackend } = backendModules.koios();
      // the same timeout the client allows a Koios call, see getTimeoutForBackend
      this.historicalBackends.push(new KoiosBackend(clientConfig.network, clientConfig.fallbackTimeoutMs, clientConfig.koiosApiKey));
    }
    if (backends.includes('odatano')) {
      // A remote ODATANO runs its own failover chain behind one call, so it gets the longer fallback timeout.
      const { OdatanoBackend } = backendModules.odatano();
      this.historicalBackends.push(new OdatanoBackend(
        clientConfig.network, clientConfig.fallbackTimeoutMs, clientConfig.odatanoUrl, clientConfig.odatanoApiKey,
      ));
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

  /** A failed init promise is cleared so the next request retries instead of staying broken. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // ??= keeps concurrent callers on one init promise
    this.initPromise ??= this.initBackends().catch((err: unknown) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  /** True for a backend that is briefly unreachable at startup. Config errors are not transient. */
  private static isTransientInitError(err: unknown): boolean {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e?.code ?? e?.cause?.code ?? '';
    const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`.toLowerCase();
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
    return /premature close|socket hang up|econnreset|econnrefused|etimedout|timeout|fetch failed|terminated|other side closed/.test(msg);
  }

  // Retries brief transient init failures. Few attempts with a short backoff, so a real
  // outage still fails fast and stays under the test bootstrap timeout.
  private async initBackendWithRetry(backend: CardanoBackend): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await backend.init();
        return;
      } catch (err: unknown) {
        if (attempt >= maxAttempts || !CardanoClient.isTransientInitError(err)) throw err;
        logger.warn(`Init of ${backend.name} failed (attempt ${attempt}/${maxAttempts}), transient, retrying in 1s`, err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  /** Backends whose init fails stay in rotation and are retried per request, bounded by the breaker. */
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
        logger.error(`Failed to initialize live backend: ${this.liveBackend.name}, kept for lazy retry`, err);
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
        logger.error(`Failed to initialize historical backend: ${backend.name}, kept for lazy retry`, err);
        this.uninitializedBackends.add(backend);
      }
    }

    const totalBackends = (this.liveBackend ? 1 : 0) + this.historicalBackends.length;
    if (initErrors.length >= totalBackends) {
      throw new AllBackendsInitFailedError(initErrors);
    }

    this.initialized = true;
  }

  // Retries a failed startup init. Concurrent callers share one attempt, so a backend that holds
  // a connection (Ogmios) opens one. False records a breaker failure.
  private async ensureBackendInitialized(backend: CardanoBackend, errors?: BackendError[]): Promise<boolean> {
    if (!this.uninitializedBackends.has(backend)) return true;
    let attempt = this.initRetries.get(backend);
    if (!attempt) {
      attempt = backend.init().then(() => {
        this.uninitializedBackends.delete(backend);
        logger.info(`Backend ${backend.name} recovered (lazy init succeeded)`);
        return true;
      }, (err: unknown) => {
        const initError = new BackendInitError(backend.name, err);
        this.circuitBreaker.recordFailure(backend.name);
        logger.debug(`Lazy init retry for ${backend.name} failed: ${initError.message}`);
        throw initError;
      }).finally(() => this.initRetries.delete(backend));
      this.initRetries.set(backend, attempt);
    }
    try {
      return await attempt;
    } catch (err: unknown) {
      errors?.push(err instanceof BackendError ? err : new BackendInitError(backend.name, err));
      return false;
    }
  }

  // Runs `call` with a deadline. On timeout it rejects with ProviderUnavailableError and aborts the
  // call's signal, so the HTTP requests and batch loops the call started stop too.
  private withTimeout<T>(call: () => Promise<T>, ms: number, backendName: string): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        const timeout = new ProviderUnavailableError('Backend timeout', backendName, ms);
        controller.abort(timeout);
        reject(timeout);
      }, ms);
    });
    let run: Promise<T>;
    try {
      run = withCallSignal(controller.signal, call);
    } catch (err: unknown) {
      // a call that throws before it returns its promise leaves no timer behind
      clearTimeout(timeoutId!);
      return Promise.reject(err);
    }
    return Promise.race([run, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /** Per-backend timeout: Koios and a remote ODATANO get the fallback timeout, everything else the primary one. */
  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'koios' || backend.name === 'odatano') return this.config.fallbackTimeoutMs;
    return this.config.primaryTimeoutMs;
  }

  // One backend call with the same breaker, timeout and recording rules as executeWithPriority.
  // For paths that cannot fail over.
  private async callWithResilience<T>(backend: CardanoBackend, fn: () => Promise<T>): Promise<T> {
    if (!this.circuitBreaker.shouldAttempt(backend.name)) {
      throw new ProviderUnavailableError(`Circuit open for ${backend.name}`, backend.name);
    }
    // Sync check first keeps fn() synchronous for the request coalescers.
    if (this.uninitializedBackends.has(backend) && !(await this.ensureBackendInitialized(backend))) {
      throw new ProviderUnavailableError(`Backend ${backend.name} is not initialized (lazy retry failed)`, backend.name);
    }
    try {
      const result = await this.withTimeout(fn, this.getTimeoutForBackend(backend), backend.name);
      this.circuitBreaker.recordSuccess(backend.name);
      return result;
    } catch (err: unknown) {
      const backendError = normalizeBackendError(err, backend.name);
      this.recordOutcome(backend, backendError);
      throw backendError;
    }
  }

  // A verdict about the request (404, 400) comes from a healthy backend: it releases a half-open
  // probe and is no failure. Anything else, a rate limit included, counts as a failure.
  private recordOutcome(backend: CardanoBackend, error: BackendError): void {
    if (isBackendVerdict(error)) this.circuitBreaker.recordVerdict(backend.name);
    else this.circuitBreaker.recordFailure(backend.name);
  }

  /** Execute on backends in preference order (live vs historical) with automatic fallback. */
  private async executeWithPriority<T>(
    fn: (backend: CardanoBackend) => Promise<T>,
    preferLive: boolean,
    methodName?: string,
    finalOnClientError = false
  ): Promise<T> {
    await this.ensureInitialized();
    const errors: BackendError[] = [];
    const skipped: string[] = [];

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
        skipped.push(`${backend.name}: does not support ${methodName}`);
        continue;
      }
      if (!this.circuitBreaker.shouldAttempt(backend.name)) {
        logger.debug(`Circuit open for ${backend.name}, skipping`);
        skipped.push(`${backend.name}: circuit open`);
        continue;
      }
      // Sync check first, so only the rare failure case awaits the init retry.
      if (this.uninitializedBackends.has(backend) && !(await this.ensureBackendInitialized(backend, errors))) {
        continue;
      }

      try {
        const backendType = backend === this.liveBackend ? 'live' : 'historical';
        logger.debug(`Calling backend: ${backend.name} (${backendType})`);

        const result = await this.withTimeout(() => fn(backend), this.getTimeoutForBackend(backend), backend.name);
        this.circuitBreaker.recordSuccess(backend.name);
        return result;
      } catch (err: unknown) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        this.recordOutcome(backend, backendError);

        const logLevel = backendError.statusCode === 404 ? 'debug' : 'warn';
        logger[logLevel](
          `Backend failed${backendError.statusCode === 404 ? ': resource not found' : ''}: ${backend.name} - ${backendError.message}`
        );
        if (finalOnClientError && isBackendVerdict(backendError)) throw backendError;
      }
    }

    throw new AllBackendsFailedError(errors, undefined, skipped);
  }

  /** Route a call by METHOD_ROUTING (default: historical first). */
  private route<T>(
    methodName: string,
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    const config = METHOD_ROUTING[methodName] ?? { preferLive: false };
    return this.executeWithPriority(fn, config.preferLive, methodName, config.finalOnClientError);
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

  // UTxOs of every address form that shares the payment credential, Koios first, then another ODATANO.
  // Blockfrost has no credential lookup.
  getCredentialUtxos(credHash: string): Promise<UTxO[]> {
    const capable = this.capableBackends(b => typeof b.getCredentialUtxos === 'function', 'koios');
    if (!capable.length) {
      throw new ProviderUnavailableError(
        "getCredentialUtxos requires a Koios or odatano backend. Configure one in cds.requires.odatano-core.backends.",
        'koios'
      );
    }
    return this.credCoalescer.get(credHash, () => this.firstAnswer(capable, b => b.getCredentialUtxos!(credHash)));
  }

  /** Backends that pass `can`, the one named `preferred` first. */
  private capableBackends(can: (b: CardanoBackend) => boolean, preferred: string): CardanoBackend[] {
    const candidates = [this.liveBackend, ...this.historicalBackends].filter((b): b is CardanoBackend => !!b && can(b));
    return [...candidates.filter(b => b.name === preferred), ...candidates.filter(b => b.name !== preferred)];
  }

  // Asks `backends` in order with the breaker and timeout rules and fails over to the next one.
  // A verdict other than 404 ends the round, as on the routed paths.
  private async firstAnswer<T>(backends: CardanoBackend[], fn: (b: CardanoBackend) => Promise<T>): Promise<T> {
    const errors: BackendError[] = [];
    for (const backend of backends) {
      try {
        return await this.callWithResilience(backend, () => fn(backend));
      } catch (err: unknown) {
        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        if (isBackendVerdict(backendError) && backendError.statusCode !== 404) throw backendError;
      }
    }
    throw new AllBackendsFailedError(errors);
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

  // The node reports no balance for an account without a pool delegation. A provider then
  // answers in its place; without one the node's answer stands, balance unknown.
  async getAccount(stakeAddress: string): Promise<AccountData> {
    const account = await this.route('getAccount', b => b.getAccount(stakeAddress));
    if (account.withdrawableAmount != null) return account;
    for (const provider of this.historicalBackends) {
      try {
        return await this.callWithResilience(provider, () => provider.getAccount(stakeAddress));
      } catch (err: unknown) {
        logger.debug(`getAccount on ${provider.name} failed, trying the next provider: ${errorText(err)}`);
      }
    }
    return account;
  }

  // The node lists only delegated credentials, so its 404 proves nothing. A provider 404 means not
  // registered. Another ODATANO gives its own verdict; its null, like the node's 404, is a healthy
  // "cannot tell". Null when nobody could tell, and a failure only when nobody answered at all.
  async isRewardAccountRegistered(stakeAddress: string): Promise<boolean | null> {
    await this.ensureInitialized();
    const backends = [this.liveBackend, ...this.historicalBackends].filter((b): b is CardanoBackend => !!b);
    const errors: BackendError[] = [];
    let answered = false;
    let notRegistered = false;
    for (const backend of backends) {
      if (backend.unsupportedMethods?.has('getAccount') && !backend.isRewardAccountRegistered) continue;
      try {
        const verdict = backend.isRewardAccountRegistered
          ? await this.callWithResilience(backend, () => backend.isRewardAccountRegistered!(stakeAddress))
          : (await this.callWithResilience(backend, () => backend.getAccount(stakeAddress))).active;
        answered = true;
        if (verdict !== null) return verdict;
      } catch (err: unknown) {
        const backendError = normalizeBackendError(err, backend.name);
        if (backendError.statusCode !== 404) {
          errors.push(backendError);
          continue;
        }
        answered = true;
        if (backend !== this.liveBackend) notRegistered = true;
      }
    }
    if (notRegistered) return false;
    if (answered) return null;
    throw new AllBackendsFailedError(errors);
  }

  /** Asset info (supply, mint history, CIP-25/CIP-26 metadata); Blockfrost and Koios only. */
  getAssetInfo(unit: string): Promise<AssetInfo> {
    return this.route('getAssetInfo', b => b.getAssetInfo(unit));
  }

  /** Latest mint and burn events. Koios first, because Blockfrost leaves timestamps null. */
  getAssetHistory(unit: string, limit: number = 100): Promise<AssetHistoryEntry[]> {
    const capable = this.capableBackends(b => typeof b.getAssetHistory === 'function', 'koios');
    if (!capable.length) {
      throw new ProviderUnavailableError(
        "getAssetHistory requires Blockfrost or Koios backend.",
        'asset-history'
      );
    }
    return this.firstAnswer(capable, b => b.getAssetHistory!(unit, limit));
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /** Falls back to a full getAddressTransactions when no backend lists hashes only. */
  async getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    const allBackends = this.getOrderedBackends();
    for (const backend of allBackends) {
      if (backend.getAddressTransactionHashes) {
        try {
          return await this.callWithResilience(backend, () => backend.getAddressTransactionHashes!(address, limit));
        } catch (err: unknown) {
          logger.debug(`getAddressTransactionHashes failed on ${backend.name}: ${errorText(err)}, trying next backend`);
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
          logger.debug(`getTransactionsBatch failed on ${backend.name}: ${errorText(err)}, trying next backend`);
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

  // Skips backends whose init failed, because the crawler uses this instance
  // directly, without lazy retry or breaker.
  getChainSyncBackend(): ChainSyncBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isChainSyncBackend(b)) return b;
    }
    return null;
  }

  /** Like getChainSyncBackend() but retries a failed init. The crawler polls it while on pagination. */
  async recoverChainSyncBackend(): Promise<ChainSyncBackend | null> {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (!b || !isChainSyncBackend(b)) continue;
      if (await this.ensureBackendInitialized(b)) return b;
    }
    return null;
  }

  /** First usable backend that can dump the UTxO set at a point, for the UTxO set import. */
  getLedgerStateBackend(): LedgerStateBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isLedgerStateBackend(b)) return b;
    }
    return null;
  }

  // The tip, then whether each reference is unspent, both from the same backend, the node first, so
  // the answers are at least as new as the tip. `live` says it is the node's own ledger; an indexer
  // may lag it. A reference the backend does not know is not unspent.
  async readLedger(refs: Array<{ txHash: string; outputIndex: number }>): Promise<{ live: boolean; tip: number; unspent: boolean[] }> {
    const backends = [this.liveBackend, ...this.historicalBackends].filter((b): b is CardanoBackend => !!b);
    return this.firstAnswer(backends, async (b) => {
      const tip = await b.getCurrentSlot();
      const unspent: boolean[] = [];
      for (const ref of refs) unspent.push(await b.isUtxoUnspent(ref.txHash, ref.outputIndex));
      return { live: b === this.liveBackend, tip, unspent };
    });
  }

  // Outputs among refs that are unspent at the tip, read from the node's ledger.
  // Null when no backend can. The caller then reads the producing tx, which lacks reference-script bytes.
  // With timeout, breaker and failover: the node first, then another ODATANO.
  async getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[] | null> {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    const usable = candidates.filter((b): b is CardanoBackend & OutputLookupBackend =>
      !!b && !this.uninitializedBackends.has(b) && typeof (b as Partial<OutputLookupBackend>).getUnspentOutputs === 'function');
    // a backend with the whole ledger first
    const backends = [...usable.filter(b => isLedgerStateBackend(b)), ...usable.filter(b => !isLedgerStateBackend(b))];
    if (!backends.length) return null;
    return this.firstAnswer(backends, b => (b as CardanoBackend & OutputLookupBackend).getUnspentOutputs(refs));
  }

  /** True when an initialized backend implements `method` and does not declare it unsupported. */
  hasBackendFor(method: string): boolean {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    return candidates.some((b) => !!b
      && !this.uninitializedBackends.has(b)
      && typeof (b as unknown as Record<string, unknown>)[method] === 'function'
      && !b.unsupportedMethods?.has(method));
  }

  /** Backend that reads pool, DRep and pot state at a block. Preferred source of epoch snapshots. */
  getEpochStateBackend(): EpochStateBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isEpochStateBackend(b)) return b;
    }
    return null;
  }

  /** Backend that reads reward accounts at a block, for account snapshots. */
  getRewardAccountStateBackend(): RewardAccountStateBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isRewardAccountStateBackend(b)) return b;
    }
    return null;
  }

  /** Without one, epoch snapshots stay off instead of making thousands of single requests. */
  getEnumeratingBackend(): EnumeratingBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [...this.historicalBackends, this.liveBackend];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isEnumeratingBackend(b)) return b;
    }
    return null;
  }

  /** Backend that lists the CIP-26 token registry (Koios). Null when none is configured. */
  getTokenRegistryBackend(): TokenRegistryBackend | null {
    const candidates: (CardanoBackend | undefined)[] = [...this.historicalBackends, this.liveBackend];
    for (const b of candidates) {
      if (b && !this.uninitializedBackends.has(b) && isTokenRegistryBackend(b)) return b;
    }
    return null;
  }

  /** Prefers Koios, because it batches 100 txs per call and Blockfrost needs about 3 calls per tx. */
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
    if (this.protocolParamsCache && (now - this.protocolParamsCache.fetchedAt) < PROTOCOL_PARAMS_TTL_MS) {
      logger.debug('Returning cached protocol parameters');
      return this.protocolParamsCache.data;
    }

    if (!this.protocolParamsFetchPromise) {
      logger.debug('Fetching fresh protocol parameters');
      this.protocolParamsFetchPromise = this.route('getProtocolParameters', async (b) => {
        const params = await b.getProtocolParameters();
        if (b === this.liveBackend) {
          this.lastLiveProtocolParams = params;
          return params;
        }
        // A fallback answering for the epoch the node last reported: keep the node's values
        const live = this.lastLiveProtocolParams;
        return live && Number(live.epoch) === Number(params.epoch) ? live : params;
      })
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

  // After a lost response, the next backend may answer 409 "already submitted".
  // Callers treat that as success.
  async submitTransaction(signedTxCbor: string): Promise<string> {
    try {
      const hash = await this.route('submitTransaction', b => b.submitTransaction(signedTxCbor));
      this.pendingSpends.record(signedTxCbor);
      return hash;
    } catch (err) {
      // already in the mempool or on chain: its inputs are gone all the same
      if (err instanceof TransactionAlreadySubmittedError) this.pendingSpends.record(signedTxCbor);
      throw err;
    }
  }

  /** True when a configured backend can serve the method. */
  supports(methodName: string): boolean {
    return [this.liveBackend, ...this.historicalBackends].some((b) => !!b && !b.unsupportedMethods?.has(methodName));
  }

  /** True when Ogmios is the live backend. */
  hasOgmiosBackend(): boolean {
    return this.liveBackend?.name === 'ogmios';
  }

  /** The backend that evaluates scripts: the live one (Ogmios), else an evaluating historical one (odatano). */
  private evaluatingBackend(): (CardanoBackend & { evaluateTransaction(cbor: string): Promise<ScriptEvaluationResult[]> }) | null {
    const candidates: (CardanoBackend | undefined)[] = [this.liveBackend, ...this.historicalBackends];
    for (const b of candidates) if (b && isEvaluatingBackend(b)) return b;
    return null;
  }

  /** True when some backend can evaluate script execution units. */
  hasEvaluatingBackend(): boolean {
    return this.evaluatingBackend() != null;
  }

  /** Evaluate script execution units of an unsigned transaction. */
  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    await this.ensureInitialized();

    const backend = this.evaluatingBackend();
    if (!backend) {
      throw new ProviderUnavailableError('Transaction evaluation requires an evaluating backend (Ogmios or odatano)');
    }

    // timeout + breaker, so a hanging socket cannot block Plutus builds
    return this.callWithResilience(backend, () => backend.evaluateTransaction(unsignedTxCbor));
  }
}
