import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBech32Address, isBech32StakeAddress } from './utils/validators';
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
      Blocks,
      Epochs,
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
      Pools,
      Accounts,
      Dreps,
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
    // Read Handler for LatestBlock Information (collection-safe)
    // ------------------------------------------------------------------------
    this.on('READ', Blocks, async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        // First, try to satisfy the OData query directly (collection or filters)
        try {
          const rows = await db.run(req.query);
          if (Array.isArray(rows) && rows.length > 0) {
            return rows;
          }
        } catch (err) {
          // fall through to indexing path
        }

        // If empty, attempt to index epoch and latest block to populate
        try {
          // Ensure epoch exists before mapping block
          await indexer.indexLatestEpoch(db);
        } catch (err) {
          // Ignore epoch indexing errors for collection reads
        }

        try {
          await indexer.indexLatestBlock(db);
        } catch (err) {
          // Ignore block indexing errors for collection reads; return empty
          return [];
        }

        // Return whatever is available after indexing attempts
        try {
          const rows = await db.run(req.query);
          return rows;
        } catch {
          return [];
        }
      });
    });

    // ------------------------------------------------------------------------
    // LatestEpoch (Entity READ)
    // ------------------------------------------------------------------------
    this.on('READ', Epochs, async (req: Request) => {
      return this.handleRequest(req, async (db) => {
        const existing = await db.run(SELECT.one.from(Epochs));
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

    this.on('READ', Pools, async (req: Request) => {

      const poolId = (req.data as { pool_id?: string })?.pool_id;

      // Validate pool_id format before business logic
      if (poolId && !isTxHash(poolId)) {
        return rejectInvalid(req, 'Pools', 'Invalid pool_id format', 'pool_id');
      }

      return this.handleRequest(req, async (db) => {

      if (poolId) {
        const existing =  await db.run(SELECT.from(Pools));

        if (existing) {
          return existing;
        }
        logger.debug(
          { poolId },
          '[CardanoService] Indexing pool via indexer',
        );
        const poolRow = await indexer.indexPool(db, poolId);
        return poolRow;
      }
      return db.run(req.query);
    }); 
  });

    this.on('READ', Accounts, async (req: Request) => {
      const stakeAddress = (req.data as { stakeAddress?: string })?.stakeAddress;
      // Validate account_id format before business logic
      if (stakeAddress && !isBech32StakeAddress(stakeAddress)) {
        return rejectInvalid(req, 'Accounts', 'Invalid account_id format', 'account_id');
      }
      return this.handleRequest(req, async (db) => {
        if (stakeAddress) {
          const existing = await db.run(SELECT.from(Accounts).where({ account_id: stakeAddress }));
          if (existing) {
            return existing;
          }
          logger.debug(
            { stakeAddress },
            '[CardanoService] Indexing account via indexer',
          ); 
          const accountRow = await indexer.indexAccount(db, stakeAddress);
          logger.debug(
            { stakeAddress },
            '[CardanoService] Account persisted via indexer',
          );
          return accountRow;
        }
      return db.run(req.query);
      });
    });
    
    this.on('READ', Dreps, async (req: Request) => {
      const drepId = (req.data as { drep_id?: string })?.drep_id;
      // Validate drep_id format before business logic
      if (drepId && !isTxHash(drepId)) {
        return rejectInvalid(req, 'Dreps', 'Invalid drep_id format', 'drep_id');
      }
      return this.handleRequest(req, async (db) => {
        if (drepId) {
          const existing = await db.run(SELECT.from(Dreps).where({ drep_id: drepId }));
          if (existing) {
            return existing;
          }

          logger.debug(
            { drepId },
            '[CardanoService] Indexing drep via indexer',
          ); 
          const drepRow = await indexer.indexDrep(db, drepId);
          logger.debug(
            { drepId },
            '[CardanoService] Drep persisted via indexer',
          );
          return drepRow;
        }
      return db.run(req.query);}); 
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

      if (txHash && !isTxHash(txHash)) {
        return rejectInvalid(req, 'TransactionMetadata', 'Invalid transaction hash format', 'hash');
      }

      // Validate label is not empty string
      if (label && label.trim().length === 0) {
        return rejectInvalid(req, 'TransactionMetadata', 'Label cannot be empty', 'label');
      }

      return this.handleRequest(req, async (db) => {

        console.log('bevor handleRequest:',req.data);

        if (txHash) {
          let existing = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash: txHash }));
          if (existing && existing.length > 0) {
            return existing;
          }
          const txMetadata = await indexer.indexTransactionMetadata(db, txHash);
          return this.asArray(txMetadata);
        }

        console.log('after handleRequest:', txHash, label);

        if (label) {
          const existing = await db.run(SELECT.from(TransactionMetadata).where({ label}));
          if (existing && existing.length > 0) {
            return existing;
          }

          const txMetadata = await indexer.indexMetadataLabelTransactions(db, label);
          return this.asArray(txMetadata);
        }

        //console.log(req.query);
        //return [ ]// db.run(req.query);
        try { 
          console.log('running generic query');
          const result = await db.run(req.query);
          return result;
        } catch (err) {
          console.log('error running query:', err);
          return [ ];
        }
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
        const row = await db.run(SELECT.one.from(Blocks));
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
        const row = await db.run(SELECT.one.from(Epochs));
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

     this.on('GetDrepByID', async (req: Request) => {
      const { drepID } = req.data as { drepID?: string };

      // Validate input before business logic
      if (!drepID) {
        return rejectMissing(req, 'GetDrepByID', 'drepID');
      }

      return this.handleRequest(req, async (db) => {
        let rows = await db.run(
          SELECT.from(Dreps).where({ drepID }),
        );
        if (!rows || rows.length === 0) {
         rows = await indexer.indexDrep(db, drepID);
        }
        return rows;
      });
    });

     this.on('GetPoolById', async (req: Request) => {
      const { poolId } = req.data as { poolId?: string };

      // Validate input before business logic
      if (!poolId) {
        return rejectMissing(req, 'GetPoolById', 'poolId ');
      }

      return this.handleRequest(req, async (db) => {
        let rows = await db.run(
          SELECT.from(Pools).where({ poolId }),
        );
        if (!rows || rows.length === 0) {
          await indexer.indexPool(db, poolId);
          rows = await db.run(
            SELECT.from(Pools).where({ poolId }),
          );
        }
        return rows;
      });

      
    });

     this.on('GetAccountByStakingAddress', async (req: Request) => {
      const { stakingAddress } = req.data as { stakingAddress?: string };

      // Validate input before business logic
      if (!stakingAddress) {
        return rejectMissing(req, 'GetAccountByStakingAddress', 'stakingAddress'); 
      }

      return this.handleRequest(req, async (db) => {
        let rows = await db.run(
          SELECT.from(Accounts).where({ stakingAddress }),
        );
        if (!rows || rows.length === 0) {
          rows = await indexer.indexAddress(db, stakingAddress);
        }
        return rows;
      });
    });

    return super.init();
  }
}