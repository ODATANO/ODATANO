import cds from '@sap/cds';
import http from 'node:http';
import {
  createInteractionContext,
  createTransactionSubmissionClient,
  createLedgerStateQueryClient,
  createChainSynchronizationClient
} from '@cardano-ogmios/client';

import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, NotFoundError, ProviderUnavailableError } from '../../utils/errors';
import { normalizeCostModels } from '../../utils/mappers';
import {
  Transaction,
  BlockData,
  Address,
  UTxO,
  NetworkInformation,
  EpochData,
  MetadataLabelTx,
  PoolData,
  AccountData,
  DrepData,
  AssetInfo,
  LedgerProtocolParameters,
  ScriptEvaluationResult,
  Amount,
  TxInputLine,
  TxOutputLine
} from '../../utils/types';

import { EvaluatingBackend, ChainSyncBackend, ChainSyncCallbacks, ChainSyncHandle, ChainPoint } from './cardano-backend';

import { EPOCH_CONFIG_BY_NETWORK, GENESIS_INFOS_BY_NETWORK } from '../../utils/const';
import { Network } from '../cardano-client';

const logger = cds.log('OgmiosBackend');

/**
 * Type definitions for Ogmios API responses (not fully typed in @cardano-ogmios/client)
 */
interface OgmiosStakePool {
  vrf?: string;
  vrfKeyHash?: string;
  stake?: { ada?: { lovelace?: number | bigint } };
  // Ogmios v6 delivers pledge/cost as ValueAdaOnly ({ada:{lovelace}})
  pledge?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  margin?: number | string;
  cost?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  rewardAccount?: string;
}

interface OgmiosRewardAccountSummary {
  controlledAmount?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  rewards?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  withdrawals?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  delegate?: { id?: string };
  delegation?: { poolId?: string };
  vote?: { id?: string };
  drep?: { id?: string };
}

/**
 * First absolute slot of the given epoch, from the network's Shelley anchor.
 * Replaces the old `epoch * 432000` math, which was wrong on preview (86 400
 * slots per epoch) and on mainnet/preprod (Byron offset).
 */
function epochStartSlot(network: Network, epoch: number): number {
  const cfg = EPOCH_CONFIG_BY_NETWORK[network];
  return cfg.shelleyStartSlot + (epoch - cfg.shelleyStartEpoch) * cfg.slotsPerEpoch;
}

/**
 * Absolute POSIX seconds for a slot, via the same Shelley-anchored genesis infos
 * the transaction builder uses for validity windows. The previous code treated
 * Ogmios' `eraStart.time` (RelativeTime since SYSTEM start) as a Unix timestamp.
 */
function slotToPosixSeconds(network: Network, slot: number): number {
  const genesis = GENESIS_INFOS_BY_NETWORK[network];
  return Math.floor((genesis.systemStartPosixMs + (slot - genesis.startSlotNo) * genesis.slotLengthMs) / 1000);
}

/**
 * Parse an Ogmios `Ratio` ("num/den" string, e.g. "3/1000") into a number.
 * `Number("3/1000")` is NaN — previously every ratio-typed protocol parameter
 * (priceMem, priceStep, a0, rho, tau) came out as NaN.
 */
function parseOgmiosRatio(ratio: string | number | undefined | null): number {
  if (ratio === null || ratio === undefined) return 0;
  if (typeof ratio === 'number') return ratio;
  const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(ratio);
  if (m) {
    const den = Number(m[2]);
    return den === 0 ? 0 : Number(m[1]) / den;
  }
  const n = Number(ratio);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract a lovelace amount from Ogmios' value shapes. Ogmios v6 returns
 * `{ ada: { lovelace } }` objects — calling `.toString()` on those yields
 * "[object Object]", which previously ended up in the AccountData fields.
 */
function ogmiosValueToLovelaceString(value: OgmiosRewardAccountSummary['rewards']): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  const lovelace = value.ada?.lovelace;
  return lovelace === undefined ? '0' : String(lovelace);
}

/** Resolve Ogmios ledger tip which may be 'origin' (genesis block) or a point */
export function resolveOgmiosTip(tip: 'origin' | { slot: number; id: string }): { slot: number; hash: string } {
  return tip === 'origin' ? { slot: 0, hash: '' } : { slot: tip.slot, hash: tip.id };
}

