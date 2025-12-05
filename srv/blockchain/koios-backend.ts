import axios, { AxiosInstance } from 'axios';
import { CardanoBackend } from './cardano-backend';
import {
  Transaction,
  LatestBlock,
  Address,
  UTxO,
  Network,
  LatestEpoch,
  JSONValue,
  MetadataLabelTx,
} from '../utils/types';


export class KoiosBackend implements CardanoBackend {
  public readonly name = 'koios';
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      baseURL: 'https://testnet.koios.rest/api/v0',
      timeout: 5000,
    });
  }

  async init(): Promise<void> {
    // not needed atm
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

  async getTransaction(txHash: string): Promise<any> {
    const { data } = await this.api.get(`/tx_info?tx_hash=${txHash}`);

    if (!data.length) {
      throw new Error('NOT_FOUND');
    }

    const tx = data[0];
    return {
     hash: tx.tx_hash,
     block: tx.block_no,
     blockTime: new Date(tx.tx_validity_start * 1000),
     fee: parseInt(tx.tx_fee || '0', 10),
   };
  }

  async getLatestBlock(): Promise<LatestBlock> {
    try {
      // get tip first
      const tipData = await this.api.get('/tip');

      const blockHash = tipData.data.hash;
      // get data of the tip block
      const blockData = await this.api.post('/block_info', { _block_hashes: [blockHash] });

      if (blockData.data && blockData.data.length > 0) {

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
  }
    throw new Error('ERROR_FETCHING_BLOCK');
  } catch (err: any) {
      if (err?.status === 404 || err?.response?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  async getLatestEpoch(): Promise<LatestEpoch> {
     // get tip first
      const tipData = await this.api.get('/tip');

      // get data of the tip epoch
      const epochData = await this.api.post('/epoch_info', { _epoch_nos: [tipData.data.epoch_no] });
      if (epochData.data && epochData.data.length > 0) {

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
    }
    throw new Error('ERROR_FETCHING_EPOCH');
  }

  async getAddress(address: string): Promise<any> {
    const { data } = await this.api.get(`/address_info?address=${address}`);

    if (!data.length) {
      throw new Error('NOT_FOUND');
    }

    const bal = data[0];

    return {
      address,
      balance: parseInt(bal.balance_utxo.lovelace || '0', 10),
    };
  }

  async getAddressUtxos(_address: string): Promise<any[]> {
    throw new Error('NOT_SUPPORTED');
  }

  // ---------------------------------------------------------------------------
  // NETWORKINFO
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<any> {
    throw new Error('NOT_SUPPORTED');
  }

  // ---------------------------------------------------------------------------
  // METADATA
  // ---------------------------------------------------------------------------
  async getMetadataLabels(): Promise<any[]> {
    throw new Error('NOT_SUPPORTED');
  }

  async getMetadataLabelTransactions(_label: string | number): Promise<any[]> {
    throw new Error('NOT_SUPPORTED');
  }

  async getTransactionMetadata(_txHash: string): Promise<any[]> {
    throw new Error('NOT_SUPPORTED');
  }
}
