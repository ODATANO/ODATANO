'use strict';

const cds = require('@sap/cds');
const cardano = require('./cardano-client');

const {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  mapUTxOsFromOutputs,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
} = require('../utils/mappers');

const { UPSERT } = cds.ql;

class CardanoIndexer {
  /**
   * Index a single transaction with inputs/outputs/assets/UTxOs/addresses
   *
   * @param {cds.Transaction} tx  - CAP transaction (cds.tx(req))
   * @param {string} txHash       - transaction hash (hex)
   */
  async indexTransaction(tx, txHash, options = {}) {

    // getting data from cardano data provider (@TODO add tx metadata)
    const { tx: providerTx, txUtxos } = await cardano.getTransaction(txHash);
    console.log(providerTx)
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
          UPSERT.into('odatano.cardano.TransactionOutputs').entries(outputRows)
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
   * Index a single address (Addresses + AddressAssets + AddressUtxos )
   */
  async indexAddress(tx, addr) {
    const addrData = await cardano.getAddress(addr);

    // Address baseline
    const addrEntity = mapAddress(addr, addrData);

    // Addresses upsert
    await tx.run( UPSERT.into('odatano.cardano.Addresses').entries(addrEntity));

    const assetEntitys = mapAddressAssets( addr, addrEntity.validTo, addrData);

    // Address Assets upsert
    await tx.run( UPSERT.into('odatano.cardano.AddressAssets').entries(assetEntitys));

    addrEntity.assets =  assetEntitys;

    const utxo_data = await cardano.getAddressUtxos();

    const utxoEntitys = mapAddressUtxos(addr, addrEntity.validTo, utxo_data );
    
    // Address Utxos upsert
    await tx.run(UPSERT.into('odatano.cardano.AddressUtxos').entries(utxoEntitys));

    addrEntity.AddressUtxos = utxoEntitys;

    return addrEntity;
  }

  /**
   * Helper: collect all involed Adresses form a txUtxos set
   */
  _collectAddressesFromUtxos(txUtxos) {
    const set = new Set();

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
  async _ensureAddresses(tx, bech32List) {
    for (const bech32 of bech32List) {
      await this.indexAddress(tx, bech32);
    }
  }
}

module.exports = new CardanoIndexer();
