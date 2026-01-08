import { CardanoBackend } from './cardano-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
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
  JSONValue,
  MetadataLabelTx,
  PoolData,
  AccountData,
  DrepData,
  LedgerProtocolParameters 
} from '../../utils/types';

/**
 * BlockfrostBackend Implementation for CardanoBackend Interface
 * Implements the CardanoBackend interface using Blockfrost API SDK
 */
export class BlockfrostBackend implements CardanoBackend {
  public readonly name = 'blockfrost';
  private api: BlockFrostAPI;
  
  /** 
   * Constructor
   */
  constructor() {
  const projectId = CONFIG.blockfrostApiKey;
  if (!projectId) {
      throw new BackendInitError('blockfrost', new Error('CONFIG.blockfrostApiKey is not set'));
  }
  this.api = new BlockFrostAPI({ projectId });
  }
  
   /** 
    * Initialize the backend 
    */
  async init(): Promise<void> { }

  /** 
   * Get Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(
      async () => {
        const networkInfo = await this.api.network();
        return {
          supply: networkInfo.supply,
          stake: networkInfo.stake,
        };
      },
      this.name
    );
  }

  /** 
   * Get Block Data
   * @param blockHash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(blockHash: string): Promise<BlockData> {
     return handleBackendRequest(
      async () => {
        const blockdata = await this.api.blocks(blockHash);
        return {
          time: blockdata.time,
          height: blockdata.height,
          hash: blockdata.hash,
          slot: blockdata.slot,
          slotLeader: blockdata.slot_leader,
          epoch: blockdata.epoch,
          epochSlot: blockdata.epoch_slot,
          size: blockdata.size,
          txCount: blockdata.tx_count,
          fees: blockdata.fees,
        };
      },
      this.name
    );
  }

  /** 
   * Get Epoch Data
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
   async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const epochData = await this.api.epochs(epochNumber);
        return {
          epoch: epochData.epoch,
          start_time: epochData.start_time,
          end_time: epochData.end_time,
          first_block_time: epochData.first_block_time,
          last_block_time: epochData.last_block_time,
          block_count: epochData.block_count,
          tx_count: epochData.tx_count,
          output: epochData.output,
          fees: epochData.fees,
          active_stake: epochData.active_stake,
        };
      },
      this.name
    );
  }

  /** 
   * Get Transaction Data
   * @param hash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        const tx = await this.api.txs(hash);
        const txUtxos = await this.api.txsUtxos(hash);
        const txMetadata = await this.api.txsMetadata(hash);

        const metadata = txMetadata.length > 0 ? txMetadata.map(md => ({
          txHash: hash,
          label: md.label,
          json: md.json_metadata as JSONValue | null,
        })) : undefined;

        return {
          hash: tx.hash,
          blockHash:  tx.block,
          blockHeight: tx.block_height,
          blockTime : tx.block_time,
          slot: tx.slot,
          index: tx.index,
          fee: parseInt(tx.fees, 10),
          deposit: parseInt(tx.deposit, 10),
          size: tx.size,
          inputs: txUtxos.inputs.map(input => ({
            address: input.address,
            txHash: input.tx_hash,
            outputIndex: input.output_index,
            amount: input.amount,
            dataHash: input.data_hash,
            inlineDatum: input.inline_datum,
            referenceScriptHash: input.reference_script_hash,
            collateral: input.collateral,
            reference: input.reference,
          })),
          outputs: txUtxos.outputs.map(output => ({
            address: output.address,
            amount: output.amount,
            txHash: tx.hash,
            outputIndex: output.output_index,
            dataHash: output.data_hash,
            inlineDatum: output.inline_datum,
            isCollateral: output.collateral,
            referenceScriptHash: output.reference_script_hash,
          })),
          metadata: metadata,
        };
      },
      this.name
    );
  }
  
  /**
   * Get Transaction Metadata
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const txMetadata = await this.api.txsMetadata(tx_hash);
        
        if (txMetadata.length === 0 || txMetadata === null) {
          throw new NotFoundError('Transaction metadata', this.name);
        }

        return txMetadata.map(md => ({
          txHash: tx_hash,
          label: md.label,
          json: md.json_metadata as JSONValue | null,
        }));
      },
      this.name
    );
  }

/** 
 * Get Address Data
 * @param address bech32 address string
 * @returns {Promise<Address>} address data
 */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(
      async () => {
        const address_data = await this.api.addresses(address);
        const address_utxos = await this.api.addressesUtxos(address);

        return {
          address: address_data.address,
          stakeAddress: address_data.stake_address,
          type: address_data.type,
          isScript: address_data.script,
          amount: address_data.amount,
          utxos: address_utxos.map(utxo => ({
            txHash: utxo.tx_hash,
            outputIndex: utxo.output_index,
            address: utxo.address,
            amount: utxo.amount,
            blockHash: utxo.block,
            datumHash: utxo.data_hash,
            scriptRef: utxo.reference_script_hash,
          })),
        };
      },
      this.name
    );
  }

  /** 
   * Get Address UTxOs
   * @param address bech32 address string
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        const utxo_data = await this.api.addressesUtxos(address);
        return utxo_data.map(utxo => ({
          txHash: utxo.tx_hash,
          outputIndex: utxo.output_index,
          address: utxo.address,
          amount: utxo.amount,
          blockHash: utxo.block,
          datumHash: utxo.data_hash,
          scriptRef: utxo.reference_script_hash,
        }));
      },
      this.name
    );
  }

  /** 
   * Get Pool Data
   * @param poolId stake pool id (hex)
   * @return {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
   return handleBackendRequest(
      async () => {
        const poolData = await this.api.poolsById(poolId);
        return {
          poolId: poolData.pool_id,
          vrfKeyHash: poolData.vrf_key,
          blocksMinted: poolData.blocks_minted,
          blocksEpoch: poolData.blocks_epoch,
          liveStake: parseInt(poolData.live_stake || '0', 10),
          liveSize: poolData.live_size,
          liveDelegators: poolData.live_delegators,
          liveSaturation: poolData.live_saturation,
          activeStake: parseInt(poolData.active_stake || '0', 10),
          activeSize: poolData.active_size,
          pledge: parseInt(poolData.live_pledge || '0', 10),
          margin: poolData.margin_cost,
          fixedCost: parseInt(poolData.fixed_cost || '0', 10), 
          rewardAccount: poolData.reward_account,
        }
      },
      this.name
    ); 
  }

  /**
   * Get Drep Data
   * @param drepId drep id (bech32)
   * @return {Promise<DrepData>} drep data
   */
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(
      async () => {
        const drepData = await this.api.governance.drepsById(drepId);
        
        return {
          drepId: drepData.drep_id,
          hex: drepData.hex,
          amount: drepData.amount,
          hasScript: drepData.has_script,
          lastActiveEpoch: drepData.last_active_epoch ?? 0,
          expired: drepData.expired,    
          retired: drepData.retired,  
        };    
      },
      this.name
    );
  }

  /** 
   * Get Account Data
   * @param stakeAddress bech32 stake address
   * @return {Promise<AccountData>} account data
   */
  async getAccount(stakeAddress: string): Promise<AccountData> {
    return handleBackendRequest(
      async () => {
        const accountData = await this.api.accounts(stakeAddress);
        const addressData = await this.api.accountsAddresses(stakeAddress);
        const addresses = await Promise.all(
          addressData.map(address => this.getAddress(address.address))
        );
        return {
          stakeaddress: accountData.stake_address,
          active: accountData.active,
          activeEpoch: accountData.active_epoch ?? 0,
          controlledAmount: accountData.controlled_amount,
          rewardsSum:  accountData.rewards_sum,
          withdrawalsSum: accountData.withdrawals_sum,
          reservesSum: accountData.reserves_sum,
          treasurySum: accountData.treasury_sum,
          withdrawableAmount: accountData.withdrawable_amount,
          poolId: accountData.pool_id,
          drepId : accountData.drep_id ?? null,
          addresses: addresses,
        };
      },
      this.name
    );
  }

  /** 
   * Submit Transaction
   * @param signedTxCbor hex-encoded signed transaction CBOR
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    console.log("BlockfrostBackend: submitting transaction...");
    const txBytes = Buffer.from(signedTxCbor, "hex");
    return handleBackendRequest(
      async () => {
        const txHash = await this.api.txSubmit(txBytes);
        return txHash;
      },
      this.name
    );
  }

  /** 
   * Get Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(
      async () => {
        const protocolParams = await this.api.epochsLatestParameters();
        return {
          network: CONFIG.network,
          epoch: protocolParams.epoch,
          minUtxo: protocolParams.min_utxo,
          nonce: protocolParams.nonce,
          costModels: JSON.stringify(protocolParams.cost_models),
          minFeeA: protocolParams.min_fee_a,
          minFeeB: protocolParams.min_fee_b,
          maxBlockSize: protocolParams.max_block_size,
          priceMem: protocolParams.price_mem,
          priceStep: protocolParams.price_step,
          maxTxExMem: protocolParams.max_tx_ex_mem,
          maxTxExSteps: protocolParams.max_tx_ex_steps,
          maxBlockExMem: protocolParams.max_block_ex_mem,
          maxBlockExSteps: protocolParams.max_block_ex_steps,
          maxValSize: protocolParams.max_val_size,
          collateralPercent: protocolParams.collateral_percent,
          maxCollateralInputs: protocolParams.max_collateral_inputs,
          coinsPerUtxoSize: protocolParams.coins_per_utxo_size,
          maxBlockHeaderSize: protocolParams.max_block_header_size,
          maxTxSize: protocolParams.max_tx_size,
          keyDeposit: protocolParams.key_deposit,
          minPoolCost: protocolParams.min_pool_cost,
          poolDeposit: protocolParams.pool_deposit,
          eMax: protocolParams.e_max,
          nOpt: protocolParams.n_opt,
          a0: protocolParams.a0,
          rho: protocolParams.rho,
          tau: protocolParams.tau,
          decentralisationParam: protocolParams.decentralisation_param,
          extraEntropy: protocolParams.extra_entropy,
          protocolMajorVer: protocolParams.protocol_major_ver,
          protocolMinorVer: protocolParams.protocol_minor_ver,
          fetchedAt: new Date().toISOString(),
          source: this.name,

        };
      },
      this.name
    );
  }

  /** 
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const epochData = await this.api.epochsLatest();
        return {
          epoch: epochData.epoch,
          start_time: epochData.start_time,
          end_time: epochData.end_time,
          first_block_time: epochData.first_block_time,
          last_block_time: epochData.last_block_time,
          block_count: epochData.block_count,
          tx_count: epochData.tx_count,
          output: epochData.output,
          fees: epochData.fees,
          active_stake: epochData.active_stake,
        };
      },
      this.name
    );
  }

  /** 
   * Get Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
     return handleBackendRequest(
      async () => {
        const blockdata = await this.api.blocksLatest();
        return {
          time: blockdata.time,
          height: blockdata.height,
          hash: blockdata.hash,
          slot: blockdata.slot,
          slotLeader: blockdata.slot_leader,
          epoch: blockdata.epoch,
          epochSlot: blockdata.epoch_slot,
          size: blockdata.size,
          txCount: blockdata.tx_count,
          fees: blockdata.fees,
        };
      },
      this.name
    );
  }
}