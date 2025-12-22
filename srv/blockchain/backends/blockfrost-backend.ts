import { CardanoBackend } from './cardano-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { CONFIG } from '../../../config/config';
import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError } from '../../utils/errors';

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
} from '../../utils/types';


// ---------------------------------------------------------------------------
// Blockfrost Backend Implementation
// ---------------------------------------------------------------------------
export class BlockfrostBackend implements CardanoBackend {
  public readonly name = 'blockfrost';
  private api: BlockFrostAPI;

constructor() {
  const projectId = CONFIG.blockfrostApiKey;
  if (!projectId) {
      throw new BackendInitError('blockfrost', new Error('CONFIG.blockfrostApiKey is not set'));
  }

  this.api = new BlockFrostAPI({ projectId });
}
  
  async init(): Promise<void> { }

  // ---------------------------------------------------------------------------
  // Network Information
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(
      async () => {
        const networkInfo = await this.api.network();
        return {
          supply: networkInfo.supply,
          stake: networkInfo.stake,
        };
      },
      this.name,
      'NetworkInformation'
    );
  }


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
      this.name,
      'GetBlock'
    );
  }

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
      this.name,
      'GetEpoch'
    );
  }
  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        const tx = await this.api.txs(hash);
        const txUtxos = await this.api.txsUtxos(hash);
        const txMetadata = await this.api.txsMetadata(hash);

        const metadata = txMetadata.length > 0 ? txMetadata.map(md => ({
          txHash: hash,
          label: md.label,
          json_metadata: md.json_metadata as JSONValue | null,
        })) : undefined;

        return {
          hash: tx.hash,
          blockHash: tx.block,
          blockHeight: tx.block_height,
          blockTime: this.numberToIsoTimestamp(tx.block_time),
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
      this.name,
      'Transaction'
    );
  }

  // ---------------------------------------------------------------------------
  // Metadata Label Transactions
  // ---------------------------------------------------------------------------
  async getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const txLabelData = await this.api.metadataTxsLabel(label);
        if (!Array.isArray(txLabelData)) return [];

        return txLabelData.map(md => ({
          txHash: md.tx_hash,
          label: label,
          json: md.json_metadata as JSONValue | null,
        }));
      },
      this.name,
      'MetadataLabelTransactions'
    );
  }

  // ---------------------------------------------------------------------------
  //  Transaction Metadata
  // ---------------------------------------------------------------------------
  async getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const txMetadata = await this.api.txsMetadata(txHash);
        if (!Array.isArray(txMetadata)) return [];

        return txMetadata.map(md => ({
          txHash: txHash,
          label: md.label,
          json: md.json_metadata as JSONValue | null,
        }));
      },
      this.name,
      'TransactionMetadata'
    );
  }

  // ---------------------------------------------------------------------------
  // Address
  // ---------------------------------------------------------------------------
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
      this.name,
      'Address'
    );
  }

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
      this.name,
      'AddressUTxOs'
    );
  }

  async getPool(poolId: string): Promise<PoolData> {
   return handleBackendRequest(
      async () => {
        
        const poolData = await this.api.poolsById(poolId);

        return {
          poolId: poolData.hex,
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
      this.name,
      'PoolData'
    ); 
  }

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
      this.name,
      'DrepData'
    );
  }

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
      this.name,
      'AccountData'
    );
  }
numberToIsoTimestamp(value: unknown): string | null {
  const n =
    typeof value === 'number' ? value :
    typeof value === 'bigint' ? Number(value) :
    typeof value === 'string' ? Number(value) :
    NaN;

  return new Date(n * 1000).toISOString();
} }