/** Resolve Ogmios block height which may be 'origin' (genesis block) or a number */
export function resolveOgmiosHeight(height: 'origin' | number): number {
  return height === 'origin' ? 0 : height;
}

/**
 * Ogmios Backend Implementation for Cardano Backend Interface
 * Implements the CardanoBackend interface using Ogmios WebSocket client for local node interaction
 */
/**
 * Minimal structural views of the Ogmios chain-sync `BlockPraos` / `Transaction`
 * JSON we consume (Shelley-era onward). Declared locally rather than importing the
 * full `@cardano-ogmios/schema` union so the crawler mapper isn't coupled to a
 * transitive dependency; fields not needed for indexing are omitted.
 */
interface OgmiosChainSyncTx {
  id: string;
  inputs: { transaction: { id: string }; index: number }[];
  outputs: { address: string; value: { ada: { lovelace: number | bigint } } & Record<string, unknown>; datum?: string; datumHash?: string }[];
  fee?: { ada: { lovelace: number | bigint } };
  metadata?: { labels?: Record<string, { json?: unknown; cbor?: string }> };
}
interface OgmiosPraosBlock {
  type: string; // 'praos' | 'ebb' | 'bft' — only 'praos' carries indexable txs
  era: string;
  id: string;
  ancestor: string; // parent block hash (used by the crawler's reorg parent check)
  height: number;
  slot: number;
  size?: { bytes: number };
  issuer?: { verificationKey?: string };
  transactions?: OgmiosChainSyncTx[];
}

export class OgmiosBackend implements EvaluatingBackend, ChainSyncBackend {
  public readonly name = 'ogmios';
  /**
   * Capability declaration — the orchestrator skips Ogmios for these without
   * counting circuit failures. Historic queries are out of protocol scope;
   * getAddress/getNetworkInformation previously FABRICATED placeholder data
   * (type:'base'/isScript:false/stakeAddress:null resp. maxSupply as
   * total/circulating) which preferLive routing then preferred over correct
   * Blockfrost/Koios data.
   */
  public readonly unsupportedMethods: ReadonlySet<string> = new Set([
    // getEpoch is NOT listed: Ogmios can serve the CURRENT epoch and only
    // rejects historic ones — routing prefers historical backends anyway.
    'getBlock',
    'getTransaction',
    'getTransactionMetadata',
    'getAddressTransactions',
    'getDrep',
    'getAssetInfo',
    'getAddress',
    'getNetworkInformation',
  ]);
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: Awaited<ReturnType<typeof createInteractionContext>> | null = null;
  private isShutdown = false;
  private reconnectPromise: Promise<void> | null = null;
  private network: Network;
  private timeoutMs: number;
  private ogmiosUrl: string;


  /** 
   * Constructor 
   */
  constructor(network: Network, timeoutMs: number, ogmiosUrl: string) {
    if (!ogmiosUrl) {
      throw new BackendInitError('ogmios', new Error('ogmiosUrl is not set'));
    }
    this.network = network;
    this.timeoutMs = timeoutMs;
    this.ogmiosUrl = ogmiosUrl;
  }

  /**
   * Force fresh (non-keep-alive) HTTP connections for the Ogmios `/health` probe.
   *
   * createInteractionContext() opens the WebSocket, but FIRST probes
   * `GET http://<ogmios>/health` via the library's `cross-fetch` → node-fetch v2
   * → Node-core `http`. Since Node 19, `http.globalAgent` defaults to
   * keepAlive:true, so node-fetch reuses pooled sockets. Against Ogmios' Warp
   * server on Node 22/24 a reused socket the server has already half-closed
   * yields "Invalid response body … Premature close" the instant the body is
   * read — deterministically (Node 20's older http client tolerated it; `curl`
   * does too, so the /health response itself is well-formed and the node is
   * healthy). The lib pins cross-fetch even in 7.0 and exposes no way to inject
   * an agent into that internal fetch, so we neutralise keep-alive process-wide
   * for `http://`. Blast radius is tiny: the only `http://` consumer is the local
   * Ogmios probe — Blockfrost/Koios run over `https` with their own axios agents
   * and are unaffected. Runs once, lazily, only when Ogmios is actually used.
   */
  private static keepAliveDisabled = false;
  private static disableHttpKeepAlive(): void {
    if (OgmiosBackend.keepAliveDisabled) return;
    http.globalAgent = new http.Agent({ keepAlive: false });
    OgmiosBackend.keepAliveDisabled = true;
  }

