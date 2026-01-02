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

export class OgmiosBackend implements CardanoBackend {
  public readonly name = 'ogmios';
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: any = null;

  constructor() {
    if (!CONFIG.ogmiosUrl) {
      throw new BackendInitError('ogmios', new Error('CONFIG.ogmiosUrl is not set'));
    }
  }

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

  // ---------------------------------------------------------------------------
  // Network Information @TODO check how to get real supply data
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      
      // Note: Ogmios v6 has limited genesis query support
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

  // ---------------------------------------------------------------------------
  // Block Data
  // ---------------------------------------------------------------------------
  async getBlock(hash: string): Promise<BlockData> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Block queries not supported', this.name);
    }, this.name);
  }

  // ---------------------------------------------------------------------------
  // Epoch Data
  // ---------------------------------------------------------------------------
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      
      try {
        await this.stateQueryClient.acquireLedgerState('origin');
      } catch (error: any) {
        throw new Error(`Cannot acquire ledger state for epoch ${epochNumber}`);
      }
      
      // Get current epoch
      const currentEpoch = await this.stateQueryClient.epoch();
      
      // Check if requested epoch is beyond current epoch
      if (epochNumber > currentEpoch) {
        await this.stateQueryClient.releaseLedgerState();
        throw new NotFoundError(`Epoch ${epochNumber} not available (current epoch: ${currentEpoch})`, this.name);
      }
      
      // Get era summaries to calculate epoch bounds
      const summaries = await this.stateQueryClient.eraSummaries();
      
      await this.stateQueryClient.releaseLedgerState();
      
      // Find the era containing this epoch
      let epochStartTime = 0;
      let epochEndTime = 0;
      
      for (const era of summaries) {
        const eraStartEpoch = era.start.epoch;
        const eraEndEpoch = era.end ? era.end.epoch : currentEpoch;
        
        if (epochNumber >= eraStartEpoch && epochNumber <= eraEndEpoch) {
          // Calculate epoch boundaries within this era
          const epochsIntoEra = epochNumber - eraStartEpoch;
          const epochLength = Number(era.parameters.epochLength); // in slots
          const slotLength = Number(era.parameters.slotLength); // in seconds
          
          epochStartTime = Number(era.start.time.seconds) + (epochsIntoEra * epochLength * slotLength / 1000);
          epochEndTime = epochStartTime + (epochLength * slotLength / 1000);
          break;
        }
      }
      
      if (epochStartTime === 0) {
        throw new NotFoundError(`Epoch ${epochNumber}`, this.name);
      }

      return {
        epoch: epochNumber,
        start_time: epochStartTime,
        end_time: epochEndTime,
        first_block_time: epochStartTime,
        last_block_time: epochEndTime,
        block_count: 0, // Not available via Ogmios
        tx_count: 0, // Not available via Ogmios
        output: '0',
        fees: '0',
        active_stake: '0'
      };
    }, this.name);
  }

  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Transaction queries not supported', this.name);
    }, this.name);
  }

  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Transaction metadata not supported', this.name);
    }, this.name);
  }

  // ---------------------------------------------------------------------------
  // Address
  // ---------------------------------------------------------------------------
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      await this.stateQueryClient.acquireLedgerState('origin');
      const utxos = await this.stateQueryClient.utxo({ addresses: [address] });
      await this.stateQueryClient.releaseLedgerState();
      
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
        utxos: utxos.map((u: any) => ({
          txHash: u.transaction?.id || '',
          outputIndex: u.index || 0,
          address: u.address || address,
          amount: u.value,
          blockHash: '',
          datumHash: u.datumHash,
          scriptRef: u.script?.hash
        }))
      };
    }, this.name);
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      if (!this.stateQueryClient) {
        throw new Error('Ogmios state query client not initialized');
      }
      await this.stateQueryClient.acquireLedgerState('origin');
      const utxos = await this.stateQueryClient.utxo({ addresses: [address] });
      await this.stateQueryClient.releaseLedgerState();
      
      return utxos.map((u: any) => ({
        txHash: u.transaction?.id || '',
        outputIndex: u.index || 0,
        address: u.address || address,
        amount: u.value,
        blockHash: '',
        datumHash: u.datumHash,
        scriptRef: u.script?.hash
      }));
    }, this.name);
  }

  // Pool
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

  // DRep
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(async () => {
      throw new Error('DRep queries not supported');
    }, this.name);
  }

  // Account
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

  async submitTransaction(signedTxCbor: string): Promise<string> {
    console.log("OgmiosBackend: submitting transaction...");
    return handleBackendRequest(async () => {
      if (!this.txSubmissionClient) {
        throw new Error('Ogmios transaction submission client not initialized');
      }
      
      // Ogmios v6 submitTransaction expects just the CBOR string
      const txHash = await this.txSubmissionClient.submitTransaction(signedTxCbor);
      return txHash;
    }, this.name);
  }

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
        epoch: 0, // Not available in params
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
        decentralisationParam: 0, // Deprecated in newer eras
        extraEntropy: null,
        protocolMajorVer: params.version?.major || 0,
        protocolMinorVer: params.version?.minor || 0,
        fetchedAt: new Date().toISOString(),
        source: this.name
      };
    }, this.name);
  }
}