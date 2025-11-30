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
  MetadataLabel,
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

  getLatestBlock(): Promise<LatestBlock> {
    throw new Error('NOT_SUPPORTED');
  }

  getLatestEpoch(): Promise<LatestEpoch> {
    throw new Error('NOT_SUPPORTED');
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
}
