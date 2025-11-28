import cds from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address } from './utils/validators';
import { mapError } from './utils/mappers';
import { Request } from '@sap/cds'
import logger from './utils/logger';


const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService { 
  public init() {

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
  } = require('#cds-models/CardanoODataService')

 // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------
 this.before('READ', '*', req => {   
  const ent = (req as any).target?.name || (req as any).path;
  logger.debug({ entity: ent, data: req.data || {} }, 'Before READ');
});

  // --------------------------------------------------------------------------
  // Network Informations
  // --------------------------------------------------------------------------
  this.on('READ', NetworkInformation, async req => {
    const db = cds.tx(req);
    try {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (existing) {
        return existing;
      }

      // call indexer etc

    } catch (e) {
      logger.error({ err: e }, '[CardanoService] NetworkInformation error');
      return mapError(req, e, 'NetworkInformation');
    }
  });

 // --------------------------------------------------------------------------
  // Addresses
  // --------------------------------------------------------------------------
  this.on('READ', Addresses, async req => {
    logger.debug({ req }, 'on read');
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
        logger.info({ address: addr }, 'Indexing address');

        const address = await indexer.indexAddress(db, addr);
        logger.info({ address }, 'Indexed address');
        return address;
      }

      // else use odata query
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] Address error');
      return mapError(req, e, 'Addresses');
    }
  });

  // --------------------------------------------------------------------------
  // AddressAssets (collection only)
  // --------------------------------------------------------------------------
  this.on('READ', AddressAssets, async req => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] AddressAssets error');
      return mapError(req, e, 'AddressAssets');
    }
  });

  // --------------------------------------------------------------------------
  // AddressUTxOs
  // --------------------------------------------------------------------------
  this.on('READ', AddressUTxOs, async req  => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] AddressUTxOs error');
      return mapError(req, e, 'AddressUTxOs');
    }
  });

  // --------------------------------------------------------------------------
  // UTxOAssets
  // --------------------------------------------------------------------------
  this.on('READ', UTxOAssets, async req => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] UTxOAssets error');
      return mapError(req, e, 'UTxOAssets');
    }
  });

  // --------------------------------------------------------------------------
  // Transactions
  // --------------------------------------------------------------------------
  this.on('READ', Transactions, async req => {
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

        logger.info({ txHash }, '[CardanoService] Indexing transaction');

        const txRow = await indexer.indexTransaction(db, txHash);

        logger.info({ txRow }, '[CardanoService] Persisted via indexer');
        return txRow;
      }

      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] Transaction error');
      return mapError(req, e, 'Transactions');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionInputs
  // --------------------------------------------------------------------------
  this.on('READ', TransactionInputs, async req => {
    const db = cds.tx(req);
    try {
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] TransactionInputs error');
      return mapError(req, e, 'TransactionInputs');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionOutputs
  // --------------------------------------------------------------------------
  this.on('READ', TransactionOutputs, async req => {
    const db = cds.tx(req);
    try {
      return await db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] TransactionOutputs error');
      return mapError(req, e, 'TransactionOutputs');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionInputAssets
  // --------------------------------------------------------------------------
  this.on('READ', TransactionInputAssets, async req => {
    const db = cds.tx(req);
    try {
      return await db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] TransactionInputAssets error');
      return mapError(req, e, 'TransactionInputAssets');
    }
  });

  // --------------------------------------------------------------------------
  // TransactionOutputAssets
  // --------------------------------------------------------------------------
  this.on('READ', TransactionOutputAssets, async req  => {
    const db = cds.tx(req);
    
    try {
      return db.run(req.query);
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] TransactionOutputAssets error');
      return mapError(req, e, 'TransactionOutputAssets');
    }
  });

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------
  this.on('READ', Metadata, async req => {
    try {
      // @Todo implement logic
      return req.error(404, 'Metadata not found for this transaction');
    } catch (e) {
      logger.error({ err: e }, '[CardanoService] Metadata error');
      return mapError(req, e, 'Metadata');
    }
  });

  
  return super.init();
}
}