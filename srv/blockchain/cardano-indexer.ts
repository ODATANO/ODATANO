// srv/utils/cardano-indexer.ts

import * as cds from '@sap/cds';
import cardano from './cardano-client';

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  mapUTxOsFromOutputs,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
} from '../utils/mappers';


const { UPSERT } = cds.ql;

export class CardanoIndexer {
  /**
   * Index a single transaction with inputs/outputs/assets/UTxOs/addresses
   *
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  transaction hash (hex)
   */
  async indexTransaction(
    tx: Transaction,
    txHash: string,
    options: any = {}
  ): Promise<any> {
    // getting data from cardano data provider (@TODO add tx metadata)
    const { tx: providerTx, txUtxos } = await cardano.getTransaction(txHash);

    console.log(providerTx);

    if (!providerTx) {
      throw new Error(`Transaction ${txHash} not found at provider`);
    }

    // transactions-entity mappen & upserten
    const txRow = mapTransaction(providerTx);

    await tx.run(
      UPSERT.into('odatano.cardano.Transactions').entries(txRow)
    );

    // get in tx involved addresses
    if (txUtxos) {
      const addresses = this._collectAddressesFromUtxos(txUtxos);
      await this._ensureAddresses(tx, addresses);
    }

    // index tx inputs with utxos and assets
    if (txUtxos) {
      const inputRows = mapTransactionInputs(txHash, txUtxos);
      const inputAssetRows = mapTransactionInputAssets(txHash, txUtxos);

      if (inputRows.length) {
        await tx.run(
          UPSERT.into('odatano.cardano.TransactionInputs').entries(inputRows)
        );
      }

      if (inputAssetRows.length) {
        await tx.run(
          UPSERT.into('odatano.cardano.TransactionInputAssets').entries(
            inputAssetRows
          )
        );
      }
    }

    // index tx outputs with utxos and assets
    if (txUtxos) {
      const outputRows = mapTransactionOutputs(txHash, txUtxos);
      const outputAssetRows = mapTransactionOutputAssets(txHash, txUtxos);

      if (outputRows.length) {
        await tx.run(
          UPSERT.into('odatano.cardano.TransactionOutputs').entries(
            outputRows
          )
        );
      }

      if (outputAssetRows.length) {
        await tx.run(
          UPSERT.into('odatano.cardano.TransactionOutputAssets').entries(
            outputAssetRows
          )
        );
      }
    }

    // result for CAP Handler
    return txRow;
  }

  /**
   * Index a single address (Addresses + AddressAssets + AddressUTxos)
   */
  async indexAddress(tx: Transaction, addr: string): Promise<any> {
    const addrData = await cardano.getAddress(addr);

    // Address baseline
    const addrEntity = mapAddress(addr, addrData);

    // Addresses upsert
    await tx.run(
      UPSERT.into('odatano.cardano.Addresses').entries(addrEntity)
    );

    const assetEntitys = mapAddressAssets(
      addr,
      addrEntity.validTo,
      addrData
    );

    // Address Assets upsert
    await tx.run(
      UPSERT.into('odatano.cardano.AddressAssets').entries(assetEntitys)
    );

    addrEntity.assets = assetEntitys;

    const utxoData = await cardano.getAddressUtxos(addr);

    const utxoEntitys = mapAddressUtxos(
      addr,
      addrEntity.validTo,
      utxoData
    );

    console.log('utxos:', utxoEntitys);

    // Address Utxos upsert
    await tx.run(
      UPSERT.into('odatano.cardano.AddressUTxOs').entries(utxoEntitys)
    );

    addrEntity.AddressUtxos = utxoEntitys;

    return addrEntity;
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

// entspricht deinem bisherigen `module.exports = new CardanoIndexer()`
const cardanoIndexer = new CardanoIndexer();
export default cardanoIndexer;
