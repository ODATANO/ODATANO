const cds = require('@sap/cds');
const cardano = require('./blockchain/cardano-client');
const indexer = require('./blockchain/cardano-indexer');
const { isTxHash, isBech32Address } = require('./utils/validators');
const { mapError } = require('./utils/mappers');

const { SELECT, INSERT } = cds.ql;

const MAX_AGE_MINUTES = process.env.ADDR_MAX_AGE_MIN || 1;
const MAX_AGE_MS = MAX_AGE_MINUTES * 60 * 1000;

module.exports = cds.service.impl(function () {
  const {
    Transactions,
    Addresses,
    AddressAssets,
    UTxOs,
    Metadata,
    Datums,
    TransactionInputs,
    TransactionOutputs,
    TransactionInputAssets,
    TransactionOutputAssets,
  } = this.entities;

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------
  this.before('READ', '*', (req) => {
    const ent = req.target?.name || req.path;
    console.log('[CardanoService] Before READ:', ent, req.data || {});
  });

  // --------------------------------------------------------------------------
  // Transactions
  // --------------------------------------------------------------------------
  this.on('READ', Transactions, async (req) => {
    const db = cds.tx(req);

    try {
      const txHash = req.data?.hash;

      // read by primary key
      if (txHash) {
        if (!isTxHash(txHash)) return req.error(400, 'Invalid transaction hash');

        // check db
        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash: txHash })
        );
        if (existing) return existing;

        // otherwise index and persist it
        console.log('[CardanoService] Indexing transaction:', txHash);

        const txRow = await indexer.indexTransaction(db, txHash);
        
        console.log('[CardanoService] Persisted via indexer:', txRow);
        return txRow;
      }
      // else use odata query
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Transaction error:', e);
      return mapError(req, e, 'Transactions');
    }
  });

  // --------------------------------------------------------------------------
  // Addresses
  // --------------------------------------------------------------------------
  this.on('READ', Addresses, async (req) => {
    const db = cds.tx(req);

    try {
      const bech32 = req.data?.bech32;

      // read by primary key
      if (bech32) {
        if (!isBech32Address(bech32)) {
          return req.error(400, 'Invalid bech32 address');
        }
        // check db
        const existing = await db.run(
          SELECT.one.from(Addresses).where({ bech32 })
        );
        if (existing) {
            return existing;
        }
        // re-index address via indexer
        console.log('[CardanoService] Indexing address:', bech32);

        const { address } = await indexer.indexAddress(db, bech32);
        return address;
      }
      // else use odata query
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Address error:', e);
      return mapError(req, e, 'Addresses');
    }
  });

  // --------------------------------------------------------------------------
  // AddressAssets (collection only)
  // --------------------------------------------------------------------------
  this.on('READ', AddressAssets, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query); // no indexing logic here yet
    } catch (e) {
      console.error('[CardanoService] AddressAssets error:', e);
      return mapError(req, e, 'AddressAssets');
    }
  });

  // --------------------------------------------------------------------------
  // UTxOs
  // --------------------------------------------------------------------------
  this.on('READ', UTxOs, async (req) => {
    const db = cds.tx(req);
    try {
      // TODO: Optionally trigger indexTransaction(..., indexUTxOs=true)
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] UTxOs error:', e);
      return mapError(req, e, 'UTxOs');
    }
  });

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------
  this.on('READ', Metadata, async (req) => {
    const db = cds.tx(req);
    try {
      return req.error(404, 'Metadata not found for this transaction');
    } catch (e) {
      console.error('[CardanoService] Metadata error:', e);
      return mapError(req, e, 'Metadata');
    }
  });

  // --------------------------------------------------------------------------
  // Datums
  // --------------------------------------------------------------------------
  this.on('READ', Datums, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Datums error:', e);
      return mapError(req, e, 'Datums');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionInputs
  // --------------------------------------------------------------------------
  this.on('READ', TransactionInputs, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionInputs error:', e);
      return mapError(req, e, 'TransactionInputs');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionOutputs
  // --------------------------------------------------------------------------
  this.on('READ', TransactionOutputs, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionOutputs error:', e);
      return mapError(req, e, 'TransactionOutputs');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionInputAssets
  // --------------------------------------------------------------------------
  this.on('READ', TransactionInputAssets, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionInputAssets error:', e);
      return mapError(req, e, 'TransactionInputAssets');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionOutputAssets
  // --------------------------------------------------------------------------
  this.on('READ', TransactionOutputAssets, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionOutputAssets error:', e);
      return mapError(req, e, 'TransactionOutputAssets');
    }
  });
});
