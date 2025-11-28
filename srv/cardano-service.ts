// srv/cardano-service.ts
import cds from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address } from './utils/validators';
import { mapError } from './utils/mappers';

const { SELECT } = cds.ql;

export default cds.service.impl(function CardanoService(this: any) {
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
  this.before('READ', '*', (req: any) => {
    const ent = req.target?.name || req.path;
    console.log('[CardanoService] Before READ:', ent, req.data || {});
  });

  // --------------------------------------------------------------------------
  // Network Informations
  // --------------------------------------------------------------------------
  this.on('READ', NetworkInformation, async (req: any) => {
    const db = cds.tx(req);
    try {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (existing) {
        return existing;
      }

      return existing;
    } catch (e) {
      console.error('[CardanoService] NetworkInformation error:', e);
      return mapError(req, e, 'NetworkInformation');
    }
  });

  // --------------------------------------------------------------------------
  // Addresses
  // --------------------------------------------------------------------------
  this.on('READ', Addresses, async (req: any) => {
    const db = cds.tx(req);

    try {
      const addr = (req.data as { address?: string })?.address;

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
        console.log('[CardanoService] Indexed', address);
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
  this.on('READ', AddressAssets, async (req: any) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] AddressAssets error:', e);
      return mapError(req, e, 'AddressAssets');
    }
  });

  // --------------------------------------------------------------------------
  // AddressUTxOs
  // --------------------------------------------------------------------------
  this.on('READ', AddressUTxOs, async (req: any) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] AddressUTxOs error:', e);
      return mapError(req, e, 'AddressUTxOs');
    }
  });

  // --------------------------------------------------------------------------
  // UTxOAssets
  // --------------------------------------------------------------------------
  this.on('READ', UTxOAssets, async (req: any) => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] UTxOAssets error:', e);
      return mapError(req, e, 'UTxOAssets');
    }
  });

  // --------------------------------------------------------------------------
  // Transactions
  // --------------------------------------------------------------------------
  this.on('READ', Transactions, async (req: any) => {
    const db = cds.tx(req);

    try {
      const txHash = (req.data as { hash?: string })?.hash;

      if (txHash) {
        if (!isTxHash(txHash)) {
          return req.error(400, 'Invalid transaction hash');
        }

        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash: txHash })
        );
        if (existing) return existing;

        console.log('[CardanoService] Indexing transaction:', txHash);

        const txRow = await indexer.indexTransaction(db, txHash);

        console.log('[CardanoService] Persisted via indexer:', txRow);
        return txRow;
      }

      return db.run(req.query);
    } catch (e) {
      console.error('[CardanoService] Transaction error:', e);
      return mapError(req, e, 'Transactions');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionInputs
  // --------------------------------------------------------------------------
  this.on('READ', TransactionInputs, async (req: any) => {
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
  this.on('READ', TransactionOutputs, async (req: any) => {
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
  this.on('READ', TransactionInputAssets, async (req: any) => {
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
  this.on('READ', TransactionOutputAssets, async (req: any) => {
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
  this.on('READ', Metadata, async (req: any) => {
    try {
      // @Todo implement logic
      return req.error(404, 'Metadata not found for this transaction');
    } catch (e) {
      console.error('[CardanoService] Metadata error:', e);
      return mapError(req, e, 'Metadata');
    }
  });
});
