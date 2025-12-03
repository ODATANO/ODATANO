import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address } from './utils/validators';
import { mapError } from './utils/mappers';
import logger from './utils/logger';

const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService {
  /**
   * Helper method to handle read operations with consistent error handling
   */
  private async handleEntityRead(
    req: Request,
    entityName: string,
    handler: (db: any) => Promise<any>
  ): Promise<any> {
    const db = cds.tx(req);
    try {
      return await handler(db);
    } catch (e) {
      logger.error({ err: e }, `[CardanoService] ${entityName} error`);
      return mapError(req, e, entityName);
    }
  }

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
      TransactionMetadata,
    } = require('#cds-models/CardanoODataService');

    // ------------------------------------------------------------------------
    // Generic logging (debug)  for all READ operations
    // ------------------------------------------------------------------------
    this.before('READ', '*', (req: Request) => {
      const entity = req.target?.name || req.event;
      logger.debug(
        { entity, params: req.data },
        '[CardanoService] Before READ',
      );
    });

    // ------------------------------------------------------------------------
    //  Read Handler for NetworkInformation
    // ------------------------------------------------------------------------
    this.on('READ', NetworkInformation, async (req: Request) => {
      const db = cds.tx(req);

      try {
        // Check if there's existing data
        const existing = await db.run(SELECT.from(NetworkInformation));
        if (existing && existing.length > 0) {
          return existing;
        }
        
        // Index new data if not found
        const networkInfo = await indexer.indexNetworkInformation(db);
        if (networkInfo) {
          // Return as array for collection requests
          return [networkInfo];
        }
        return [];
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
        const existing = await db.run(SELECT.from(LatestBlock));
        if (existing && existing.length > 0) {
          return existing;
        }

        const latestBlock = await indexer.indexLatestBlock(db);
        if (latestBlock) {
          return [latestBlock];
        }
        return [];
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
        const existing = await db.run(SELECT.from(LatestEpoch));
        if (existing && existing.length > 0) {
          return existing;
        }

        const latestEpoch = await indexer.indexLatestEpoch(db);
        if (latestEpoch) {
          return [latestEpoch];
        }
        return [];
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
      return this.handleEntityRead(req, 'AddressAssets', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // AddressUTxOs
    // ------------------------------------------------------------------------
    this.on('READ', AddressUTxOs, async (req: Request) => {
      return this.handleEntityRead(req, 'AddressUTxOs', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // UTxOAssets
    // ------------------------------------------------------------------------
    this.on('READ', UTxOAssets, async (req: Request) => {
      return this.handleEntityRead(req, 'UTxOAssets', async (db) => {
        return db.run(req.query);
      });
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
      return this.handleEntityRead(req, 'TransactionInputs', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // TransactionOutputs
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputs, async (req: Request) => {
      return this.handleEntityRead(req, 'TransactionOutputs', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // TransactionInputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputAssets, async (req: Request) => {
      return this.handleEntityRead(req, 'TransactionInputAssets', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // TransactionOutputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputAssets, async (req: Request) => {
      return this.handleEntityRead(req, 'TransactionOutputAssets', async (db) => {
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // Metadata (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', TransactionMetadata, async (req: Request) => {
      const db = cds.tx(req);

      try {
         const txHash = (req.data as { hash?: string })?.hash;
         
         if (txHash) {
          if (!isTxHash(txHash)) {
            return req.error(400, 'Invalid transaction hash');
          }

         let existing = await db.run(SELECT.one.from(TransactionMetadata).where({ txHash }));
         if (existing) {
           return existing;
         }
         const txMetadata = await indexer.indexTransactionMetadata(db, txHash);
         return txMetadata;
        }

        const label = (req.data as { label?: string })?.label;
        if (label) { 

        const existing = await db.run(SELECT.one.from(TransactionMetadata).where({ label}));
         if (existing) {
           return existing;
         }

         const txMetadata = await indexer.indexMetadataLabelTransactions(db, label);
         return txMetadata;
        }
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
        // index via indexer
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
          SELECT.from(TransactionMetadata).where({ txHash }),
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
    // action GetMetadataLabelTransactions(label: String) returns many Metadata;
    // ------------------------------------------------------------------------
    this.on('GetMetadataLabelTransactions', async (req: Request) => {
      const db = cds.tx(req);

      try {
        const { label } = req.data as { label?: string };
        if (!label) {
          return req.error(400, 'label is required');
        }

        const rows = await db.run(
          SELECT.from(TransactionMetadata).where({ label }),
        );
        if (!rows || rows.length === 0) {
          return await indexer.indexMetadataLabelTransactions(db, label);
        }
        return rows;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetMetadataLabelTransactions error');
        return mapError(req, e, 'GetMetadataLabelTransactions');
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
        let rows = await db.run(
          SELECT.from(AddressUTxOs).where({ address }),
        );

        if (!rows || rows.length === 0) {
          await indexer.indexAddress(db, address);
          rows = await db.run(
            SELECT.from(AddressUTxOs).where({ address }),
          );
        }
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

        let rows = await db.run(
          SELECT.from(AddressAssets).where({ address }),
        );
        if (!rows || rows.length === 0) {
          await indexer.indexAddress(db, address);
          rows = await db.run(
            SELECT.from(AddressAssets).where({ address }),
          );
        }
        return rows;
      } catch (e) {
        logger.error({ err: e }, '[CardanoService] GetAssetsByAddress error');
        return mapError(req, e, 'GetAssetsByAddress');
      }
    });

    return super.init();
  }
}