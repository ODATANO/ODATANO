import cds from '@sap/cds';
import {
  createInteractionContext,
  createTransactionSubmissionClient,
  createLedgerStateQueryClient
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
  ScriptEvaluationResult
} from '../../utils/types';

import { EvaluatingBackend } from './cardano-backend';

import { CARDANO_DEFAULTS } from '../../utils/const';
import { Network } from '../cardano-client';

const logger = cds.log('OgmiosBackend');

/**
 * Type definitions for Ogmios API responses (not fully typed in @cardano-ogmios/client)
 */
interface OgmiosStakePool {
  vrf?: string;
  vrfKeyHash?: string;
  stake?: { ada?: { lovelace?: number | bigint } };
  pledge?: number | bigint | string;
  margin?: number;
  cost?: number | bigint | string;
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
export class OgmiosBackend implements EvaluatingBackend {
  public readonly name = 'ogmios';
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: Awaited<ReturnType<typeof createInteractionContext>> | null = null;
  private isShutdown = false;
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
   * Initialize the Ogmios backend connection
   */
  async init(): Promise<boolean> {
    OgmiosBackend.validateOgmiosUrl(this.ogmiosUrl);
    const url = new URL(this.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    
    this.context = await createInteractionContext(
      /* c8 ignore next */
      (err) => logger.error(`[OgmiosBackend] Interaction context error: ${err.message}`),
      (err) => { logger.error(`[OgmiosBackend] Connection error: ${err}`); },
      { connection }
    );

    this.stateQueryClient = await createLedgerStateQueryClient(this.context);
    this.txSubmissionClient = await createTransactionSubmissionClient(this.context);
    return true;
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
      this.ensureNotShutdown();
      
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
   * Get specific Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(async () => {
      const maxSupply = CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY;

      return {
        supply: {
          max: maxSupply.toString(),
          total: maxSupply.toString(),
          circulating: maxSupply.toString(),
          locked: '0',
          treasury: '0',
          reserves: '0'
        },
        stake: {
          active: '0',
          live: '0',
        }
      };
    }, this.name);
  }

  /**
   * Get current specific Address Data
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(async () => {
      this.ensureNotShutdown();
      
      // Query UTxOs from tip (no acquire needed - queries from tip by default)
      const utxos = await this.stateQueryClient!.utxo({ addresses: [address] });
      type OgmiosUtxoEntry = typeof utxos[number];

      const totalLovelace = utxos.reduce((sum: bigint, u: OgmiosUtxoEntry) => {
        const lovelace = u.value?.ada?.lovelace;
        return sum + BigInt(lovelace);
      }, 0n);

      return {
        address,
        stakeAddress: null,
        type: 'base',
        isScript: false,
        amount: [{
          unit: 'lovelace',
          quantity: totalLovelace.toString()
        }],
        utxos: utxos.map((u: OgmiosUtxoEntry) => {
          const amount = this.convertOgmiosValue(u.value);
          return {
            txHash: u.transaction?.id || '',
            outputIndex: u.index || 0,
            address: u.address || address,
            amount: amount,
            blockHash: '',
            datumHash: u.datumHash,
            scriptRef: (u.script as { hash?: string } | undefined)?.hash
          };
        }),
        transactions: []  // Historic transaction queries not supported
      };
    }, this.name);
  }

  /** get current specific Address UTxOs
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} address UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      this.ensureNotShutdown();
      
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
      this.ensureNotShutdown();
            
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
        activeStake: pool.pledge ? String(pool.pledge) : '0',
        activeSize: 0,
        pledge: pool.pledge ? String(pool.pledge) : '0',
        margin: Number(pool.margin || 0),
        fixedCost: pool.cost ? String(pool.cost) : '0',
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
      this.ensureNotShutdown();

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
        active: true,
        activeEpoch: 0,
        controlledAmount: account.controlledAmount?.toString() || '0',
        rewardsSum: account.rewards?.toString() || '0',
        withdrawalsSum: account.withdrawals?.toString() || '0',
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: account.rewards?.toString() || '0',
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
      this.ensureNotShutdown();

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
      this.ensureNotShutdown();

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
      this.ensureNotShutdown();
      
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
        priceMem: Number(params.scriptExecutionPrices?.memory || 0),
        priceStep: Number(params.scriptExecutionPrices?.cpu || 0),
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
        a0: Number(params.stakePoolPledgeInfluence || 0),
        rho: Number(params.treasuryExpansion || 0),
        tau: Number(params.monetaryExpansion || 0),
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
      this.ensureNotShutdown();
      
      // Query epoch and era start in parallel for accurate data
      const [currentEpoch, eraStart, tip] = await Promise.all([
        this.stateQueryClient!.epoch(),
        this.stateQueryClient!.eraStart(),
        this.stateQueryClient!.ledgerTip()
      ]);
      
      const { slot } = resolveOgmiosTip(tip);

      // Calculate epoch boundaries using era start as reference
      const SLOTS_PER_EPOCH = CARDANO_DEFAULTS.SLOTS_PER_EPOCH;
      const epochStartSlot = currentEpoch * SLOTS_PER_EPOCH;
      const epochEndSlot = (currentEpoch + 1) * SLOTS_PER_EPOCH;

      // eraStart.time is RelativeTime { seconds: bigint }
      const eraStartTime = Number(eraStart.time.seconds) * 1000;
      const slotsSinceEraStart = slot - eraStart.slot;
      const currentTime = eraStartTime + (slotsSinceEraStart * 1000);
      
      const slotsSinceEpochStart = slot - epochStartSlot;
      const epochStartTime = currentTime - (slotsSinceEpochStart * 1000);
      const slotsUntilEpochEnd = epochEndSlot - slot;
      const epochEndTime = currentTime + (slotsUntilEpochEnd * 1000);

      return {
        epoch: currentEpoch,
        start_time: Math.floor(epochStartTime / 1000),
        end_time: Math.floor(epochEndTime / 1000),
        first_block_time: Math.floor(epochStartTime / 1000),
        last_block_time: Math.floor(currentTime / 1000),
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
      this.ensureNotShutdown();
      
      // Fetch ledger tip, block height, epoch, and era start in parallel
      const [tip, blockHeight, epoch, eraStart] = await Promise.all([
        this.stateQueryClient!.ledgerTip(),
        this.stateQueryClient!.networkBlockHeight(),
        this.stateQueryClient!.epoch(),
        this.stateQueryClient!.eraStart()
      ]);

      const { slot, hash } = resolveOgmiosTip(tip);
      const height = resolveOgmiosHeight(blockHeight);

      // eraStart.time is RelativeTime { seconds: bigint }
      const eraStartTime = Number(eraStart.time.seconds) * 1000;
      const slotsSinceEraStart = slot - eraStart.slot;
      const blockTime = eraStartTime + (slotsSinceEraStart * 1000); // Each slot = 1 second

      // Calculate slot within epoch
      const epochSlot = slot % CARDANO_DEFAULTS.SLOTS_PER_EPOCH;

      return {
        time: Math.floor(blockTime / 1000), // Convert ms to seconds (mapBlock expects seconds)
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
      this.ensureNotShutdown();
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
}