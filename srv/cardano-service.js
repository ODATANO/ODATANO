const cds = require('@sap/cds');
const cardano = require('./blockchain/cardano-client');
const { isTxHash, isBech32Address } = require('./utils/validators');
const { mapProviderError } = require('./utils/errors');

const { SELECT, INSERT, UPDATE } = cds.ql;
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

  // ============ HELPERS ============

  // map transaction data to Odata stucture
  function mapTransaction(providerTx) {
    if (!providerTx) return null;
    const txHash = providerTx.hash || providerTx.tx_id;
    const blockTime = providerTx.block_time || providerTx.block_timestamp;
    const now = new Date();
    return {
      hash: txHash,
      blockHash: providerTx.block || providerTx.block_hash || null,
      blockHeight:
        providerTx.block_height !== undefined
          ? providerTx.block_height
          : providerTx.height ?? null,
      blockTime: blockTime ? new Date(blockTime * 1000) : null,
      slot: providerTx.slot ?? null,
      txIndex: providerTx.index ?? null,
      fee: providerTx.fees ? Number(providerTx.fees) : 0,
      deposit: providerTx.deposit ? Number(providerTx.deposit) : 0,
      size: providerTx.size ?? null,
      utxoCount: providerTx.utxo_count ?? null,
      withdrawalCount: providerTx.withdrawal_count ?? null,
      mirCertCount: providerTx.mir_cert_count ?? null,
      delegationCount: providerTx.delegation_count ?? null,
      stakeCertCount: providerTx.stake_cert_count ?? null,
      poolUpdateCount: providerTx.pool_update_count ?? null,
      poolRetireCount: providerTx.pool_retire_count ?? null,
      assetMintOrBurnCount: providerTx.asset_mint_or_burn_count ?? null,
      redeemerCount: providerTx.redeemer_count ?? null,
      validContract: providerTx.valid_contract ?? null,
      validFrom: now
    };
  }

  // map address data to Odata stucture
  function mapAddress(bech32, provider = {}) {

    const stakeAddress = provider.data.stake_address
    const type = provider.data.type ?? 'unknown';
    const isScript = provider.data.isScript === true;
    const totalLovelace = provider.data.amount.find(a => a.unit === 'lovelace')?.quantity || '0';
    const now = new Date();
    const validTo = new Date(Date.now() + MAX_AGE_MS);
    return {
      bech32,
      stakeAddress,
      type,
      isScript,
      totalLovelace,
      validFrom: now,
      validTo: validTo,
    };
  }

  // normalize error
  function mapError(req, err, ctx) {
    const mapped = mapProviderError(err);
    const status = mapped.status || 500;
    const message = mapped.message || `${ctx} operation failed`;
    return req.error(status, `${ctx}: ${message}`);
  }

  // ============ LOGGING ============

  this.before('READ', '*', (req) => {
    const ent = req.target?.name || req.path;
    console.log(
      '[CardanoService] Before READ:',
      ent,
      JSON.stringify(req.data || {})
    );
  });

  // ============ READ HANDLERS ============

  // --- Transactions ---
  this.on('READ', Transactions, async (req) => {
    const db = cds.tx(req);
    try {
      const txHash = req.data?.hash;

      // Single-entity READ (key lookup)
      if (txHash) {
        if (!isTxHash(txHash))
          return req.error(400, 'Invalid transaction hash format');

        // try on db first
        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash: txHash })
        );
        if (existing) return existing;

        // else get from provider
        const tx = await cardano.getTransaction(txHash);
        const mapped = mapTransaction(tx);
        if (!mapped) return req.error(404, 'Transaction not found');

        // save in db
        await db.run(INSERT.into(Transactions).entries(mapped));
        console.error('[CardanoService] Saved in DB:', mapped);
        return mapped;
      }
      // if hash is empty just do Collection-READ directly from query with filters
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Transaction error:', e);
      return mapError(req, e, 'Transactions');
    }
  });

  // Addresses
 this.on('READ', Addresses, async (req) => {
  const db = cds.tx(req);
  
  try {
    const bech32 = req.data?.bech32;

    if (bech32) {
      if (!isBech32Address(bech32))
        return req.error(400, 'Invalid address format');

      // first check on valid db entry
      const existing = await db.run(
        SELECT.one.from(Addresses).where({ bech32 })
      );

      if (existing) {
        return existing;
      }
      
      // call provider
      const addrData = await cardano.getAddress(bech32);
      const mapped = mapAddress(bech32, addrData);
      await db.run(INSERT.into(Addresses).entries(mapped));
      return mapped;
    }
    // no address provided / standard collection-read with CAP-filters
    return db.run(req.query);
  } catch (e) {
    console.error('[CardanoService] Address error:', e);
    return mapError(req, e, 'Addresses');
  }
});


  // --- AddressAssets ---
  this.on('READ', AddressAssets, async (req) => {
    const db = cds.tx(req);
    try {
      // @TODO: Load UTxOs of the address, Aggregate by unit, update/return AddressAssets
      // else directly from query with filters
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] AddressAssets error:', e);
      return mapError(req, e, 'AddressAssets');
    }
  });

  // --- UTxOs ---
  this.on('READ', UTxOs, async (req) => {
    const db = cds.tx(req);
    try {
      // @TODO: Synchronize current UTxOs based on address or Tx      
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] UTxOs error:', e);
      return mapError(req, e, 'UTxOs');
    }
  });

  // --- Metadata ---
  this.on('READ', Metadata, async (req) => {
    const db = cds.tx(req);
    try {
      const txHash = req.data?.txHash || req.data?.hash;
      if (!txHash) return req.error(400, 'Missing transaction hash');
      if (!isTxHash(txHash))
        return req.error(400, 'Invalid transaction hash format');
      // try on db first
      const existing = await db.run(
        SELECT.one.from(Metadata).where({ txHash })
      );
      if (existing) return existing;

      const tx = await cardano.getTransaction(txHash);
      if (tx?.metadata) {
        const entity = {
          txHash,
          rawCbor: null,
          createdAt: new Date(),
          decodedJson: JSON.stringify(tx.metadata),
        };
        await db.run(INSERT.into(Metadata).entries(entity));
        return entity;
      }
      return req.error(404, 'Metadata not found for transaction');
    } catch (e) {
      console.error('[CardanoService] Metadata error:', e);
      return mapError(req, e, 'Metadata');
    }
  });

  // --- Datums ---
  this.on('READ', Datums, async (req) => {
    const db = cds.tx(req);
    try {
     // @TODO: if hash is given -> SELECT.one.from(Datums).where({hash})
      //otherwise db.run(req.query)
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Datums error:', e);
      return mapError(req, e, 'Datums');
    }
  });

  // --- TransactionInputs ---
  this.on('READ', TransactionInputs, async (req) => {
    const db = cds.tx(req);
    try {
      // @TODO:
      // - Call /txs/{hash}/utxos
      // - Persist inputs in TransactionInputs + TransactionInputAssets
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionInputs error:', e);
      return mapError(req, e, 'TransactionInputs');
    }
  });

  // --- TransactionOutputs ---
  this.on('READ', TransactionOutputs, async (req) => {
    const db = cds.tx(req);
    try {
      // TODO:
      // - /txs/{hash}/utxos aufrufen
      // - Outputs in TransactionOutputs + TransactionOutputAssets persistieren
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionOutputs error:', e);
      return mapError(req, e, 'TransactionOutputs');
    }
  });

  // --- TransactionInputAssets ---
  this.on('READ', TransactionInputAssets, async (req) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] TransactionInputAssets error:', e);
      return mapError(req, e, 'TransactionInputAssets');
    }
  });

  // --- TransactionOutputAssets ---
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
