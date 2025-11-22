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
} = require('../utils/mappers');

const { UPSERT } = cds.ql;

class CardanoIndexer {
  /**
   * Index a single transaction (and optionally inputs/outputs/assets/UTxOs/addresses)
   *
   * @param {cds.Transaction} tx  - CAP transaction (cds.tx(req))
   * @param {string} txHash       - transaction hash (hex)
   * @param {object} options      - toggles for what to index
   */
  async indexTransaction(tx, txHash, options = {}) {
    const {
      indexInputs = true,
      indexOutputs = true,
      indexUTxOs = false,
      indexAddresses = false,
    } = options;

    // getting data from cardano data provider
    const { tx: providerTx, txUtxos } = await cardano.getTransaction(txHash);
    console.log(providerTx)
    if (!providerTx) {
      throw new Error(`Transaction ${txHash} not found at provider`);
    }

    // 2) Transactions-Entity mappen & upserten
    const txRow = mapTransaction(providerTx);
    await tx.run(
      UPSERT.into('odatano.cardano.Transactions').entries(txRow)
    );

    // 3) Optional: Adressen indexieren (aus Inputs & Outputs gesammelt)
    if (indexAddresses && txUtxos) {
      const addresses = this._collectAddressesFromUtxos(txUtxos);
      await this._ensureAddresses(tx, addresses);
    }

    // 4) Inputs + InputAssets indexieren
    if (indexInputs && txUtxos) {
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

    // 5) Outputs + OutputAssets indexieren
    if (indexOutputs && txUtxos) {
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

    // 6) Optional: aktuelles UTxO-Set aus Outputs ableiten
    if (indexUTxOs && txUtxos) {
      const utxoRows = mapUTxOsFromOutputs(txHash, txUtxos);
      if (utxoRows.length) {
        await tx.run(
          UPSERT.into('odatano.cardano.UTxOs').entries(utxoRows)
        );
      }
    }

    // Ergebnis für den Aufrufer (z. B. READ-Handler)
    return txRow;
  }

  /**
   * Index a single address (Addresses + AddressAssets)
   *
   * @param {cds.Transaction} tx
   * @param {string} bech32
   */
  async indexAddress(tx, bech32) {
    const addrData = await cardano.getAddress(bech32);

    // Address baseline
    const addrEntity = mapAddress(bech32, addrData);
    const assetEntities = mapAddressAssets(
      bech32,
      addrEntity.validFrom,
      addrEntity.validTo,
      addrData
    );

    // Addresses upserten
    await tx.run(
      UPSERT.into('odatano.cardano.Addresses').entries(addrEntity)
    );

    // AddressAssets upserten
    if (assetEntities.length) {
      await tx.run(
        UPSERT.into('odatano.cardano.AddressAssets').entries(assetEntities)
      );
    }

    return { address: addrEntity, assets: assetEntities };
  }

  /**
   * Hilfsfunktion: alle beteiligten Adressen aus txUtxos sammeln
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
   * Hilfsfunktion: mehrere Adressen sicherstellen (UPSERT)
   */
  async _ensureAddresses(tx, bech32List) {
    for (const bech32 of bech32List) {
      await this.indexAddress(tx, bech32);
    }
  }
}

module.exports = new CardanoIndexer();
