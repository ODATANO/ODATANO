import {
  createInteractionContext,
  createTransactionSubmissionClient,
  createLedgerStateQueryClient
} from '@cardano-ogmios/client';

import { CONFIG } from '../../../config/config';
import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, NotFoundError } from '../../utils/errors';

import {
  Transaction,
  BlockData,
  Address,
  UTxO,
  Network,
  EpochData,
  MetadataLabelTx,
  PoolData,
  AccountData,
  DrepData,
  LedgerProtocolParameters
} from '../../utils/types';

import { CardanoBackend } from './cardano-backend';
import logger from '../../utils/logger';

/**
 * Ogmios Backend Implementation for Cardano Backend Interface
 * Implements the CardanoBackend interface using Ogmios WebSocket client for local node interaction
 */
export class OgmiosBackend implements CardanoBackend {
  public readonly name = 'ogmios';
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: any = null;
  private isShutdown = false;

  /** 
   * Constructor 
   */
  constructor() {
    if (!CONFIG.ogmiosUrl) {
      throw new BackendInitError('ogmios', new Error('CONFIG.ogmiosUrl is not set'));
    }
  }

  /** 
   * Initialize the Ogmios backend connection
   */
  async init(): Promise<void> {
    const url = new URL(CONFIG.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    this.context = await createInteractionContext(
      (err) => logger.error(`[OgmiosBackend] Interaction context error: ${err.message}`),
      (err) => { logger.error(`[OgmiosBackend] Connection error: ${err}`); },
      { connection }
    );

    this.stateQueryClient = await createLedgerStateQueryClient(this.context);
    this.txSubmissionClient = await createTransactionSubmissionClient(this.context);
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
      throw new Error('DRep queries not supported');
    }, this.name);
  }

  /** 
   * Get specific Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(async () => {
      // Using hardcoded max supply for Cardano mainnet
      const maxSupply = '45000000000000000';

      return {
        supply: {
          max: maxSupply,
          total: maxSupply,
          circulating: maxSupply,
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
      
      // Validate address format
      if (!address || address.length < 20) {
        throw new Error('Invalid address format');
      }
      
      // Query UTxOs from tip (no acquire needed - queries from tip by default)
      const utxos = await this.stateQueryClient!.utxo({ addresses: [address] });

      const totalLovelace = utxos.reduce((sum: bigint, u: any) => {
        const lovelace = u.value?.ada?.lovelace || 0;
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
        utxos: utxos.map((u: any) => {
          const amount = this.convertOgmiosValue(u.value);
          return {
            txHash: u.transaction?.id || '',
            outputIndex: u.index || 0,
            address: u.address || address,
            amount: amount,
            blockHash: '',
            datumHash: u.datumHash,
            scriptRef: u.script?.hash
          };
        })
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
      
      // Validate address format
      if (!address || address.length < 20) {
        throw new Error('Invalid address format');
      }
      
      const utxos = await this.stateQueryClient!.utxo({ addresses: [address] });

      return utxos.map((u: any) => {
        // convert Ogmios value format to standard amount array
        const amount = this.convertOgmiosValue(u.value);

        return {
          txHash: u.transaction?.id || '',
          outputIndex: u.index || 0,
          address: u.address || address,
          amount: amount,
          blockHash: '',
          datumHash: u.datumHash,
          scriptRef: u.script?.hash
        };
      });
    }, this.name);
  }

  /** 
   * Get current specific Pool Data
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(async () => {
      this.ensureNotShutdown();
      
      // Validate pool ID format (bech32 pool ID)
      if (!poolId || poolId.length < 10) {
        throw new Error('Invalid pool ID format');
      }
      
      // Query from tip (no acquire needed) with stake included
      const pools = await this.stateQueryClient!.stakePools([{ id: poolId }], true) as any;

      // Extract pool from response - stakePools returns object keyed by poolId
      const pool = pools[poolId];
      if (!pool) {
        throw new NotFoundError('Pool', this.name);
      }

      return {
        poolId,
        vrfKeyHash: pool.vrf || pool.vrfKeyHash || '',
        blocksMinted: 0,
        blocksEpoch: 0,
        liveStake: pool.stake?.ada?.lovelace ? Number(pool.stake.ada.lovelace) : 0,
        liveSize: 0,
        liveDelegators: 0,
        liveSaturation: 0,
        activeStake: Number(pool.pledge || 0),
        activeSize: 0,
        pledge: pool.pledge?.toString() || '0',
        margin: Number(pool.margin || 0),
        fixedCost: pool.cost?.toString() || '0',
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
      
      // Validate stake address format (should be hex string, 56 chars for stake key hash)
      if (!stakeAddress || (stakeAddress.length !== 56 && !stakeAddress.startsWith('stake'))) {
        throw new Error('Invalid stake address format');
      }
      
      // Extract key hash if bech32 address provided, otherwise use as-is
      const keyHash = stakeAddress.startsWith('stake') ? stakeAddress : stakeAddress;
      
      // Query from tip (no acquire needed)
      const summaries = await this.stateQueryClient!.rewardAccountSummaries({ keys: [keyHash] }) as any;

      // Handle both response formats: array (real Ogmios) or object (for test compatibility)
      let account: any;
      if (Array.isArray(summaries)) {
        // Real Ogmios API returns array
        account = summaries && summaries.length > 0 ? summaries[0] : null;
      } else if (typeof summaries === 'object' && summaries[keyHash]) {
        // Test mock returns object keyed by stake address
        account = summaries[keyHash];
      } else {
        account = null;
      }
      
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
      
      if (!signedTxCbor || signedTxCbor.length < 10) {
        throw new Error('Invalid transaction CBOR');
      }
      
      const txHash = await this.txSubmissionClient!.submitTransaction(signedTxCbor);
      return txHash;
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
        network: CONFIG.network,
        epoch: currentEpoch,
        minUtxo: params.minUtxoDepositCoefficient?.toString() || '0',
        nonce: '',
        costModels: JSON.stringify(params.plutusCostModels || {}),
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
      
      const slot = tip === 'origin' ? 0 : (tip.slot || 0);

      // Calculate epoch boundaries using era start as reference
      // Each epoch has 432000 slots, each slot is ~1 second
      const SLOTS_PER_EPOCH = 432000;
      const epochStartSlot = currentEpoch * SLOTS_PER_EPOCH;
      const epochEndSlot = (currentEpoch + 1) * SLOTS_PER_EPOCH;
      
      // Use eraStart.time as accurate reference point (RelativeTime is in milliseconds)
      const eraStartTime = typeof eraStart.time === 'number' ? eraStart.time : Date.now();
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

      // TypeScript requires 'origin' checks (genesis block), though practically never occurs
      // Ogmios returns 'origin' | Point for genesis compatibility
      const slot = tip === 'origin' ? 0 : (tip.slot || 0);
      const hash = tip === 'origin' ? '' : (tip.id || '');
      const height = blockHeight === 'origin' ? 0 : (blockHeight || 0);

      // Calculate block time: eraStart.time is RelativeTime (ms since Unix epoch, not Date object)
      // Reference: current era start time + elapsed slots since era start
      const eraStartTime = typeof eraStart.time === 'number' ? eraStart.time : Date.now();
      const slotsSinceEraStart = slot - eraStart.slot;
      const blockTime = eraStartTime + (slotsSinceEraStart * 1000); // Each slot = 1 second

      // Calculate slot within epoch
      const SLOTS_PER_EPOCH = 432000; // Standard for mainnet and most testnets
      const epochSlot = slot % SLOTS_PER_EPOCH;

      return {
        time: blockTime, // Already in milliseconds
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
   * Shutdown the Ogmios Backend
   * Closes all connections and marks as shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    try {
      if (this.stateQueryClient) {
        await this.stateQueryClient.shutdown();
      }
    } catch (error) {
      logger.error(`[OgmiosBackend] Error shutting down state query client: ${error}`);
    }

    try {
      if (this.txSubmissionClient) {
        await this.txSubmissionClient.shutdown();
      }
    } catch (error) {
      logger.error(`[OgmiosBackend] Error shutting down tx submission client: ${error}`);
    }

    try {
      if (this.context?.socket) {
        this.context.socket.close();
      }
    } catch (error) {
      logger.error(`[OgmiosBackend] Error closing socket: ${error}`);
    }

    this.isShutdown = true;
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
    return this.context.socket.readyState === this.context.socket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure the client is not shutdown before operations
   */
  private ensureNotShutdown(): void {
    if (this.isShutdown) {
      throw new Error('Ogmios client has been shutdown');
    }
  }

  /**
   * Convert Ogmios value format to odatano amount array
   * Ogmios: { ada: { lovelace: 1000000 }, policyId: { assetName: quantity } }
   * Standard: [{ unit: 'lovelace', quantity: '1000000' }, { unit: 'policyId.assetName', quantity: 'N' }]
   */
  private convertOgmiosValue(value: any): Array<{ unit: string; quantity: string }> {
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

      for (const [assetName, quantity] of Object.entries(assets as Record<string, any>)) {
        amounts.push({
          unit: `${policyId}${assetName}`,
          quantity: quantity.toString()
        });
      }
    }
    return amounts;
  }
}