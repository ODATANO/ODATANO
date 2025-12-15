import cds from '@sap/cds';
import type { Transaction } from '@sap/cds';
import cardano from './cardano-client';
import logger from '../utils/logger';

import {
  Addresses,
  Transaction as TransactionRow,
  AddressAssets,
  AddressUTxOs,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata as TransactionMetadataEntity,
  NetworkInformation as NetworkInformationEntity,
  LatestBlock as LatestBlockEntity,
  LatestEpoch as LatestEpochEntity,
} from '#cds-models/CardanoODataService';

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
  mapNetworkInfo,
  mapLatestBlock,
  mapLatestEpoch,
  mapTransactionMetadata,
} from '../utils/mappers';

import { Transaction as TransactionProviderData } from '../utils/types';

const { UPSERT } = cds.ql;

export class CardanoIndexer {
  /**
   * Index a single transaction with inputs/outputs/assets/UTxOs/addresses
   *
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  Cardano transaction hash (hex)
   */
  async indexTransaction(
    tx: Transaction,
    txHash: string,
  ): Promise<TransactionRow> {
    // getting data from cardano data provider
    const providerTx = await cardano.getTransaction(txHash);

    if (!providerTx) {
      throw new Error(`Transaction ${txHash} not found at provider`);
    }

    const txRow = mapTransaction(providerTx);

    await tx.run(
      UPSERT.into(Transactions).entries(txRow)
    );

    if (providerTx.inputs || providerTx.outputs) {
      const addresses = this._collectAddressesFromUtxos(providerTx);
      if (addresses.length) {
        await this._ensureAddresses(tx, addresses);
      }

      // Inputs + InputAssets
      const inputRows = mapTransactionInputs(txHash, providerTx.inputs || []);

      const inputAssetRows = mapTransactionInputAssets(txHash, providerTx.inputs || []);

      if (inputRows.length) {
        await tx.run(
          UPSERT.into(TransactionInputs).entries(inputRows)
        );
      }

      if (inputAssetRows.length) {
        await tx.run(
          UPSERT.into(TransactionInputAssets).entries(inputAssetRows)
        );
      }

      // Outputs + OutputAssets
      const outputRows = mapTransactionOutputs(txHash, providerTx.outputs || []);
      const outputAssetRows = mapTransactionOutputAssets(txHash, providerTx.outputs || []);

      if (outputRows.length) {
        await tx.run(
          UPSERT.into(TransactionOutputs).entries(outputRows)
        );
      }

      if (outputAssetRows.length) {
        await tx.run(
          UPSERT.into(TransactionOutputAssets).entries(outputAssetRows)
        );
      }
    }
    return txRow;
  }

  /**
   * Index a single address (Addresses + AddressAssets + AddressUTxOs)
   */
  async indexAddress(tx: Transaction, addr: string): Promise<any> {
    const addrData = await cardano.getAddress(addr);

    logger.debug({ addrData }, 'indexAddress: provider response');

    const AddrEntity = mapAddress(addr, addrData);

    await tx.run(
      UPSERT.into(Addresses).entries(AddrEntity)
    );

    const validTo = AddrEntity.validTo ?? new Date().toISOString();
    const validFrom = AddrEntity.validFrom ?? new Date().toISOString();

    const assetEntities = mapAddressAssets(
      addr,
      validFrom,
      validTo, 
      addrData.amount
    );

    if (assetEntities.length) {
      await tx.run(
        UPSERT.into(AddressAssets).entries(assetEntities)
      );
    }

    const utxoData = await cardano.getAddressUtxos(addr);

    const utxoEntities = mapAddressUtxos(
      addr,
      validFrom,
      validTo,
      utxoData
    );

    logger.debug({ utxoEntities }, 'indexAddress: utxo entities');

    if (utxoEntities.length) {
      await tx.run(
        UPSERT.into(AddressUTxOs).entries(utxoEntities)
      );
    }

    return AddrEntity;
  }