  /** Validate Ogmios URL scheme and reject dangerous protocols */
  private static validateOgmiosUrl(rawUrl: string): void {
    const url = new URL(rawUrl);

    // Only allow WebSocket schemes (block file://, http://, etc.)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new BackendInitError('ogmios', new Error(`Invalid Ogmios URL scheme "${url.protocol}" — only ws:// and wss:// are allowed`));
    }

    // In production, block link-local / metadata IPs (SSRF prevention).
    // Private/loopback IPs are allowed since Ogmios typically runs on the local node.
    const host = url.hostname.toLowerCase();
    const dangerousPatterns = [
      /^169\.254\./, // AWS/cloud metadata endpoint range
      /^\[?fe80/     // IPv6 link-local
    ];
    if (dangerousPatterns.some(p => p.test(host))) {
      throw new BackendInitError('ogmios', new Error('Ogmios URL must not point to a link-local or metadata address'));
    }
  }

  /**
   * Bound an init step in time. A hung WebSocket connect/handshake (e.g. the
   * node is alive but too busy catching up to answer) would otherwise block
   * forever — there is no built-in connect timeout — hanging the whole
   * app-context bootstrap (seen as a 6h CI job timeout). On timeout we reject
   * with a message containing "timeout" so the orchestrator's transient-error
   * retry picks it up instead of dying.
   */
  private withInitTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    // Keep this SHORT: the orchestrator retries init a few times within the
    // integration suite's 20s cds.test() hook, so each attempt must be brief.
    // Still bounds a genuinely hung connect in production.
    const ms = Math.min(this.timeoutMs, 4000);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Ogmios init timeout after ${ms}ms (${label})`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Initialize the Ogmios backend connection
   */
  async init(): Promise<boolean> {
    OgmiosBackend.disableHttpKeepAlive();
    OgmiosBackend.validateOgmiosUrl(this.ogmiosUrl);
    const url = new URL(this.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    const context = await this.withInitTimeout(createInteractionContext(
      /* c8 ignore next */
      (err) => logger.error(`[OgmiosBackend] Interaction context error: ${err.message}`),
      () => {
        // Socket closed: clear the clients so the next request reconnects via
        // ensureConnected — previously this handler only logged and the backend
        // stayed dead until process restart.
        if (this.isShutdown) return;
        logger.warn('[OgmiosBackend] WebSocket closed — will reconnect on next request');
        this.stateQueryClient = null;
        this.txSubmissionClient = null;
      },
      { connection }
    ), 'createInteractionContext');

    try {
      this.stateQueryClient = await this.withInitTimeout(createLedgerStateQueryClient(context), 'ledgerStateQueryClient');
      this.txSubmissionClient = await this.withInitTimeout(createTransactionSubmissionClient(context), 'txSubmissionClient');
    } catch (err: unknown) {
      // don't leak the WebSocket when client creation fails mid-init
      // (runtime socket is node `ws`, which exposes terminate())
      try { (context.socket as unknown as { terminate: () => void }).terminate(); } catch { /* best effort */ }
      throw err;
    }
    this.context = context;
    return true;
  }

  /**
   * Reconnect when the WebSocket has died since the last successful init.
   * No-op when never initialized (test-injected clients) — startup-init
   * recovery is the orchestrator's job (lazy init retry in CardanoClient).
   * Concurrent callers share one reconnect attempt.
   */
  private async ensureConnected(): Promise<void> {
    this.ensureNotShutdown();
    if (!this.context) return;
    const socket = this.context.socket as { readyState?: number; OPEN?: number } | undefined;
    const socketOpen = !socket || socket.readyState === (socket.OPEN ?? 1);
    if (this.stateQueryClient && socketOpen) return;

    if (!this.reconnectPromise) {
      logger.warn('[OgmiosBackend] WebSocket not connected — reconnecting');
      this.reconnectPromise = this.init()
        .then(() => undefined)
        .finally(() => { this.reconnectPromise = null; });
    }
    await this.reconnectPromise;
  }

  /** 
   * Get specific Block Data (not supported)
   * @param _hash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(_hash: string): Promise<BlockData> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Block queries not supported', this.name);
    }, this.name);
  }

  /** 
   * Get specific Epoch Data (not supported)
   * @param _epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      // Get current epoch directly via epoch() query
      const currentEpoch = await this.stateQueryClient!.epoch();

      // Ogmios only supports current epoch queries
      if (epochNumber !== currentEpoch) {
        throw new NotFoundError(`Historic Epoch ${epochNumber} not supported (current: ${currentEpoch})`, this.name);
      }

      // Return current epoch data
      return this.getLatestEpoch();
    }, this.name);
  }

  /** 
   * Get specific Transaction Data (not supported)
   * @param _hash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(_hash: string): Promise<Transaction> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction queries not supported', this.name);
    }, this.name);
  }

  /** 
   * Get specific Transaction Metadata (not supported)
   * @param _tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(_tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction metadata not supported', this.name);
    }, this.name);
  }

  /**
   * Get specific Drep Data (not supported for Ogmios)
   * @param _drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  async getDrep(_drepId: string): Promise<DrepData> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('DRep queries not supported by Ogmios backend', this.name);
    }, this.name);
  }

  /**
   * Get Asset Info (not supported for Ogmios — no aggregate-supply query in the protocol)
   * @param _unit asset unit (policyId + assetNameHex)
   * @returns {Promise<AssetInfo>} asset info
   */
  async getAssetInfo(_unit: string): Promise<AssetInfo> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Asset info queries not supported by Ogmios backend', this.name);
    }, this.name);
  }

  /**
   * Get specific Network Information (not supported — Ogmios state queries
   * expose no supply/stake aggregates; the previous implementation fabricated
   * maxSupply as total/circulating, which preferLive routing then preferred
   * over correct Blockfrost/Koios data)
   */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Network information not supported by Ogmios backend — use Blockfrost/Koios', this.name);
    }, this.name);
  }

  /**
   * Get current specific Address Data (not supported — address type, script
   * flag and stake address are not derivable from Ogmios state queries; the
   * previous implementation fabricated type:'base'/isScript:false/
   * stakeAddress:null. UTxOs remain available via getAddressUtxos.)
   */
  async getAddress(_address: string): Promise<Address> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Address detail queries not supported by Ogmios backend — use Blockfrost/Koios', this.name);
    }, this.name);
  }

  /** get current specific Address UTxOs
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} address UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      const utxos = await this.stateQueryClient!.utxo({ addresses: [address] });
      return utxos.map((u: typeof utxos[number]) => {
        // convert Ogmios value format to standard amount array
        const amount = this.convertOgmiosValue(u.value);

        return {
          txHash: u.transaction?.id || '',
          outputIndex: u.index || 0,
          address: u.address || address,
          amount: amount,
          blockHash: '',
          datumHash: u.datumHash,
          // Ogmios delivers the inline datum as CBOR hex in `datum` — it was
          // dropped before, breaking inline-datum spends when Ogmios serves UTxOs
          inlineDatum: typeof u.datum === 'string' ? u.datum : null,
          scriptRef: (u.script as { hash?: string } | undefined)?.hash
        };
      });
    }, this.name);
  }

  /**
   * Get Address Transactions (not supported by Ogmios - use historical backend)
   * Ogmios is a live state query backend and does not provide historical transaction data
   * @param _address bech32 address
   * @returns {Promise<Transaction[]>} always throws - use historical backend instead
   */
  async getAddressTransactions(_address: string): Promise<Transaction[]> {
    throw new NotFoundError(
      'Address transactions not available via Ogmios - use historical backend (Blockfrost/Koios)',
      this.name
    );
  }

  /**
   * Get current specific Pool Data
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
            
      // Query from tip (no acquire needed) with stake included
      const pools = await this.stateQueryClient!.stakePools([{ id: poolId }], true) as Record<string, OgmiosStakePool>;

      // Extract pool from response - stakePools returns object keyed by poolId
      const pool = pools[poolId];
      if (!pool) throw new NotFoundError('Pool', this.name);

      return {
        poolId,
        vrfKeyHash: pool.vrf || pool.vrfKeyHash || '',
        blocksMinted: 0,
        blocksEpoch: 0,
        liveStake: pool.stake?.ada?.lovelace ? String(pool.stake.ada.lovelace) : '0',
        liveSize: 0,
        liveDelegators: 0,
        liveSaturation: 0,
        // activeStake is not available from Ogmios pool params — report 0 instead
        // of fabricating it from the pledge
        activeStake: '0',
        activeSize: 0,
        // pledge/cost are ValueAdaOnly objects in Ogmios v6 — String() on those
        // yielded "[object Object]"; margin is a Ratio string ("1/10")
        pledge: ogmiosValueToLovelaceString(pool.pledge),
        margin: parseOgmiosRatio(pool.margin),
        fixedCost: ogmiosValueToLovelaceString(pool.cost),
        rewardAccount: pool.rewardAccount || ''
      };
    }, this.name);
  }

  /** 
   * Get Account Data for specified stake address
   * @param stakeAddress stake address
   * @returns {Promise<AccountData>} account data
   */
  async getAccount(stakeAddress: string): Promise<AccountData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const rawResult = await this.stateQueryClient!.rewardAccountSummaries({ keys: [stakeAddress] });
      // Ogmios returns a record keyed by stake address; normalize to array
      const summaries: OgmiosRewardAccountSummary[] = Array.isArray(rawResult)
        ? rawResult
        : Object.values(rawResult as Record<string, OgmiosRewardAccountSummary>);

      // Ogmios API returns array of account summaries
      const account = summaries && summaries.length > 0 ? summaries[0] : null;
      
      if (!account) {
        throw new NotFoundError('Account', this.name);
      }

      return {
        stakeaddress: stakeAddress,
        // Ogmios only returns reward-account summaries for REGISTERED stake keys —
        // reaching this point (summary found) therefore implies the account is active.
        active: true,
        activeEpoch: 0,
        controlledAmount: ogmiosValueToLovelaceString(account.controlledAmount),
        rewardsSum: ogmiosValueToLovelaceString(account.rewards),
        withdrawalsSum: ogmiosValueToLovelaceString(account.withdrawals),
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: ogmiosValueToLovelaceString(account.rewards),
        poolId: account.delegate?.id || account.delegation?.poolId || null,
        drepId: account.vote?.id || account.drep?.id || null,
        addresses: []
      };
    }, this.name);
  }

  /**
   * Submit Transaction to the network
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const txHash = await this.txSubmissionClient!.submitTransaction(signedTxCbor);
      return txHash;
    }, this.name);
  }

  /**
   * Evaluate transaction script execution units
   * @param unsignedTxCbor unsigned transaction in CBOR hex format
   * @returns {Promise<ScriptEvaluationResult[]>} evaluation results
   */
  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const results = await this.txSubmissionClient!.evaluateTransaction(unsignedTxCbor);
      return results as ScriptEvaluationResult[];
    }, this.name);
  }

  /** 
   * Get current Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      // Query protocol parameters and epoch in parallel
      const [params, currentEpoch] = await Promise.all([
        this.stateQueryClient!.protocolParameters(),
        this.stateQueryClient!.epoch()
      ]);

      return {
        network: this.network,
        epoch: currentEpoch,
        minUtxo: params.minUtxoDepositCoefficient?.toString() || '0',
        nonce: '',
        costModels: JSON.stringify(normalizeCostModels(params.plutusCostModels || {})),
        minFeeA: params.minFeeCoefficient || 0,
        minFeeB: Number(params.minFeeConstant?.ada?.lovelace || 0),
        maxBlockSize: params.maxBlockBodySize?.bytes || 0,
        priceMem: parseOgmiosRatio(params.scriptExecutionPrices?.memory),
        priceStep: parseOgmiosRatio(params.scriptExecutionPrices?.cpu),
        maxTxExMem: (params.maxExecutionUnitsPerTransaction?.memory || 0).toString(),
        maxTxExSteps: (params.maxExecutionUnitsPerTransaction?.cpu || 0).toString(),
        maxBlockExMem: (params.maxExecutionUnitsPerBlock?.memory || 0).toString(),
        maxBlockExSteps: (params.maxExecutionUnitsPerBlock?.cpu || 0).toString(),
        maxValSize: (params.maxValueSize?.bytes || 0).toString(),
        collateralPercent: params.collateralPercentage || 0,
        maxCollateralInputs: params.maxCollateralInputs || 0,
        coinsPerUtxoSize: params.minUtxoDepositCoefficient?.toString() || '0',
        maxBlockHeaderSize: params.maxBlockHeaderSize?.bytes || 0,
        maxTxSize: params.maxTransactionSize?.bytes || 0,
        keyDeposit: params.stakeCredentialDeposit?.ada?.lovelace?.toString() || '0',
        minPoolCost: params.minStakePoolCost?.ada?.lovelace?.toString() || '0',
        poolDeposit: params.stakePoolDeposit?.ada?.lovelace?.toString() || '0',
        eMax: params.stakePoolRetirementEpochBound || 0,
        nOpt: params.desiredNumberOfStakePools || 0,
        a0: parseOgmiosRatio(params.stakePoolPledgeInfluence),
        // ρ = monetaryExpansion, τ = treasuryExpansion (was swapped; Koios maps it correctly)
        rho: parseOgmiosRatio(params.monetaryExpansion),
        tau: parseOgmiosRatio(params.treasuryExpansion),
        decentralisationParam: 0,
        extraEntropy: null,
        protocolMajorVer: params.version?.major || 0,
        protocolMinorVer: params.version?.minor || 0,
        fetchedAt: new Date().toISOString(),
        source: this.name
      };
    }, this.name);
  }

  /** 
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      const [currentEpoch, tip] = await Promise.all([
        this.stateQueryClient!.epoch(),
        this.stateQueryClient!.ledgerTip()
      ]);

      const { slot } = resolveOgmiosTip(tip);

      // Network-aware epoch geometry + Shelley-anchored slot→time conversion
      const startSlot = epochStartSlot(this.network, currentEpoch);
      const endSlot = startSlot + EPOCH_CONFIG_BY_NETWORK[this.network].slotsPerEpoch;

      return {
        epoch: currentEpoch,
        start_time: slotToPosixSeconds(this.network, startSlot),
        end_time: slotToPosixSeconds(this.network, endSlot),
        first_block_time: slotToPosixSeconds(this.network, startSlot),
        last_block_time: slotToPosixSeconds(this.network, slot),
        block_count: 0, // Not available from Ogmios state queries
        tx_count: 0, // Not available from Ogmios state queries
        output: '0',
        fees: '0',
        active_stake: null,
      };
    }, this.name);
  }

  /** 
   * Get current Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      // Fetch ledger tip, block height and epoch in parallel
      const [tip, blockHeight, epoch] = await Promise.all([
        this.stateQueryClient!.ledgerTip(),
        this.stateQueryClient!.networkBlockHeight(),
        this.stateQueryClient!.epoch()
      ]);

      const { slot, hash } = resolveOgmiosTip(tip);
      const height = resolveOgmiosHeight(blockHeight);

      // network-aware slot-in-epoch (the old `slot % 432000` was wrong on every network)
      const epochSlot = Math.max(0, slot - epochStartSlot(this.network, epoch));

      return {
        time: slotToPosixSeconds(this.network, slot), // seconds (mapBlock expects seconds)
        height,
        hash,
        slot,
        epoch,
        epochSlot,
        slotLeader: '', // Not available via ledgerTip - would need chainSync
        size: 0, // Not available via ledgerTip - would need full block data
        txCount: 0, // Not available via ledgerTip - would need full block data
        fees: '0', // Not available via ledgerTip - would need full block data
      };
    }, this.name);
  }

  /**
   * Get the latest chain tip slot.
   * @returns {Promise<number>} current chain slot
   */
  async getCurrentSlot(): Promise<number> {
    const block = await this.getLatestBlock();
    if (block.slot == null) {
      throw new ProviderUnavailableError(
        `${this.name}: latest block has no slot`,
        this.name,
      );
    }
    return block.slot;
  }

  /**
   * Check whether a UTxO is still unspent via Ogmios `queryLedgerState/utxo`
   * with an outputReferences filter. Empty result means spent or nonexistent.
   * @param txHash 64-char lowercase hex
   * @param outputIndex non-negative integer
   * @returns {Promise<boolean>} true iff the UTxO exists and is unspent
   */
  async isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return false;
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      const result = await this.stateQueryClient!.utxo({
        outputReferences: [{ transaction: { id: txHash }, index: outputIndex }],
      });
      return Array.isArray(result) && result.length > 0;
    }, this.name);
  }

  /**
   * Shutdown the Ogmios Backend
   * Closes all connections and marks as shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    // Terminate the WebSocket and wait for close confirmation
    if (this.context?.socket) {
      // Ogmios's typed `socket` is browser WebSocket, but at runtime it's the
      // node `ws` WebSocket which exposes `once`/`terminate` and readyState consts.
      const socket = this.context.socket as unknown as {
        readyState: number;
        OPEN: number;
        CONNECTING: number;
        once: (event: string, cb: () => void) => void;
        terminate: () => void;
      };
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          timer.unref(); // Don't keep event loop alive for this timeout
          socket.once('close', () => { clearTimeout(timer); resolve(); });
          socket.terminate();
        });
      }
    }

    this.stateQueryClient = null;
    this.txSubmissionClient = null;
    this.context = null;
  }

  /**
   * Check if backend is connected
   */
  isConnected(): boolean {
    if (this.isShutdown || !this.context?.socket) {
      return false;
    }
    const socket = this.context.socket as unknown as { readyState: number; OPEN: number };
    return socket.readyState === socket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure the client is not shutdown before operations
   */
  private ensureNotShutdown(): void {
    if (this.isShutdown) {
      throw new ProviderUnavailableError('Ogmios client has been shutdown', this.name);
    }
  }

  /**
   * Convert Ogmios value format to odatano amount array
   * Ogmios: { ada: { lovelace: 1000000 }, policyId: { assetName: quantity } }
   * Standard: [{ unit: 'lovelace', quantity: '1000000' }, { unit: 'policyId.assetName', quantity: 'N' }]
   */
  private convertOgmiosValue(value: { ada?: { lovelace?: number | bigint } } & Record<string, unknown>): Array<{ unit: string; quantity: string }> {
    const amounts: Array<{ unit: string; quantity: string }> = [];

    // Handle ADA (lovelace)
    if (value.ada?.lovelace) {
      amounts.push({
        unit: 'lovelace',
        quantity: value.ada.lovelace.toString()
      });
    }

    // handle native assets (policy.assetName)
    for (const [policyId, assets] of Object.entries(value)) {
      if (policyId === 'ada') continue;

      for (const [assetName, quantity] of Object.entries(assets as Record<string, number | bigint | string>)) {
        amounts.push({
          unit: `${policyId}${assetName}`,
          quantity: quantity.toString()
        });
      }
    }
    return amounts;
  }

  // ---------------------------------------------------------------------------
  // ChainSyncBackend — streamed forward sync for the chain crawler (v2.0)
  // ---------------------------------------------------------------------------

  /**
   * Open a dedicated chain-synchronization stream. Uses its own InteractionContext
   * (a separate WebSocket) from the query/submission clients, because it is a
   * long-lived stream. `sequential: true` + `inFlight: 1` deliver blocks one at a
   * time in order, which the crawler needs for reorg detection and serial persist.
   *
   * KNOWN LIMITATIONS (documented, to harden against a live node — see CRAWLER_DESIGN.md):
   *  - Input address/amount are left empty: Ogmios chain-sync inputs are bare
   *    references ({txId,index}); the indexer resolves them from already-indexed
   *    outputs (indexBlockFull, C3).
   *  - Per-tx `size` and `deposit` are not surfaced by chain-sync (set 0).
   *  - Output `referenceScriptHash` is not derived from the inline script yet.
   */
  async openChainSync(from: ChainPoint | 'origin', callbacks: ChainSyncCallbacks): Promise<ChainSyncHandle> {
    OgmiosBackend.validateOgmiosUrl(this.ogmiosUrl);
    const url = new URL(this.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    const context = await createInteractionContext(
      /* c8 ignore next */
      (err) => logger.error(`[OgmiosBackend] chain-sync context error: ${err.message}`),
      () => { if (!this.isShutdown) logger.warn('[OgmiosBackend] chain-sync socket closed'); },
      { connection }
    );

    // Both handlers are fully try/caught: the ogmios client lib awaits them with NO
    // catch of its own, and with sequential+inFlight:1 a throw before nextBlock()
    // stalls the stream forever. On error we deliberately do NOT call nextBlock()
    // (stopping deterministically instead of skipping a block) and surface the error
    // via callbacks.onError so the consumer can record it and close/restart.
    const client = await createChainSynchronizationClient(context, {
      rollForward: async ({ block, tip }, nextBlock) => {
        try {
          const b = block as unknown as OgmiosPraosBlock;
          // Byron epoch-boundary (ebb) / bft blocks carry no indexable Praos txs — skip.
          if (b.type !== 'praos') { nextBlock(); return; }
          const mapped = this.mapOgmiosBlock(b);
          const t = tip as { slot?: number; id?: string; height?: number } | 'origin';
          const tipPoint = t && t !== 'origin' && t.slot != null && t.id
            ? { slot: t.slot, hash: t.id, height: t.height }
            : undefined;
          await callbacks.rollForward(mapped.block, mapped.txs, tipPoint);
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollForward failed — stream halted:', err);
          await callbacks.onError?.(err);
        }
      },
      rollBackward: async ({ point }, nextBlock) => {
        try {
          const p = point as { slot: number; id: string } | 'origin';
          await callbacks.rollBackward(p === 'origin' ? 'origin' : { slot: p.slot, hash: p.id });
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollBackward failed — stream halted:', err);
          await callbacks.onError?.(err);
        }
      },
    }, { sequential: true });

    const points = from === 'origin' ? ['origin'] : [{ slot: from.slot, id: from.hash }];
    await client.resume(points as Parameters<typeof client.resume>[0], 1);

    return { close: async () => { await client.shutdown(); } };
  }

  /**
   * Map an Ogmios Praos block into our BlockData + its transactions. Block-level
   * fees are the sum of per-tx fees; epoch/epochSlot are derived from the slot via
   * the network's Shelley anchor (same config the tx-builder uses).
   */
  private mapOgmiosBlock(block: OgmiosPraosBlock): { block: BlockData; txs: Transaction[] } {
    const txs = (block.transactions ?? []).map((t, i) => this.mapOgmiosTx(t, block, i));
    const totalFees = txs.reduce((sum, t) => sum + BigInt(t.fee || 0), 0n);

    const cfg = EPOCH_CONFIG_BY_NETWORK[this.network];
    const epoch = cfg.shelleyStartEpoch + Math.floor((block.slot - cfg.shelleyStartSlot) / cfg.slotsPerEpoch);
    // reuse the Shelley-anchored helper (carries the preview/preprod/Byron-offset fix)
    // instead of a second inline modulo formula
    const epochSlot = block.slot - epochStartSlot(this.network, epoch);

    const blockData: BlockData = {
      time: slotToPosixSeconds(this.network, block.slot),
      height: block.height,
      hash: block.id,
      slot: block.slot,
      slotLeader: block.issuer?.verificationKey ?? '',
      epoch,
      epochSlot,
      size: block.size?.bytes ?? 0,
      txCount: txs.length,
      fees: totalFees.toString(),
    };
    return { block: blockData, txs };
  }

  /**
   * Map a single Ogmios chain-sync transaction into our Transaction. Outputs, fee
   * and metadata are mapped fully; inputs are kept as bare references (address/amount
   * resolved downstream by the indexer). See openChainSync KNOWN LIMITATIONS.
   */
  private mapOgmiosTx(tx: OgmiosChainSyncTx, block: OgmiosPraosBlock, index: number): Transaction {
    const inputs: TxInputLine[] = (tx.inputs ?? []).map(i => ({
      address: '',
      amount: [] as Amount[],
      txHash: i.transaction.id,
      outputIndex: i.index,
    }));

    const outputs: TxOutputLine[] = (tx.outputs ?? []).map((o, i) => ({
      address: o.address,
      amount: this.convertOgmiosValue(o.value),
      txHash: tx.id,
      outputIndex: i,
      dataHash: o.datumHash ?? null,
      inlineDatum: o.datum ?? null,
      isCollateral: false,
      referenceScriptHash: null,
    }));

    const metadataEntries: MetadataLabelTx[] = tx.metadata?.labels
      ? Object.entries(tx.metadata.labels).map(([label, v]) => ({
          txHash: tx.id,
          label,
          json: v.json as MetadataLabelTx['json'],
        }))
      : [];

    return {
      hash: tx.id,
      blockHash: block.id,
      blockHeight: block.height,
      slot: block.slot,
      index,
      fee: (tx.fee?.ada?.lovelace ?? 0).toString(),
      deposit: '0',
      // null = unknown (chain-sync doesn't surface the serialized size) — matches the
      // lazy path's `size ?? null` convention; 0 would masquerade as a real size
      size: null,
      blockTime: slotToPosixSeconds(this.network, block.slot),
      inputs,
      outputs,
      // undefined (not []) when absent — matches the Blockfrost path so
      // mapTransaction's hasMetadata flag stays false for metadata-less txs
      metadata: metadataEntries.length ? metadataEntries : undefined,
    };
  }
}