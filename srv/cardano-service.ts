import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address } from './utils/validators';
import { mapError } from './utils/mappers';
import { rejectInvalid, rejectMissing } from './utils/errors';
import logger from './utils/logger';

const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService {
  /**
   * Helper method to handle requests with consistent error handling
   */
  private async handleRequest(
    req: Request,
    handler: (db: any) => Promise<any>
  ): Promise<any> {
    const context = req.target?.name || req.event;
    const db = cds.tx(req);
    try {
      return await handler(db);
    } catch (e) {
      logger.error({ err: e }, `[CardanoService] ${context} error`);
      return mapError(req, e, context);
    }
  }

  /**
   * Helper to normalize return values to arrays
   */
  private asArray<T>(x: T | T[] | null | undefined): T[] {
    if (!x) return [];
    return Array.isArray(x) ? x : [x];
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
      return this.handleRequest(req, async (db) => {
        const existing = await db.run(SELECT.one.from(NetworkInformation));
        if (existing) {
          return [existing];
        }
        
        const networkInfo = await indexer.indexNetworkInformation(db);
        if (networkInfo) {
          return [networkInfo];
        }
        return [];
      });
    });

    // ------------------------------------------------------------------------
    // Read Handler for LatestBlock Information
    // ------------------------------------------------------------------------
    this.on('READ', LatestBlock, async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const existing = await db.run(SELECT.one.from(LatestBlock));
        if (existing) {
          return [existing];
        }

        const latestBlock = await indexer.indexLatestBlock(db);
        if (latestBlock) {
          return [latestBlock];
        }
        return [];
      });
    });

    // ------------------------------------------------------------------------
    // LatestEpoch (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', LatestEpoch, async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const existing = await db.run(SELECT.one.from(LatestEpoch));
        if (existing) {
          return [existing];
        }

        const latestEpoch = await indexer.indexLatestEpoch(db);
        if (latestEpoch) {
          return [latestEpoch];
        }
        return [];
      });
    });

    // ------------------------------------------------------------------------
    // Addresses
    // ------------------------------------------------------------------------
    this.on('READ', Addresses, async (req: Request) => {
      const addr = (req.data as { address?: string })?.address;

      // Validate address format before business logic
      if (addr && !isBech32Address(addr)) {
        return rejectInvalid(req, 'Addresses', 'Invalid bech32 address format', 'address');
      }

      return this.handleRequest(req, async (db) => {
        // read by primary key
        if (addr) {
          const existing = await db.run(
            SELECT.one.from(Addresses).where({ address: addr }),
          );
          if (existing) {
            return existing;
          }

          // (re)index address via indexer
          logger.debug({ address: addr }, '[CardanoService] Indexing address');
          const addressRow = await indexer.indexAddress(db, addr);
          logger.debug(
            { address: addr },
            '[CardanoService] Address persisted via indexer',
          );
          return addressRow;
        }

        // default: run OData query directly on DB (collections / filters)
        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // AddressAssets (collection only)
    // ------------------------------------------------------------------------
    this.on('READ', AddressAssets, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // AddressUTxOs
    // ------------------------------------------------------------------------
    this.on('READ', AddressUTxOs, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // UTxOAssets
    // ------------------------------------------------------------------------
    this.on('READ', UTxOAssets, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // Transactions
    // ------------------------------------------------------------------------
    this.on('READ', Transactions, async (req: Request) => {
      const txHash = (req.data as { hash?: string })?.hash;

      // Validate transaction hash format before business logic
      if (txHash && !isTxHash(txHash)) {
        return rejectInvalid(req, 'Transactions', 'Invalid transaction hash format', 'hash');
      }

      return this.handleRequest(req, async (db) => {
        if (txHash) {
          const existing = await db.run(
            SELECT.one.from(Transactions).where({ hash: txHash }),
          );
          if (existing) return existing;

          logger.debug(
            { txHash },
            '[CardanoService] Indexing transaction via indexer',
          );
          const txRow = await indexer.indexTransaction(db, txHash);
          logger.debug(
            { txHash },
            '[CardanoService] Transaction persisted via indexer',
          );
          return txRow;
        }

        return db.run(req.query);
      });
    });

    // ------------------------------------------------------------------------
    // TransactionInputs
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputs, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionOutputs
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputs, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionInputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputAssets, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionOutputAssets
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputAssets, async (req: Request) => {
      return this.handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // Metadata (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', TransactionMetadata, async (req: Request) => {
      const txHash = (req.data as { hash?: string })?.hash;
      const label = (req.data as { label?: string })?.label;

      // Validate transaction hash format before business logic
      if (txHash && !isTxHash(txHash)) {
        return rejectInvalid(req, 'TransactionMetadata', 'Invalid transaction hash format', 'hash');
      }

      // Validate label is not empty string
      if (label && label.trim().length === 0) {
        return rejectInvalid(req, 'TransactionMetadata', 'Label cannot be empty', 'label');
      }

      return this.handleRequest(req, async (db) => {
        if (txHash) {
          let existing = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash: txHash }));
          if (existing && existing.length > 0) {
            return existing;
          }
          const txMetadata = await indexer.indexTransactionMetadata(db, txHash);
          return this.asArray(txMetadata);
        }

        if (label) {
          const existing = await db.run(SELECT.from(TransactionMetadata).where({ label}));
          if (existing && existing.length > 0) {
            return existing;
          }

          const txMetadata = await indexer.indexMetadataLabelTransactions(db, label);
          return this.asArray(txMetadata);
        }
        return db.run(req.query);
      });
    });


    // ------------------------------------------------------------------------
    // action GetNetworkInformation() returns NetworkInformation;
    // ------------------------------------------------------------------------
    this.on('GetNetworkInformation', async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const row = await db.run(SELECT.one.from(NetworkInformation));
        if (!row) {
          return await indexer.indexNetworkInformation(db);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // action GetLatestBlock() returns LatestBlock;
    // ------------------------------------------------------------------------
    this.on('GetLatestBlock', async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const row = await db.run(SELECT.one.from(LatestBlock));
        if (!row) {
          return await indexer.indexLatestBlock(db);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // action GetLatestEpoch() returns LatestEpoch;
    // ------------------------------------------------------------------------
    this.on('GetLatestEpoch', async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const row = await db.run(SELECT.one.from(LatestEpoch));
        if (!row) {
          return await indexer.indexLatestEpoch(db);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // action GetTransactionByHash(txHash: cardano.Blake2b256) returns Transactions;
    // ------------------------------------------------------------------------
    this.on('GetTransactionByHash', async (req: Request) => {
      const { txHash } = req.data as { txHash?: string };

      // Validate input before business logic
      if (!txHash) {
        return rejectMissing(req, 'GetTransactionByHash', 'txHash');
      }
      if (!isTxHash(txHash)) {
        return rejectInvalid(req, 'GetTransactionByHash', 'Invalid transaction hash format', 'txHash');
      }

      return this.handleRequest(req, async (db) => {
        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash: txHash }),
        );
        if (existing) return existing;
        
        const txRow = await indexer.indexTransaction(db, txHash);
        return txRow;
      });
    });

    // ------------------------------------------------------------------------
    // action GetAddressByBech32(address: cardano.bech32) returns Addresses;
    // ------------------------------------------------------------------------
    this.on('GetAddressByBech32', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // Validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetAddressByBech32', 'address');
      }
      if (!isBech32Address(address)) {
        return rejectInvalid(req, 'GetAddressByBech32', 'Invalid bech32 address format', 'address');
      }

      return this.handleRequest(req, async (db) => {
        const existing = await db.run(
          SELECT.one.from(Addresses).where({ address }),
        );
        if (existing) return existing;

        const addrRow = await indexer.indexAddress(db, address);
        return addrRow;
      });
    });

    // ------------------------------------------------------------------------
    // action GetMetadataByTxHash(txHash: cardano.Blake2b256) returns many Metadata;
    // ------------------------------------------------------------------------
    this.on('GetMetadataByTxHash', async (req: Request) => {
      const { txHash } = req.data as { txHash?: string };

      // Validate input before business logic
      if (!txHash) {
        return rejectMissing(req, 'GetMetadataByTxHash', 'txHash');
      }
      if (!isTxHash(txHash)) {
        return rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'txHash');
      }

      return this.handleRequest(req, async (db) => {
        const rows = await db.run(
          SELECT.from(TransactionMetadata).where({ tx_hash: txHash }),
        );
        if (!rows || rows.length === 0) {
          return this.asArray(await indexer.indexTransactionMetadata(db, txHash));
        }
        return rows;
      });
    });

    // ------------------------------------------------------------------------
    // action GetMetadataLabelTransactions(label: String) returns many Metadata;
    // ------------------------------------------------------------------------
    this.on('GetMetadataLabelTransactions', async (req: Request) => {
      const { label } = req.data as { label?: string };

      // Validate input before business logic
      if (!label) {
        return rejectMissing(req, 'GetMetadataLabelTransactions', 'label');
      }
      if (label.trim().length === 0) {
        return rejectInvalid(req, 'GetMetadataLabelTransactions', 'Label cannot be empty', 'label');
      }

      return this.handleRequest(req, async (db) => {
        const rows = await db.run(
          SELECT.from(TransactionMetadata).where({ label }),
        );
        if (!rows || rows.length === 0) {
          return this.asArray(await indexer.indexMetadataLabelTransactions(db, label));
        }
        return rows;
      });
    });

    // ------------------------------------------------------------------------
    // action GetUTxOsByAddress(address: cardano.bech32) returns many AddressUTxOs;
    // ------------------------------------------------------------------------
    this.on('GetUTxOsByAddress', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // Validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetUTxOsByAddress', 'address');
      }
      if (!isBech32Address(address)) {
        return rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');
      }

      return this.handleRequest(req, async (db) => {
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
      });
    });

    // ------------------------------------------------------------------------
    // action GetAssetsByAddress(address: cardano.bech32) returns many AddressAssets;
    // ------------------------------------------------------------------------
    this.on('GetAssetsByAddress', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // Validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetAssetsByAddress', 'address');
      }
      if (!isBech32Address(address)) {
        return rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');
      }

      return this.handleRequest(req, async (db) => {
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
      });
    });

    return super.init();
  }
}