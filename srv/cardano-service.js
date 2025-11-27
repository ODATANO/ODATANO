const cds = require('@sap/cds');
const indexer = require('./blockchain/cardano-indexer');
const { isTxHash, isBech32Address } = require('./utils/validators');
const { mapError } = require('./utils/mappers');
const { SELECT } = cds.ql;

module.exports = cds.service.impl(function () {
  const {
    NetworkInformation,
    Addresses,
    AddressAssets,
    AddressUTxOs,
    UTxOAssets,
    Transactions,
    TransactionInputs,
    TransactionOutputs,
    TransactionInputAssets,
    TransactionOutputAssets,
    Metadata,
  } = this.entities;

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------
  this.before('READ', '*', (req) => {
  const ent = req.target?.name || req.path;
    console.log('[CardanoService] Before READ:', ent, req.data || {});
  });

  // --------------------------------------------------------------------------
  // Network Informations
  // --------------------------------------------------------------------------
  this.on('READ', NetworkInformation, async(req) => {
    const db = cds.tx(req);
    try {
      const existing = await db.run( SELECT.one.from(NetworkInformation) );
        if (existing) {
            return existing;
        }
        
        const networkInformation = await indexer.indexNetworkInformation(db);
        return networkInformation;

    } catch (e) {
      console.error('[CardanoService] Address error:', e);
      return mapError(req, e, 'NetworkInformation');
    }
  });
 
  // --------------------------------------------------------------------------
  // Addresses
  // --------------------------------------------------------------------------
  this.on('READ', Addresses, async (req) => {
    const db = cds.tx(req);

    try {
      const addr = req.data?.address;

      // read by primary key
      if (addr) {
        if (!isBech32Address(addr)) {
          return req.error(400, 'Invalid bech32 address');
        }
        const existing = await db.run(
          SELECT.one.from(Addresses).where({ address: addr })
        );
        if (existing) {
            return existing;
        }
        // re-index address via indexer
        console.log('[CardanoService] Indexing address:', addr);

        const address = await indexer.indexAddress(db, addr);
        console.log('[CardanoService] Indexed',address);
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
  // AddressUtxos 
  // --------------------------------------------------------------------------
  this.on('READ', AddressUTxOs, async(req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query); // no indexing logic here yet
    } catch (e) {
      console.error('[CardanoService]  AddressUTxOs error:', e);
      return mapError(req, e, ' AddressUTxOs');
    }
  });

  // --------------------------------------------------------------------------
  // UTxOAssets
  // --------------------------------------------------------------------------
  this.on('READ', UTxOAssets, async(req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query); // no indexing logic here yet
    } catch (e) {
      console.error('[CardanoService] UTxOAssets error:', e);
      return mapError(req, e, 'UTxOAssets');
    }
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

});
