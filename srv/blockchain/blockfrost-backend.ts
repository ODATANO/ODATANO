import { CardanoBackend } from './cardano-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { handleBackendError } from './backend-error-handler';
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
// Blockfrost Backend Implementation
// ---------------------------------------------------------------------------
export class BlockfrostBackend implements CardanoBackend {
  public readonly name = 'blockfrost';
  private api: BlockFrostAPI;

  constructor() {
    const projectId = process.env.BLOCKFROST_KEY;
    if (!projectId) {
      throw new Error('[BlockfrostBackend] Environment variable BLOCKFROST_KEY is not set');
    }

    this.api = new BlockFrostAPI({
      projectId,
    });
  }
  
  async init(): Promise<void> { }

  // ---------------------------------------------------------------------------
  // Network Information
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<Network> {
    return handleBackendError(
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

  async getLatestBlock(): Promise<LatestBlock> {
    return handleBackendError(
      async () => {
        const latestBlock = await this.api.blocksLatest();
        return {
          time: latestBlock.time,
          height: latestBlock.height,
          hash: latestBlock.hash,
          slot: latestBlock.slot,
          slotLeader: latestBlock.slot_leader,
          epoch: latestBlock.epoch,
          epochSlot: latestBlock.epoch_slot,
          size: latestBlock.size,
          txCount: latestBlock.tx_count,
          fees: latestBlock.fees,
        };
      },
      this.name,
      'LatestBlock'
    );
  }

  async getLatestEpoch(): Promise<LatestEpoch> {
    return handleBackendError(
      async () => {
        const latestEpoch = await this.api.epochsLatest();
        return {
          epoch: latestEpoch.epoch,
          start_time: latestEpoch.start_time,
          end_time: latestEpoch.end_time,
          first_block_time: latestEpoch.first_block_time,
          last_block_time: latestEpoch.last_block_time,
          block_count: latestEpoch.block_count,
          tx_count: latestEpoch.tx_count,
          output: latestEpoch.output,
          fees: latestEpoch.fees,
          active_stake: latestEpoch.active_stake,
        };
      },
      this.name,
      'LatestEpoch'
    );
  }
  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------
  async healthCheck(): Promise<boolean> {
    return (await this.api.health()).is_healthy;
  }
  
  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendError(
      async () => {
        const tx = await this.api.txs(hash);
        const txUtxos = await this.api.txsUtxos(hash);
        const txMetadata = await this.api.txsMetadata(hash);
        return {
          hash: tx.hash,
          blockHash: tx.block,
          blockHeight: tx.block_height,
          blockTime: tx.block_time,
          slot: tx.slot,
          index: tx.index,
          fee: parseInt(tx.fees, 10),
          deposit: parseInt(tx.deposit, 10),
          size: tx.size,
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
          outputAmount: tx.output_amount,
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
          metadata: txMetadata,
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
    return handleBackendError(
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
    return handleBackendError(
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
    return handleBackendError(
      async () => {
        const address_data = await this.api.addresses(address);
        return {
          address: address_data.address,
          stakeAddress: address_data.stake_address,
          type: address_data.type,
          isScript: address_data.script,
          amount: address_data.amount,
        };
      },
      this.name,
      'Address'
    );
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendError(
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
}
