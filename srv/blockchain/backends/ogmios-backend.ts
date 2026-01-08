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

/**
 * Ogmios Backend Implementation for Cardano Backend Interface
 * Implements the CardanoBackend interface using Ogmios WebSocket client for local node interaction
 */
export class OgmiosBackend implements CardanoBackend {
  public readonly name = 'ogmios';
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: any = null;
  
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
    const url = new URL(CONFIG.ogmiosUrl || 'ws://localhost:1337');
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    this.context = await createInteractionContext(
      (err) => console.error('[Ogmios] Error:', err),
      () => console.log('[Ogmios] Closed'),
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
  async getEpoch(_epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Epoch queries not supported', this.name);
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
  * Get specific Pool Data (not supported for Ogmios)
  * @param _poolId pool id
  * @returns {Promise<PoolData>} pool data
  */
  async getDrep(_drepId: string): Promise<DrepData> {
    return handleBackendRequest(async () => {
      throw new Error('DRep queries not supported');
    }, this.name);
  }

 /** 
  * Get specific Account Data (not supported for Ogmios)
  * @returns {Promise<Network>} network information
  */
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
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
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      
      // Query UTxOs without acquiring specific ledger state
      const utxos = await this.stateQueryClient.utxo({ addresses: [address] });
      
      const totalLovelace = utxos.reduce((sum: bigint, u: any) => {
        const lovelace = u.value?.ada?.lovelace || u.value?.lovelace || '0';
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
      
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      
      const utxos = await this.stateQueryClient.utxo({ addresses: [address] });
      
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
   * Get current specific Pool Data (not supported for Ogmios)
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      await this.stateQueryClient.acquireLedgerState('origin');
      const pools = await this.stateQueryClient.stakePools([{ id: poolId }]) as any;
      await this.stateQueryClient.releaseLedgerState();
      
      const pool = Array.isArray(pools) && pools.length > 0 ? pools[0] : pools;
      if (!pool) throw new NotFoundError('Pool', this.name);

      return {
        poolId,
        vrfKeyHash: pool.vrf || pool.vrfKeyHash || '',
        blocksMinted: 0,
        blocksEpoch: 0,
        liveStake: 0,
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
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      await this.stateQueryClient.acquireLedgerState('origin');
      const state = await this.stateQueryClient.rewardAccountSummaries({ keys: [stakeAddress] }) as any;
      await this.stateQueryClient.releaseLedgerState();
      
      const account = state ? state[stakeAddress] : null;
      if (!account) throw new NotFoundError('Account', this.name);

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
        poolId: account.delegation?.poolId || null,
        drepId: account.drep?.id || null,
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
    console.log("OgmiosBackend: submitting transaction...");
    return handleBackendRequest(async () => {
      if (!this.txSubmissionClient) {
        throw new Error('Ogmios transaction submission client not initialized');
      }

      const txHash = await this.txSubmissionClient.submitTransaction(signedTxCbor);
      return txHash;
    }, this.name);
  }

  /** 
   * Get current Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      await this.stateQueryClient.acquireLedgerState('origin');
      const params = await this.stateQueryClient.protocolParameters();
      await this.stateQueryClient.releaseLedgerState();

      return {
        network: CONFIG.network,
        epoch: 0, // not available in params
        minUtxo: params.minUtxoDepositCoefficient?.toString(),
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
        coinsPerUtxoSize: params.minUtxoDepositCoefficient?.toString(),
        maxBlockHeaderSize: params.maxBlockHeaderSize?.bytes || 0,
        maxTxSize: params.maxTransactionSize?.bytes || 0,
        keyDeposit: params.stakeCredentialDeposit?.ada?.lovelace?.toString(),
        minPoolCost: params.minStakePoolCost?.ada?.lovelace?.toString(),
        poolDeposit: params.stakePoolDeposit?.ada?.lovelace?.toString(),
        eMax: params.stakePoolRetirementEpochBound || 0,
        nOpt: params.desiredNumberOfStakePools || 0,
        a0: Number(params.stakePoolPledgeInfluence || 0),
        rho: Number(params.treasuryExpansion || 0),
        tau: Number(params.monetaryExpansion || 0),
        decentralisationParam: 0, // deprecated?! check
        extraEntropy: null,
        protocolMajorVer: params.version?.major || 0,
        protocolMinorVer: params.version?.minor || 0,
        fetchedAt: new Date().toISOString(),
        source: this.name
      };
    }, this.name);
  }

  /** 
   * Get current Latest Epoch Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestEpoch(): Promise<EpochData> {
    throw new Error('Method not implemented.');
  }

  /** 
   * Get current Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    throw new Error('Method not implemented.');
  }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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