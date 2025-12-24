import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBlockHash, isBech32Address, isBech32StakeAddress, isPoolId, isDrepId } from './utils/validators';
import { rejectInvalid, rejectMissing } from './utils/errors';
import logger from './utils/logger';
import { handleRequest } from './utils/backend-request-handler';

const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService {

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
    //  NetworkInformation READ & GetNetworkInformation Action
    // ------------------------------------------------------------------------
    this.on('READ', NetworkInformation, async (req: Request) => {
      return handleRequest(req, async (db) => {
        const existing = await db.run(SELECT.one.from(NetworkInformation));
        if (existing) {
          return existing;
        }
        logger.debug('[CardanoService] Indexing network information via indexer');
        return await indexer.indexNetworkInformation(db);
      });
    });

    this.on('GetNetworkInformation', async (req: Request) => {
      return handleRequest(req, async (db) => {
        const row = await db.run(SELECT.one.from(NetworkInformation));
        if (!row) {
          return await indexer.indexNetworkInformation(db);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // Blocks READ & GetLatestBlock / GetBlockByHash Actions 
    // ------------------------------------------------------------------------
    this.on('READ', Blocks, async (req: Request) => {
      const hash = (req.data as { hash?: string })?.hash;
      // validate input before business logic
      if (hash && !isBlockHash(hash)) {
        return rejectInvalid(req, 'Blocks', 'Invalid hash format', 'hash');
      }
      
      return handleRequest(req, async (db) => { 
        if (hash) {
          const existing = await db.run(SELECT.one.from(Blocks).where({ hash: hash }));
          
          if (existing) {
            return existing;
          }
          logger.debug({ hash: hash },'[CardanoService] Indexing block via indexer');
          return await indexer.indexBlock(db, hash);
        }
        return db.run(req.query);
      });
    });

    this.on('GetBlockByHash', async (req: Request) => {
     const hash = (req.data?.hash as string | undefined) ?? undefined;
      // validate input before business logic
      if (!hash) {
        return rejectMissing(req, 'Blocks', 'hash');
      }
      if (!isTxHash(hash)) {
        return rejectInvalid(req, 'Blocks', 'hash has invalid format', 'hash');
      }

      return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Blocks).where({ hash: hash }));
        if (!row) {
          row = await indexer.indexBlock(db, hash);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // Epoch READ & GetLatestEpoch / GetEpochByNumber Actions
    // ------------------------------------------------------------------------
    this.on('READ', Epochs, async (req: Request) => {
      const epochNumber = (req.data as { epoch?: number })?.epoch;
      return handleRequest(req, async (db) => {
        if (epochNumber != null) {
        const existing = await db.run(SELECT.one.from(Epochs).where({ epoch: epochNumber }));
        if (existing) {
          return existing;
        }
        logger.debug({ epochNumber },'[CardanoService] Indexing epoch via indexer');
        return await indexer.indexEpoch(db, epochNumber);
        }
        return db.run(req.query);
      });
    });

    this.on('GetEpochByNumber', async (req: Request) => {
      const epochNumber = req.data?.epochNumber as Number | undefined;
      // validate input before business logic
      if (epochNumber == null) {
        return rejectMissing(req, 'Epochs', 'epochNumber');
      }

      return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Epochs).where({ epoch: epochNumber }));
        if (!row) {
          row = await indexer.indexEpoch(db, epochNumber);
          if (!row) {
            return rejectMissing(req, 'Epochs', 'epochNumber');
          }
        }
        return row;
      });
    });
    // ------------------------------------------------------------------------
    // Pools READ & GetPoolById Action
    // ------------------------------------------------------------------------
    this.on('READ', Pools, async (req: Request) => {
      const poolId = (req.data as { poolId?: string })?.poolId;
      // validate pool_id format before business logic
      if (poolId && !isPoolId(poolId)) {
        return rejectInvalid(req, 'Pools', 'Invalid poolId format', 'poolId');
      }
      return handleRequest(req, async (db) => {
        if (poolId) {
          const existing =  await db.run(SELECT.one.from(Pools).where({ poolId: poolId }));
          if (existing) {
            return existing;
          }
          logger.debug({ poolId },'[CardanoService] Indexing pool via indexer');
          return await indexer.indexPool(db, poolId);
        }
        return db.run(req.query); 
      });
    });

    this.on('GetPoolById', async (req: Request) => {
      const { poolId } = req.data as { poolId?: string };

      // validate input before business logic
      if (poolId && !isPoolId(poolId)) {
        return rejectInvalid(req, 'Pools', 'Invalid poolId format', 'poolId');
      }

      return handleRequest(req, async (db) => {
        if (poolId) {
        const existing = await db.run(
          SELECT.one.from(Pools).where({ poolId }),
        );
        if (existing) {
          return existing;
        }
        logger.debug({ poolId },'[CardanoService] Indexing pool via indexer');
        return await indexer.indexPool(db, poolId);
        }});
    });

    // ------------------------------------------------------------------------
    // Accounts READ & GetAccountByStakeAddress Action
    // ------------------------------------------------------------------------
    this.on('READ', Accounts, async (req: Request) => {
      const stakeAddress = (req.data as { stakeAddress?: string })?.stakeAddress;

      // validate stake address format before business logic
      if (stakeAddress && !isBech32StakeAddress(stakeAddress)) {
        return rejectInvalid(req, 'Accounts', 'Invalid stakeAddress format', 'stakeAddress');
      }
      return handleRequest(req, async (db) => {
        if (stakeAddress) {
          const existing = await db.run(SELECT.one.from(Accounts).where({ stakeAddress: stakeAddress }));
          if (existing) {
            return existing;
          }
          logger.debug({ stakeAddress },'[CardanoService] Indexing account via indexer');
          return await indexer.indexAccount(db, stakeAddress);
        }
      return db.run(req.query);
      });
    });
    
    this.on('GetAccountByStakeAddress', async (req: Request) => {
      const { stakeAddress } = req.data as { stakeAddress?: string };

      // validate input before business logic
      if (!stakeAddress) {
        return rejectMissing(req, 'GetAccountByStakeAddress', 'stakeAddress');
      }
      if (!isBech32StakeAddress(stakeAddress)) {
        return rejectInvalid(req, 'GetAccountByStakeAddress', 'Invalid stakeAddress format', 'stakeAddress');
      }

      return handleRequest(req, async (db) => {
        const existing = await db.run(
          SELECT.one.from(Accounts).where({ stakeAddress }),
        );
        if (existing) { 
          return existing
        }
        logger.debug({ stakeAddress },'[CardanoService] Indexing account via indexer');
        return await indexer.indexAccount(db, stakeAddress);
      });
    });
    // ------------------------------------------------------------------------
    // Dreps READ & GetDrepById Action
    // ------------------------------------------------------------------------
    this.on('READ', Dreps, async (req: Request) => {
      const drepId = (req.data as { drepId?: string })?.drepId;
      // validate drepID format before business logic
      if (drepId && !isDrepId(drepId)) {
        return rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');
      }
      // Proceed with handling the request
      return handleRequest(req, async (db) => {
        if (drepId) {
          const existing = await db.run(SELECT.one.from(Dreps).where({ drepId: drepId }));
          if (existing) {
            return existing;
          }
          logger.debug({ drepId },'[CardanoService] Indexing drep via indexer');
          return await indexer.indexDrep(db, drepId);
        }
      return db.run(req.query);}); 
    });
    
    this.on('GetDrepById', async (req: Request) => {
      const drepId  = (req.data as { drepId?: string }).drepId;

      // Validate input before business logic
      if (drepId && !isDrepId(drepId)) {
        return rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');
      }
      // Proceed with handling the request
      return handleRequest(req, async (db) => {
        if (drepId) {
          const existing = await db.run( SELECT.one.from(Dreps).where({ drepId }));
        if (existing) {
          return existing;
        }
         logger.debug({ drepId },'[CardanoService] Indexing drep via indexer');
         return await indexer.indexDrep(db, drepId);
        }
      });
    });

    // ------------------------------------------------------------------------
    // Addresses READ & GetAddressByBech32 Action
    // ------------------------------------------------------------------------
    this.on('READ', Addresses, async (req: Request) => {
      const addr = (req.data as { address?: string })?.address;

      // Validate address format before business logic
      if (addr && !isBech32Address(addr)) {
        return rejectInvalid(req, 'Addresses', 'Invalid bech32 address format', 'address');
      }
      // Proceed with handling the request
      return handleRequest(req, async (db) => {
        if (addr) {
          const existing = await db.run(
            SELECT.one.from(Addresses).where({ address: addr }),
          );
          if (existing) {
            return existing;
          }
          logger.debug({ address: addr }, '[CardanoService] Indexing address');
          return await indexer.indexAddress(db, addr);
        }

        return db.run(req.query);
      });
    });

    this.on('GetAddressByBech32', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetAddressByBech32', 'address');
      }
      if (!isBech32Address(address)) {
        return rejectInvalid(req, 'GetAddressByBech32', 'Invalid bech32 address format', 'address');
      }

      return handleRequest(req, async (db) => {
        const existing = await db.run(
          SELECT.one.from(Addresses).where({ address }),
        );
        if (existing) return existing;

        const addrRow = await indexer.indexAddress(db, address);
        return addrRow;
      });
    });

    // ------------------------------------------------------------------------
    // AddressAssets READ & GetAssetsByAddress Action
    // ------------------------------------------------------------------------
    this.on('READ', AddressAssets, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    this.on('GetAssetsByAddress', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // Validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetAssetsByAddress', 'address');
      }

      return handleRequest(req, async (db) => {
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

    // ------------------------------------------------------------------------
    // AddressUTxOs READ & GetUTxOsByAddress Action
    // ------------------------------------------------------------------------
    this.on('READ', AddressUTxOs, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    this.on('GetUTxOsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };

    if (!address) {
      return rejectMissing(req, 'GetUTxOsByAddress', 'address');
    }
    if (!isBech32Address(address)) {
      return rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');
    }

  return handleRequest(req, async (db) => {
    const existing = await db.run(
      SELECT.from(AddressUTxOs).where({ address }),
    );

    if (existing && existing.length > 0) {
      return existing;
    }

    logger.debug({ address }, '[CardanoService] Indexing address via indexer');
    return indexer.indexAddress(db, address);
  });
});
    // ------------------------------------------------------------------------
    // UTxOAssets READ
    // ------------------------------------------------------------------------
    this.on('READ', UTxOAssets, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });
    
    // ------------------------------------------------------------------------
    // Transactions READ & GetTransactionByHash Action
    // ------------------------------------------------------------------------
    this.on('READ', Transactions, async (req: Request) => {
      const txHash = (req.data as { hash?: string })?.hash;

      // validate transaction hash format before business logic
      if (txHash && !isTxHash(txHash)) {
        return rejectInvalid(req, 'Transactions', 'Invalid transaction hash format', 'hash');
      }
      return handleRequest(req, async (db) => {
        if (txHash) {
          const existing = await db.run(
            SELECT.one.from(Transactions).where({ hash: txHash }),
          );
          if (existing) return existing;
          logger.debug({ txHash },'[CardanoService] Indexing transaction via indexer');
          return await indexer.indexTransaction(db, txHash);
        }
        return db.run(req.query);
      });
    });

    this.on('GetTransactionByHash', async (req: Request) => {
      const { hash } = req.data as { hash?: string };

      // Validate input before business logic
      if (!hash) {
        return rejectMissing(req, 'GetTransactionByHash', 'hash');
      }
      if (!isTxHash(hash)) {
        return rejectInvalid(req, 'GetTransactionByHash', 'Invalid transaction hash format', 'hash');
      }

      return handleRequest(req, async (db) => {
        const existing = await db.run(
          SELECT.one.from(Transactions).where({ hash }));
        if (existing) return existing;
        logger.debug({ hash },'[CardanoService] Indexing transaction via indexer');
        return await indexer.indexTransaction(db, hash);
      });
    });
    // ------------------------------------------------------------------------
    // TransactionInputs READ 
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputs, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionOutputs READ
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputs, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionInputAssets READ
    // ------------------------------------------------------------------------
    this.on('READ', TransactionInputAssets, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // TransactionOutputAssets READ
    // ------------------------------------------------------------------------
    this.on('READ', TransactionOutputAssets, async (req: Request) => {
      return handleRequest(req, (db) => db.run(req.query));
    });

    // ------------------------------------------------------------------------
    // Metadata READ & GetMetadataByTxHash / GetMetadataLabelTransactions Actions
    // ------------------------------------------------------------------------
    this.on('READ', TransactionMetadata, async (req: Request) => {
      const { tx_hash } = req.data as { tx_hash?: string };
      
      if (tx_hash && !isTxHash(tx_hash)) {
        return rejectInvalid(req, 'TransactionMetadata', 'Invalid transaction hash format', 'hash');
      }

      return handleRequest(req, async (db) => {
        if (tx_hash) {
          const existing = await db.run(SELECT.one.from(TransactionMetadata).where({ tx_hash: tx_hash }));
  
          if(existing) return existing;
          
          logger.debug({ tx_hash },'[CardanoService] Indexing transaction metadata via indexer');
          return await indexer.indexTransactionMetadata(db, tx_hash);
         
        }
        return await db.run(req.query);
      });
    });

    this.on('GetMetadataByTxHash', async (req: Request) => {
      const { tx_hash } = req.data as { tx_hash?: string };

      // Validate input before business logic
      if (!tx_hash) {
        return rejectMissing(req, 'GetMetadataByTxHash', 'tx_hash');
      }
      if (!isTxHash(tx_hash)) {
        return rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'tx_hash');
      }

      return handleRequest(req, async (db) => {
        if (tx_hash) {
        const existing = await db.run(
          SELECT.from(TransactionMetadata).where({ tx_hash: tx_hash }),
        );
        if (existing && existing.length > 0) return existing;
        logger.debug({ tx_hash },'[CardanoService] Indexing transaction metadata via indexer');
        return await indexer.indexTransactionMetadata(db, tx_hash);
        }
      });
    });

    return super.init();
  }
}

