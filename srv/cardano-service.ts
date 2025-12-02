import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address } from './utils/validators';
import { mapError } from './utils/mappers';
import logger from './utils/logger';

const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService {
  public init() {
    const {
      NetworkInformation,
      LatestBlock,
      LatestEpoch,
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
    } = require('#cds-models/CardanoODataService');

    // ------------------------------------------------------------------------
    // Generic logging (debug)  for all READ operations
    // ------------------------------------------------------------------------
    this.before('READ', '*', (req: Request) => {
      const ent = (req as any).target?.name || (req as any).path;
      logger.debug(
        { entity: ent, data: req.data || {} },
        '[CardanoService] Before READ',
      );
    });

    // ------------------------------------------------------------------------
    //  Read Handler for NetworkInformation
    // ------------------------------------------------------------------------
    this.on('READ', NetworkInformation, async (req: Request) => {
      const db = cds.tx(req);

      try {
        const existing = await db.run(SELECT.one.from(NetworkInformation));
        if (existing) {
          return existing;
        }
        
        const networkInfo = await indexer.indexNetworkInformation(db);
        if (networkInfo) {
          return networkInfo;
        }
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] NetworkInformation error');
        return mapError(req, e, 'NetworkInformation');
      }
    });

    // ------------------------------------------------------------------------
    // Read Handler for LatestBlock Information
    // ------------------------------------------------------------------------
    this.on('READ', LatestBlock, async (req: Request) => {
      const db = cds.tx(req);

      try {
        const existing = await db.run(SELECT.one.from(LatestBlock));
        if (existing) {
          return existing;
        }

        const latestBlock = await indexer.indexLatestBlock(db);
        if (latestBlock) {
          return latestBlock;
        }
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] LatestBlock error');
        return mapError(req, e, 'LatestBlock');
      }
    });

    // ------------------------------------------------------------------------
    // LatestEpoch (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', LatestEpoch, async (req: Request) => {
      const db = cds.tx(req);

      try {
        const existing = await db.run(SELECT.one.from(LatestEpoch));
        if (existing) {
          return existing;
        }

        const latestEpoch =  await indexer.indexLatestEpoch(db);
        if (latestEpoch) {
          return latestEpoch;
        } 
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] LatestEpoch error');
        return mapError(req, e, 'LatestEpoch');
      }
    });

    // ------------------------------------------------------------------------
    // Addresses
    // ------------------------------------------------------------------------
    this.on('READ', Addresses, async (req: Request) => {
      const db = cds.tx(req);

      try {
        const addr = (req.data as { address?: string })?.address;

        // read by primary key
        if (addr) {
          if (!isBech32Address(addr)) {
            return req.error(400, 'Invalid bech32 address');
          }

          const existing = await db.run(
            SELECT.one.from(Addresses).where({ address: addr }),
          );
          if (existing) {
            return existing;
          }

          // (re)index address via indexer
          logger.info({ address: addr }, '[CardanoService] Indexing address');
          const addressRow = await indexer.indexAddress(db, addr);
          logger.info(
            { address: addr },
            '[CardanoService] Address persisted via indexer',
          );
          return addressRow;
        }

        // default: run OData query directly on DB (collections / filters)
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] Address error');
        return mapError(req, e, 'Addresses');
      }
    });

    // ------------------------------------------------------------------------
    // AddressAssets (collection only)
    // ------------------------------------------------------------------------
    this.on('READ', AddressAssets, async (req: Request) => {
      const db = cds.tx(req);
      try {
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] AddressAssets error');
        return mapError(req, e, 'AddressAssets');
      }
    });

    // ------------------------------------------------------------------------
    // AddressUTxOs
    // ------------------------------------------------------------------------
    this.on('READ', AddressUTxOs, async (req: Request) => {
      const db = cds.tx(req);
      try {
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] AddressUTxOs error');
        return mapError(req, e, 'AddressUTxOs');
      }
    });

    // ------------------------------------------------------------------------
    // UTxOAssets
    // ------------------------------------------------------------------------
    this.on('READ', UTxOAssets, async (req: Request) => {
      const db = cds.tx(req);

      try {
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] UTxOAssets error');
        return mapError(req, e, 'UTxOAssets');
      }
    });

    // ------------------------------------------------------------------------
    // Transactions
    // ------------------------------------------------------------------------
    this.on('READ', Transactions, async (req: Request) => {
      const db = cds.tx(req);

      try {
        const txHash = (req.data as { hash?: string })?.hash;

        if (txHash) {
          if (!isTxHash(txHash)) {
            return req.error(400, 'Invalid transaction hash');
          }

          const existing = await db.run(
            SELECT.one.from(Transactions).where({ hash: txHash }),
          );
          if (existing) return existing;

          logger.info(
            { txHash },
            '[CardanoService] Indexing transaction via indexer',
          );
          const txRow = await indexer.indexTransaction(db, txHash);
          logger.info(
            { txHash },
            '[CardanoService] Transaction persisted via indexer',
          );
          return txRow;
        }

        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] Transaction error');
        return mapError(req, e, 'Transactions');
      }
    });

    // ------------------------------------------------------------------------
    // TransactionInputs
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputs, async (req: Request) => {
      const db = cds.tx(req);

      try {
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] TransactionInputs error');
        return mapError(req, e, 'TransactionInputs');
      }
    });

    // ------------------------------------------------------------------------
    // TransactionOutputs
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputs, async (req: Request) => {
      const db = cds.tx(req);

      try {
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] TransactionOutputs error');
        return mapError(req, e, 'TransactionOutputs');
      }
    });

    // ------------------------------------------------------------------------
    // TransactionInputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputAssets, async (req: Request) => {
      const db = cds.tx(req);

      try {
        return db.run(req.query);
      } catch (e) {
        logger.error(
          { err: e },
          '[CardanoService] TransactionInputAssets error',
        );
        return mapError(req, e, 'TransactionInputAssets');
      }
    });

    // ------------------------------------------------------------------------
    // TransactionOutputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputAssets, async (req: Request) => {
      const db = cds.tx(req);

      try {
        return db.run(req.query);
      } catch (e) {
        logger.error(
          { err: e },
          '[CardanoService] TransactionOutputAssets error',
        );
        return mapError(req, e, 'TransactionOutputAssets');
      }
    });

    // ------------------------------------------------------------------------
    // Metadata (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', Metadata, async (req: Request) => {
      const db = cds.tx(req);

      try {
        // Standard: OData-Query auf die persistierten Metadaten
        return db.run(req.query);
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] Metadata error');
        return mapError(req, e, 'Metadata');
      }
    });


    // ------------------------------------------------------------------------
    // action GetNetworkInformation() returns NetworkInformation;
    // ------------------------------------------------------------------------
    this.on('GetNetworkInformation', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const row = await db.run(SELECT.one.from(NetworkInformation));
        if (!row) {
          return await indexer.indexNetworkInformation(db);
        }
        return row;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetNetworkInformation error');
        return mapError(req, e, 'GetNetworkInformation');
      }
    });

    // ------------------------------------------------------------------------
    // action GetLatestBlock() returns LatestBlock;
    // ------------------------------------------------------------------------
    this.on('GetLatestBlock', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const row = await db.run(SELECT.one.from(LatestBlock));
        if (!row) {
          return await indexer.indexLatestBlock(db);
        }
        return row;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetLatestBlock error');
        return mapError(req, e, 'GetLatestBlock');
      }
    });

    // ------------------------------------------------------------------------
    // action GetLatestEpoch() returns LatestEpoch;
    // ------------------------------------------------------------------------
    this.on('GetLatestEpoch', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const row = await db.run(SELECT.one.from(LatestEpoch));
        if (!row) {
          return await indexer.indexLatestEpoch(db);
        }
        return row;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetLatestEpoch error');
        return mapError(req, e, 'GetLatestEpoch');
      }
    });

    // ------------------------------------------------------------------------
    // action GetTransactionByHash(txHash: cardano.Blake2b256) returns Transactions;
    // ------------------------------------------------------------------------
    this.on('GetTransactionByHash', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { txHash } = req.data as { txHash?: string };

        if (!txHash) {
          return req.error(400, 'txHash is required');
        }
        if (!isTxHash(txHash)) {
          return req.error(400, 'Invalid transaction hash');
        }
        // try to find in DB
        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash: txHash }),
        );
        if (existing) return existing;

        // Fallback: index via indexer
        logger.info(
          { txHash },
          '[CardanoService] GetTransactionByHash → indexing transaction',
        );
        const txRow = await indexer.indexTransaction(db, txHash);
        return txRow;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetTransactionByHash error');
        return mapError(req, e, 'GetTransactionByHash');
      }
    });

    // ------------------------------------------------------------------------
    // action GetAddressByBech32(address: cardano.bech32) returns Addresses;
    // ------------------------------------------------------------------------
    this.on('GetAddressByBech32', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { address } = req.data as { address?: string };
        if (!address) {
          return req.error(400, 'address is required');
        }
        if (!isBech32Address(address)) {
          return req.error(400, 'Invalid bech32 address');
        }

        const existing = await db.run(
          SELECT.one.from(Addresses).where({ address }),
        );
        if (existing) return existing;

        logger.info(
          { address },
          '[CardanoService] GetAddressByBech32 → indexing address',
        );
        const addrRow = await indexer.indexAddress(db, address);
        return addrRow;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetAddressByBech32 error');
        return mapError(req, e, 'GetAddressByBech32');
      }
    });

    // ------------------------------------------------------------------------
    // action GetMetadataByTxHash(txHash: cardano.Blake2b256) returns many Metadata;
    // ------------------------------------------------------------------------
    this.on('GetMetadataByTxHash', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { txHash } = req.data as { txHash?: string };
        if (!txHash) {
          return req.error(400, 'txHash is required');
        }
        if (!isTxHash(txHash)) {
          return req.error(400, 'Invalid transaction hash');
        }

        const rows = await db.run(
          SELECT.from(Metadata).where({ txHash }),
        );
        if (!rows || rows.length === 0) {
          return await indexer.indexTransactionMetadata(db, txHash);
        }
        return rows;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetMetadataByTxHash error');
        return mapError(req, e, 'GetMetadataByTxHash');
      }
    });

    // ------------------------------------------------------------------------
    // action GetUTxOsByAddress(address: cardano.bech32) returns many AddressUTxOs;
    // ------------------------------------------------------------------------
    this.on('GetUTxOsByAddress', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { address } = req.data as { address?: string };
        if (!address) {
          return req.error(400, 'address is required');
        }
        if (!isBech32Address(address)) {
          return req.error(400, 'Invalid bech32 address');
        }
        const rows = await db.run(
          SELECT.from(AddressUTxOs).where({ address }),
        );
        return rows;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetUTxOsByAddress error');
        return mapError(req, e, 'GetUTxOsByAddress');
      }
    });

    // ------------------------------------------------------------------------
    // action GetAssetsByAddress(address: cardano.bech32) returns many AddressAssets;
    // ------------------------------------------------------------------------
    this.on('GetAssetsByAddress', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { address } = req.data as { address?: string };
        if (!address) {
          return req.error(400, 'address is required');
        }
        if (!isBech32Address(address)) {
          return req.error(400, 'Invalid bech32 address');
        }

        const rows = await db.run(
          SELECT.from(AddressAssets).where({ address }),
        );
        return rows;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetAssetsByAddress error');
        return mapError(req, e, 'GetAssetsByAddress');
      }
    });

    return super.init();
  }
}