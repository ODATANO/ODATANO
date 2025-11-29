import cds from '@sap/cds';
import type { Transaction } from '@sap/cds';
import cardano from './cardano-client';
import logger from '../utils/logger';

import {
  Addresses,
  AddressAssets,
  AddressUTxOs,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
} from '#cds-models/CardanoODataService';

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionAssets,
  mapTransactionOutputs,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
  mapNetworkInfo,
} from '../utils/mappers';

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
    options: any = {}
  ): Promise<any> {
    // getting data from cardano data provider (@TODO add tx metadata)
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

      const inputAssetRows = mapTransactionAssets(txHash, providerTx.inputs || []);

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
      const outputAssetRows = mapTransactionAssets(txHash, providerTx.outputs || []);

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

    const assetEntities = mapAddressAssets(
      addr,
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
   * Helper: collect all involved addresses from a txUtxos set
   */
  private _collectAddressesFromUtxos(txUtxos: any): string[] {
    const set = new Set<string>();

    for (const i of txUtxos.inputs ?? []) {
      if (i.address) set.add(i.address);
    }
    for (const o of txUtxos.outputs ?? []) {
      if (o.address) set.add(o.address);
    }

    return [...set];
  }

  /**
   * Helper: index multiple addresses with assets
   */
  private async _ensureAddresses(
    tx: Transaction,
    bech32List: string[]
  ): Promise<void> {
    for (const bech32 of bech32List) {
      await this.indexAddress(tx, bech32);
    }
  }
}

const cardanoIndexer = new CardanoIndexer();
export default cardanoIndexer;