   /**
   * Index metadata for a single transaction (Metadata)
   *
   * @param tx       CAP transaction
   * @param txHash   transaction hash
   * @param metadata raw metadata object (label -> JSONValue)
   */
  async indexTransactionMetadata(
    tx: Transaction,
    txHash: string,
  ): Promise<TransactionMetadataEntity[]> {

    const metadata = await cardano.getTransactionMetadata(txHash);

    const rows = mapTransactionMetadata(metadata);

    if (rows.length) {
      await tx.run(
        UPSERT.into(TransactionMetadataEntity).entries(rows)
      );
    }
    return rows;
  }

  /**
   * Index metadata for all transactions of a given label
   * using cardano.getMetadataLabelTransactions(label)
   *
   * @param tx     CAP transaction
   * @param label  metadata label (numeric or string)
   */
  async indexMetadataLabelTransactions(
    tx: Transaction,
    label: string | number,
  ): Promise<TransactionMetadataEntity[]> {
    
    const labelTxs = await cardano.getMetadataLabelTransactions(label);

    const rows = mapTransactionMetadata(labelTxs);

    if (!Array.isArray(labelTxs) || labelTxs.length === 0) {
      return [];
    } 

    for (const entry of labelTxs) {
      const numericLabel = Number(entry.label);
      if (Number.isNaN(numericLabel)) continue;

      rows.push({
        tx_hash: entry.txHash,
        label: numericLabel.toString(),
        payload: entry.json !== undefined ? JSON.stringify(entry.json) : null,
      });
    }

    if (rows.length) {
      await tx.run(
        UPSERT.into(TransactionMetadataEntity).entries(rows)
      );
    }

    return rows;
  }

  /**
   * Index network information
   */
  async indexNetworkInformation(tx: Transaction): Promise<NetworkInformationEntity> {
    const netInfo = await cardano.getNetworkInformation();
    const netEntity = mapNetworkInfo(netInfo);

    await tx.run(
      UPSERT.into(NetworkInformationEntity).entries(netEntity)
    );
    return netEntity;
  }
  
  /**
   * Index latest block information
   */
  async indexLatestBlock(tx: Transaction): Promise<LatestBlockEntity> {
    const blockInfo = await cardano.getLatestBlock();
    
    let latestEpoch = await tx.run(SELECT.one.from(LatestEpochEntity));
    if (!latestEpoch) {
      try {
        latestEpoch = await this.indexLatestEpoch(tx);
      } catch (error) {
        throw new Error('LatestEpoch data not found for LatestBlock indexing');
      }
    }
    const blockEntity = mapLatestBlock(blockInfo, latestEpoch); 
    await tx.run(
      UPSERT.into(LatestBlockEntity).entries([blockEntity])
    );
    return blockEntity;
  }

  /**
   * Index latest epoch information
   */
  async indexLatestEpoch(tx: Transaction): Promise<LatestEpochEntity> {
    const epochInfo = await cardano.getLatestEpoch();
    const epochEntity = mapLatestEpoch(epochInfo);  
    await tx.run(
      UPSERT.into(LatestEpochEntity).entries([epochEntity])
    );
    return epochEntity;
  }

  /**
   * Helper: collect all involved addresses from a txUtxos set
   */
  private _collectAddressesFromUtxos(txUtxos: TransactionProviderData): string[] {
    const set = new Set<string>();

    const inputs = txUtxos.inputs ?? [];
    const outputs = txUtxos.outputs ?? [];
    
    for (const i of inputs) {
      if (i.address) set.add(i.address);
    }
    for (const o of outputs) {
      if (o.address) set.add(o.address);
    }

    return Array.from(set);
  }

  /**
   * Helper: index multiple addresses with assets
   */
  private async _ensureAddresses(
    tx: Transaction,
    bech32List: string[]
  ): Promise<void> {
    await Promise.all(
    bech32List.map(bech32 => this.indexAddress(tx, bech32)));
  }
}

const cardanoIndexer = new CardanoIndexer();
export default cardanoIndexer;
