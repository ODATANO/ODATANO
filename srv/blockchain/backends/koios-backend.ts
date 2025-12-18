import axios, { AxiosInstance } from 'axios';
import { CardanoBackend } from './cardano-backend';
import { handleBackendRequest} from '../../utils/backend-request-handler';
import { ProviderBadResponseError } from '../../utils/errors';
import { CONFIG } from '../../../config/config';
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
  DrepData, 
  AccountData
} from '../../utils/types';
import { P } from 'pino';

// ---------------------------------------------------------------------------
// Koios Backend Implementation
// ---------------------------------------------------------------------------
export class KoiosBackend implements CardanoBackend {
  public readonly name = 'koios';
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      baseURL: CONFIG.koiosApiUrl,
      timeout: CONFIG.primaryTimeoutMs,
    });
  }

  async init(): Promise<void> {
    return;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.api.get('/health');
      return response.status === 200;
    } catch (err) {
      return false;
    } 
  }

  async getTransaction(txHash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get(`/tx_info?tx_hash=${txHash}`);

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new ProviderBadResponseError('Transaction not found', this.name);
        }

        const tx = data[0];
        return {
          hash: tx.tx_hash,
          blockHash: tx.block_hash,
          blockHeight: tx.block_height,
          slot: tx.slot_no,
          index: tx.tx_index,
          fee: parseInt(tx.tx_fee || '0', 10),
          deposit: parseInt(tx.deposit || '0', 10),
          size: tx.tx_size,
          utxoCount: tx.utxo_count,
          withdrawalCount: tx.withdrawal_count,
          mirCertCount: tx.mir_cert_count,
          delegationCount: tx.delegation_count,
          stakeCertCount: tx.stake_cert_count,
          poolUpdateCount: tx.pool_update_count,
          poolRetireCount: tx.pool_retire_count,
          assetMintOrBurnCount: tx.asset_mint_or_burn_count,
          redeemerCount: tx.redeemer_count,
          validContract: tx.valid_contract,
          blockTime: Number(tx.tx_validity_start * 1000),
          outputAmount: tx.output_amount,
          inputs: tx.inputs.map((input: any) => ({
            address: input.address,
            txHash: input.tx_hash,
          })),
          outputs: tx.outputs.map((output: any) => ({
            address: output.address,
            amount: output.amount,
          })),
          metadata: tx.metadata,
        };
      },
      this.name,
      'Transaction'
    );
  }

  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
        // get tip first
        const tipData = await this.api.get('/tip');

        const blockHash = tipData.data.hash;
        // get data of the tip block
        const blockData = await this.api.post('/block_info', { _block_hashes: [blockHash] });

        if (!blockData.data || !Array.isArray(blockData.data) || blockData.data.length === 0) {
          throw new ProviderBadResponseError('Block data not available', this.name);
        }

        const data = blockData.data[0];

        return {
          time: data.time,
          height: data.block_height,
          hash: data.block_hash,
          slot: data.slot_no,
          epoch: data.epoch_no,
          epochSlot: data.epoch_slot_no,
          slotLeader: data.vrf_key,
          size: data.block_size,
          txCount: data.tx_count,
          fees: data.total_fees,
        };
      },
      this.name,
      'LatestBlock'
    );
  }

  async getBlock(blockHash: string): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
      
        const blockData = await this.api.post('/block_info', { _block_hashes: [blockHash] });

        if (!blockData.data || !Array.isArray(blockData.data) || blockData.data.length === 0) {
          throw new ProviderBadResponseError('Block data not available', this.name);
        }

        const data = blockData.data[0];

        return {
          time: data.time,
          height: data.block_height,
          hash: data.block_hash,
          slot: data.slot_no,
          epoch: data.epoch_no,
          epochSlot: data.epoch_slot_no,
          slotLeader: data.vrf_key,
          size: data.block_size,
          txCount: data.tx_count,
          fees: data.total_fees,
        };
      },
      this.name,
      'GetBlock'
    );
  }

  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        // get tip first
        const tipData = await this.api.get('/tip');

        // get data of the tip epoch
        const epochData = await this.api.post('/epoch_info', { _epoch_nos: [tipData.data.epoch_no] });
        
        if (!epochData.data || !Array.isArray(epochData.data) || epochData.data.length === 0) {
          throw new ProviderBadResponseError('Epoch data not available', this.name);
        }

       const data = epochData.data[0];

        return {
          epoch: data.epoch_no,
          start_time: data.start_time,
          end_time: data.end_time,
          first_block_time: data.first_block_time,
          last_block_time: data.last_block_time,
          block_count: data.block_count,
          tx_count: data.tx_count,
          output: data.total_output,
          fees: data.total_fees,
          active_stake: data.active_stake,
        };
      },
      this.name,
      'GetEpoch'
    );
  }

  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(
      async () => {

        // get data of the tip epoch
        const epochData = await this.api.post('/epoch_info', { _epoch_nos: [epochNumber] });
        
        if (!epochData.data || !Array.isArray(epochData.data) || epochData.data.length === 0) {
          throw new ProviderBadResponseError('Epoch data not available', this.name);
        }

        const data = epochData.data[0];

        return {
          epoch: data.epoch_no,
          start_time: data.start_time,
          end_time: data.end_time,
          first_block_time: data.first_block_time,
          last_block_time: data.last_block_time,
          block_count: data.block_count,
          tx_count: data.tx_count,
          output: data.total_output,
          fees: data.total_fees,
          active_stake: data.active_stake,
        };
      },
      this.name,
      'GetEpoch'
    );
  }

  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get(`/address_info?address=${address}`);

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new ProviderBadResponseError('Address not found', this.name);
        }

        const addressData = data[0];
        const addressUtxos = await this.getAddressUtxos(address)

        return {
          address: address,
          stakeAddress: addressData.stake_address || null,
          type: addressData.address_type,
          isScript: addressData.is_script,
          amount: addressData.total_balance,
          utxos: addressUtxos,
        };
      },
      this.name,
      'Address'
    );
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get(`/address_utxos?address=${address}`);

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new ProviderBadResponseError('Address UTxOs not found', this.name);
        }
        
        const addressData = data[0];
        return addressData.utxos.map((utxo: any) => ({
          txHash: utxo.tx_hash,
          outputIndex: utxo.tx_index,
          address: address,
          amount: utxo.amount,
          blockHash: utxo.block_hash,
          datumHash: utxo.datum_hash || null,
          scriptRef: utxo.script_ref || null,
        }));
      },
      this.name,
      'AddressUTxOs'
    );
  }

  // ---------------------------------------------------------------------------
  // NETWORKINFO
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<Network> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get('/totals?order=epoch_no.desc&limit=1');

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new ProviderBadResponseError('Network information not available', this.name);
        }
        
        const latest = data[0];
        
        // Koios /totals doesn't have all the fields, so we provide reasonable defaults
        return {
          supply: {
            max: '45000000000000000',
            total: latest.supply || '0',
            circulating: latest.circulation || '0',
            locked: '0', // Not available in /totals
            treasury: latest.treasury || '0',
            reserves: latest.reserves || '0',
          },
          stake: {
            live: '0', // Not available in /totals
            active: '0', // Not available in /totals
          },
        };
      },
      this.name,
      'NetworkInformation'
    );
  }

  // ---------------------------------------------------------------------------
  // METADATA
  // ---------------------------------------------------------------------------
  async getMetadataLabelTransactions(_label: string | number): Promise<MetadataLabelTx[]> {
    throw new ProviderBadResponseError('Metadata label transactions not supported by Koios', this.name);
  }

async getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> {
  return handleBackendRequest(
    async () => {
      const body = {
        _tx_hashes: [txHash],
      };

      const { data } = await this.api.post('/tx_metadata', body);

      if (!Array.isArray(data) || data.length === 0) {
        throw new ProviderBadResponseError('Transaction metadata not found', this.name);
      }

      const first = data[0];
      const txHashFromResponse = (first.tx_hash ?? txHash);
      const metadataObj = first.metadata ?? {};

      const labels: MetadataLabelTx[] = Object.entries(metadataObj).map(
        ([labelKey, value]) => {
          const numeric = Number(labelKey);
          const parsedLabel = Number.isFinite(numeric) ? numeric : labelKey;
          return {
            txHash: txHashFromResponse,
            label: parsedLabel,
            json: value as JSONValue,
          };
        }
      );

      if (!labels.length) {
        throw new ProviderBadResponseError('Transaction metadata not found', this.name);
      }
      return labels;
    },
    this.name,
    'TransactionMetadata'
  );
}

async getPool(poolId: string): Promise<PoolData> {
  return handleBackendRequest(
    async () => {
      const body = {
       _pool_bech32_ids: [poolId],
      };
      const { data } = await this.api.post('/pool_info', body);

      if (!Array.isArray(data) || data.length === 0) {
        throw new ProviderBadResponseError('Pool not found', this.name);
      }

      const poolData = data[0];
      return {
        poolId: poolData.pool_bech32_id,
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
      };
    },
    this.name,
    'PoolData'
  );
}
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(
    async () => {
      const body = {
       _drep_ids: [drepId],
      };

      const { data } = await this.api.post('/drep_info', body);

      if (!Array.isArray(data) || data.length === 0) {
        throw new ProviderBadResponseError('Drep not found', this.name);
      }
      const drepData = data[0];
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
  
async getAccount(accountId: string): Promise<AccountData> {
  return handleBackendRequest(
    async () => {
      const body = {
       _stake_addresses: [accountId],
      };
      const { data } = await this.api.post('/account_info', body);

       if (!Array.isArray(data) || data.length === 0) {
        throw new ProviderBadResponseError('Account not found', this.name);
      }

      const addressBody = {
        _stake_addresses: [accountId],
      };
      const addressDataResponse = await this.api.post('/account_addresses', addressBody); 
      
      const addresses = await Promise.all(
          addressDataResponse.data.map((address: any) => this.getAddress(address.address))
        );

      const accountData = data[0];
      return {
        stakeaddress: accountData.stake_address,
        active: accountData.active,
        activeEpoch: accountData.active_epoch ?? 0,
        controlledAmount: accountData.controlled_amount,
        rewardsSum: accountData.rewards_sum,
        withdrawalsSum: accountData.withdrawals_sum,
        reservesSum: accountData.reserves_sum,
        treasurySum: accountData.treasury_sum,
        withdrawableAmount: accountData.withdrawable_amount,
        poolId: accountData.pool_id || null,
        drepId : accountData.drep_id || null,
        addresses: addresses,
      };
    },
    this.name,
    'AccountData'
  );
  }
}

