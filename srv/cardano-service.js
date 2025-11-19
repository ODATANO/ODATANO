const cds = require('@sap/cds');
const cardano = require('./blockchain/cardano-client');
const { isTxHash, isBech32Address } = require('./utils/validators');
const cache = require('./utils/cache');
const { mapProviderError } = require('./utils/errors');

module.exports = cds.service.impl(function () {
  const { 
    Transactions, Addresses, Assets, Metadata, Datums,
    TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets 
  } = this.entities;

  // ============ HELPERS ============

  // Helper: Map provider transaction to OData entity
  function mapTransaction(providerTx) {
    if (!providerTx) return null;
    const txHash = providerTx.hash || providerTx.tx_id;
    const blockTime = providerTx.block_time || providerTx.block_timestamp;
    return {
      ID: txHash,
      hash: txHash,
      blockHash: providerTx.block || providerTx.block_hash,
      blockHeight: providerTx.height || providerTx.block_height,
      timestamp: blockTime ? new Date(blockTime * 1000) : null,
      fee: providerTx.fees || 0,
      inputCount: (providerTx.inputs || []).length,
      outputCount: (providerTx.outputs || []).length,
      metadata: providerTx.metadata ? JSON.stringify(providerTx.metadata) : null
    };
  }

  // Map address with balance
  function mapAddress(address, providerBal = {}) {
    return {
      ID: address,
      address: address,
      paymentHash: address.slice(0, 56),
      paymentKind: 'Enterprise',
      balance: providerBal?.balance ?? providerBal?.lovelace ?? 0,
      assets: providerBal?.assets ? JSON.stringify(providerBal.assets) : null
    };
  }

  // Normalize error
  function mapError(req, err, ctx) {
    const mapped = mapProviderError(err);
    const status = mapped.status || 500;
    const message = mapped.message || `${ctx} operation failed`;
    return req.error(status, `${ctx}: ${message}`);
  }

  // ============ LOGGING ============

  this.before('READ', '*', req => {
    const ent = req.target?.name || req.path;
    console.log('[CardanoService] Before READ:', ent, JSON.stringify(req.data || {}));
  });

  // ============ READ HANDLERS ============

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
        const mapped = mapTransaction(tx);
        cache.set(cacheKey, mapped);
        return mapped;
      }

      // collection read - return empty array
      return [];
    } catch (e) {
      console.error('[CardanoService] Transaction error:', e);
      return mapError(req, e, 'Transactions');
    }
  });

  // --- Addresses ---
  this.on('READ', Addresses, async req => {
    try {
      const address = req.data?.bech32;
      if (address) {
        if (!isBech32Address(address)) return req.error(400, 'Invalid address format');

        const cacheKey = `addr:${address}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const bal = await cardano.getAddress(address);
        const mapped = mapAddress(address, bal);
        cache.set(cacheKey, mapped);
        return mapped;
      }

      return [];
    } catch (e) {
      console.error('[CardanoService] Address error:', e);
      return mapError(req, e, 'Addresses');
    }
  });

  // --- Assets ---
  this.on('READ', Assets, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] Assets error:', e);
      return mapError(req, e, 'Assets');
    }
  });

  // --- Metadata ---
  this.on('READ', Metadata, async req => {
    try {
      const txId = req.data?.tx_ID;
      if (!txId) return req.error(400, 'Missing transaction id');
      if (!isTxHash(txId)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `meta:${txId}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const tx = await cardano.getTransaction(txId);
      if (tx?.metadata) {
        cache.set(cacheKey, tx.metadata);
        return tx.metadata;
      }

      return req.error(404, 'Metadata not found for transaction');
    } catch (e) {
      console.error('[CardanoService] Metadata error:', e);
      return mapError(req, e, 'Metadata');
    }
  });

  // --- Datums ---
  this.on('READ', Datums, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] Datums error:', e);
      return mapError(req, e, 'Datums');
    }
  });

  // --- TransactionInputs ---
  this.on('READ', TransactionInputs, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] TransactionInputs error:', e);
      return mapError(req, e, 'TransactionInputs');
    }
  });

  // --- TransactionOutputs ---
  this.on('READ', TransactionOutputs, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] TransactionOutputs error:', e);
      return mapError(req, e, 'TransactionOutputs');
    }
  });

  // --- TransactionInputAssets ---
  this.on('READ', TransactionInputAssets, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] TransactionInputAssets error:', e);
      return mapError(req, e, 'TransactionInputAssets');
    }
  });

  // --- TransactionOutputAssets ---
  this.on('READ', TransactionOutputAssets, async req => {
    try {
      return [];
    } catch (e) {
      console.error('[CardanoService] TransactionOutputAssets error:', e);
      return mapError(req, e, 'TransactionOutputAssets');
    }
  });

  // ============ ACTIONS ============

  // --- GetTransactionByHash ---
  this.on('GetTransactionByHash', async req => {
    try {
      const { hash } = req.data || {};
      if (!hash) return req.error(400, 'Missing hash parameter');
      if (!isTxHash(hash)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `tx:${hash}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const tx = await cardano.getTransaction(hash);
      const mapped = mapTransaction(tx);
      cache.set(cacheKey, mapped);
      return mapped;
    } catch (e) {
      console.error('[CardanoService] GetTransactionByHash error:', e);
      return mapError(req, e, 'GetTransactionByHash');
    }
  });

  // --- GetMetadataByTx ---
  this.on('GetMetadataByTx', async req => {
    try {
      const { hash } = req.data || {};
      if (!hash) return req.error(400, 'Missing hash parameter');
      if (!isTxHash(hash)) return req.error(400, 'Invalid transaction hash format');

      const cacheKey = `meta:${hash}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const tx = await cardano.getTransaction(hash);
      if (tx?.metadata) {
        cache.set(cacheKey, tx.metadata);
        return tx.metadata;
      }
      return req.error(404, 'Metadata not found for transaction');
    } catch (e) {
      console.error('[CardanoService] GetMetadataByTx error:', e);
      return mapError(req, e, 'GetMetadataByTx');
    }
  });

  // --- GetAddressByBech32 ---
  this.on('GetAddressByBech32', async req => {
    try {
      const { bech32 } = req.data || {};
      if (!bech32) return req.error(400, 'Missing address parameter');
      if (!isBech32Address(bech32)) return req.error(400, 'Invalid bech32 address format');

      const cacheKey = `addr:${bech32}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const bal = await cardano.getAddressBalance(bech32);
      console.log('after call' && bal);
      const mapped = mapAddress(bech32, bal);
      cache.set(cacheKey, mapped);
      return mapped;
    } catch (e) {
      console.error('[CardanoService] GetAddressByBech32 error:', e);
      return mapError(req, e, 'GetAddressByBech32');
    }
  });

  console.log('[CardanoService] Service impl complete');
});
