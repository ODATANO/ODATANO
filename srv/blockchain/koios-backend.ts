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

// ---------------------------------------------------------------------------
// Koios Backend Implementation
// ---------------------------------------------------------------------------
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
    const { data } = await this.api.get(`/tx_info?tx_hash=${txHash}`);

    if (!data.length) {
      throw new Error('Transaction not found');
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

  async getAddress(address: string): Promise<Address> {
    const { data } = await this.api.get(`/address_info?address=${address}`);

    if (!data.length) {
      throw new Error('Address not found');
    }

    const addressData = data[0];

    return {
     address: address,
     stakeAddress: addressData.stake_address || null,
     type: addressData.address_type,
     isScript: addressData.is_script,
     amount: addressData.total_balance,
    };
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    const { data } = await this.api.get(`/address_utxos?address=${address}`);

    if (!data.length) {
      throw new Error('Address not found');
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
  }

  // ---------------------------------------------------------------------------
  // NETWORKINFO
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<Network> {
    const { data } = await this.api.get('/network_info');

    if (!data) {
      throw new Error('Network information not found');
    } 
    return {
      supply: {
        max: data.supply.max,
        total: data.supply.total,
        circulating: data.supply.circulating,
        locked: data.supply.locked,
        treasury: data.supply.treasury,
        reserves: data.supply.reserves},  
      stake: {
        live: data.stake.live,
        active: data.stake.active
      },  
    };  
  }

  // ---------------------------------------------------------------------------
  // METADATA
  // ---------------------------------------------------------------------------
  async getMetadataLabelTransactions(_label: string | number): Promise<MetadataLabelTx[]> {
    throw new Error('NOT_SUPPORTED');
  }

async getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> {
  const body = {
    _tx_hashes: [txHash],
  };

  const { data } = await this.api.post('/tx_metadata', body);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Transaction metadata not found');
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
    throw new Error('Transaction metadata not found');
  }
  return labels;
}
}
