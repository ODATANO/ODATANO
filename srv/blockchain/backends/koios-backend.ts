import axios, { AxiosInstance } from 'axios';
import { CardanoBackend } from './cardano-backend';
import { handleBackendRequest} from '../../utils/backend-request-handler';
import { ProviderBadResponseError } from '../../utils/errors';
import { CONFIG } from '../../../config/config';
import {
  Transaction,
  LatestBlock,
  Address,
  UTxO,
  Network,
  LatestEpoch,
  JSONValue,
  MetadataLabelTx,
} from '../../utils/types';

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

  async getLatestBlock(): Promise<LatestBlock> {
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

        return {
          time: blockData.data[0].time,
          height: blockData.data[0].block_height,
          hash: blockData.data[0].block_hash,
          slot: blockData.data[0].slot_no,
          epoch: blockData.data[0].epoch_no,
          epochSlot: blockData.data[0].epoch_slot_no,
          slotLeader: blockData.data[0].vrf_key,
          size: blockData.data[0].block_size,
          txCount: blockData.data[0].tx_count,
          fees: blockData.data[0].total_fees,
        };
      },
      this.name,
      'LatestBlock'
    );
  }

  async getLatestEpoch(): Promise<LatestEpoch> {
    return handleBackendRequest(
      async () => {
        // get tip first
        const tipData = await this.api.get('/tip');

        // get data of the tip epoch
        const epochData = await this.api.post('/epoch_info', { _epoch_nos: [tipData.data.epoch_no] });
        
        if (!epochData.data || !Array.isArray(epochData.data) || epochData.data.length === 0) {
          throw new ProviderBadResponseError('Epoch data not available', this.name);
        }

        return {
          epoch: epochData.data[0].epoch_no,
          start_time: epochData.data[0].start_time,
          end_time: epochData.data[0].end_time,
          first_block_time: epochData.data[0].first_block_time,
          last_block_time: epochData.data[0].last_block_time,
          block_count: epochData.data[0].block_count,
          tx_count: epochData.data[0].tx_count,
          output: epochData.data[0].total_output,
          fees: epochData.data[0].total_fees,
          active_stake: epochData.data[0].active_stake,
        };
      },
      this.name,
      'LatestEpoch'
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

        return {
          address: address,
          stakeAddress: addressData.stake_address || null,
          type: addressData.address_type,
          isScript: addressData.is_script,
          amount: addressData.total_balance,
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
            max: '45000000000000000', // Fixed Cardano max supply
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
}

