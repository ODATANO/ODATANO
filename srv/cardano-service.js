const cds = require('@sap/cds');
const cardano = require('./blockchain/cardano-client');
const { isTxHash, isBech32Address } = require('./utils/validators');
const cache = require('./utils/cache');
const { mapProviderError } = require('./utils/errors');

module.exports = cds.service.impl(function () {
  const { Transactions, Addresses, Metadata } = this.entities;

  this.before('READ', '*', req => {
    const ent = req.target?.name || req.path;
    console.log('OData READ →', ent, JSON.stringify(req.data || {}));
  });

  // --- Transactions ---
  this.on('READ', Transactions, async req => {
    try {
      const txId = req.data?.ID || req.data?.hash;
      if (txId) {
        if (!isTxHash(txId)) return req.error(400, 'Invalid transaction hash format');

        const cacheKey = `tx:${txId}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const tx = await cardano.getTransaction(txId);
        const mapped = mapTx(tx);
        cache.set(cacheKey, mapped);
        return mapped;
      }

      // collection read - for now return empty array
      const rows = [];
      if (req.query?.SELECT?.count) req._.count = rows.length;
      return rows;
    } catch (e) {
      return mapError(req, e, 'Transactions');
    }
  });

  // --- Addresses ---
  this.on('READ', Addresses, async req => {
    try {
      const address = req.data?.ID || req.data?.address;
      if (address) {
        if (!isBech32Address(address)) return req.error(400, 'Invalid address format');

        const cacheKey = `addr:${address}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const bal = await cardano.getAddressBalance(address);
        const mapped = mapAddr(address, bal);
        cache.set(cacheKey, mapped);
        return mapped;
      }

      const rows = [];
      if (req.query?.SELECT?.count) req._.count = rows.length;
      return rows;
    } catch (e) {
      return mapError(req, e, 'Addresses');
    }
  });

  // --- Metadata ---
  this.on('READ', Metadata, async req => {
    try {
      const txId = req.data?.tx;
      if (!txId) return req.error(400, 'Missing transaction id');
      if (!isTxHash(txId)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `meta:${txId}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      // first get transaction
      const tx = await cardano.getTransaction(txId);
      if (tx?.metadata) {
        const res = tx.metadata;
        cache.set(cacheKey, res);
        return res;
      }

      // no metadata available
      return req.error(404, 'Metadata not found for transaction');
    } catch (e) {
      return mapError(req, e, 'Metadata');
    }
  });

  // --- Actions: GetTransactionByHash ---
  this.on('GetTransactionByHash', async req => {
    try {
      const { hash } = req.data || {};
      if (!hash) return req.error(400, 'Missing hash parameter');
      if (!isTxHash(hash)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `tx:${hash}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const tx = await cardano.getTransaction(hash);
      const mapped = mapTx(tx);
      cache.set(cacheKey, mapped);
      return mapped;
    } catch (e) {
      return mapError(req, e, 'GetTransactionByHash');
    }
  });

  // --- Actions: GetMetadataByTx ---
  this.on('GetMetadataByTx', async req => {
    try {
      const { hash } = req.data || {};
      if (!hash) return req.error(400, 'Missing hash parameter');
      if (!isTxHash(hash)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `meta:${hash}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      // best-effort metadata via client
      const tx = await cardano.getTransaction(hash);
      if (tx?.metadata) {
        cache.set(cacheKey, tx.metadata);
        return tx.metadata;
      }
      return req.error(404, 'Metadata not found for transaction');
    } catch (e) {
      return mapError(req, e, 'GetMetadataByTx');
    }
  });

  function mapTx(tx) {
    return {
      ID: tx.hash,
      hash: tx.hash,
      block: tx.block ?? null,
      blockTime: tx.blockTime ?? null,
      fee: tx.fee ?? null,
      inputs: tx.inputs || [],
      outputs: tx.outputs || [],
      metadata: tx.metadata || null
    };
  }

  function mapAddr(address, bal) {
    return {
      address: address,
      balance: bal?.balance ?? bal?.lovelace ?? 0,
      assets: bal?.assets ? JSON.stringify(bal.assets) : null
    };
  }

  function mapError(req, err, ctx) {
    const mapped = mapProviderError(err);
    const status = mapped.status || 500;
    const message = mapped.message || `${ctx} READ failed`;
    return req.error(status, `${ctx}: ${message}`);
  }
});
