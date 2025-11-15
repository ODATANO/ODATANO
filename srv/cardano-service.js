const cds = require('@sap/cds');
const cardano = require('./blockchain/cardano-client');

module.exports = cds.service.impl(function () {
  const { Transactions, Addresses } = this.entities;

  this.before('READ', '*', req => {
    const ent = req.target?.name || req.path;
    console.log('OData READ →', ent, JSON.stringify(req.data || {}));
  });
    // --- Transactions ---
  this.on('READ', Transactions, async req => {
    try {
      // Single READ: /Transactions(ID='...')
      const txId = req.data?.ID || req.data?.hash;
      if (txId) {
        const tx = await cardano.getTransaction(txId);
        return mapTx(tx); // Objekt für Single-Read
      }

      // Collection READ: /Transactions?$top=...
      const rows = [];
      if (req.query?.SELECT?.count) req._.count = rows.length;
      return rows; // Array für Collection
    } catch (e) {
      req.error(500, `Transactions READ failed: ${e.message}`);
      return [];
    }
  });

  // --- Addresses ---
  this.on('READ', Addresses, async req => {
    try {
      // Single READ
      const address = req.data?.ID || req.data?.address;
      if (address) {
        const bal = await cardano.getAddressBalance(address);
        return mapAddr(address, bal);
      }

      const rows = [];
      if (req.query?.SELECT?.count) req._.count = rows.length;
      return rows;
    } catch (e) {
      req.error(500, `Addresses READ failed: ${e.message}`);
      return [];
    }
  });

  function mapTx(tx) {
    return {
      ID: tx.hash,                
      Block: tx.block ?? null,
      Slot: tx.slot ?? null,
      Fee: tx.fee ?? null,
      // ...
    };
  }

  function mapAddr(address, bal) {
    return {
      ID: address,              
      Lovelace: bal?.lovelace ?? null,
      // evtl. Assets: bal?.assets, etc.
    };
  }
});
