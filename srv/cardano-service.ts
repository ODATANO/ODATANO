import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber } from './utils/validators';
import { rejectInvalid, rejectMissing } from './utils/errors';
import logger from './utils/logger';
import { handleRequest } from './utils/backend-request-handler';
import { hash } from 'crypto';

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
          return await indexer.indexBlock(db, hash);
        }
        return row;});
    });

    // ------------------------------------------------------------------------
    // Epoch READ & GetEpochByNumber Action
    // ------------------------------------------------------------------------
    this.on('READ', Epochs, async (req: Request) => {
      const epochNumber = (req.data as { epoch?: number })?.epoch;
      // validate input before business logic
      if ( epochNumber && !isEpochNumber(epochNumber)) {
        return rejectInvalid(req, 'Epochs', 'epochNumber has invalid format', 'epochNumber');
      }
      return handleRequest(req, async (db) => {
        if (epochNumber) {
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
      if (!isEpochNumber(epochNumber)) {
        return rejectInvalid(req, 'Epochs', 'epochNumber has invalid format', 'epochNumber');
      }
      return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Epochs).where({ epoch: epochNumber }));
        if (!row) {
          return await indexer.indexEpoch(db, epochNumber);
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
      if (poolId && !isValidPoolId(poolId)) {
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

      if (!poolId) {
        return rejectMissing(req, 'Pools', 'poolId');
      }
      // validate input before business logic
      if (poolId && !isValidPoolId(poolId)) {
        return rejectInvalid(req, 'Pools', 'Invalid poolId format', 'poolId');
      }
      return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Pools).where({ poolId }));
          if (!row) {
            logger.debug({ poolId },'[CardanoService] Indexing pool via indexer');
            return await indexer.indexPool(db, poolId);
          }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // Accounts READ & GetAccountByStakeAddress Action
    // ------------------------------------------------------------------------
    this.on('READ', Accounts, async (req: Request) => {
      const stakeAddress = (req.data as { stakeAddress?: string })?.stakeAddress;

      // validate stake address format before business logic
      if (stakeAddress && !isValidBech32StakeAddress(stakeAddress)) {
        return rejectInvalid(req, 'Accounts', 'Invalid stakeAddress format', 'stakeAddress');
      }
      return handleRequest(req, async (db) => {
        if (stakeAddress) {
          let row = await db.run(SELECT.one.from(Accounts).where({ stakeAddress: stakeAddress }));
          if (!row) {
            logger.debug({ stakeAddress },'[CardanoService] Indexing account via indexer');
            return await indexer.indexAccount(db, stakeAddress);
          }
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
      if (!isValidBech32StakeAddress(stakeAddress)) {
        return rejectInvalid(req, 'GetAccountByStakeAddress', 'Invalid stakeAddress format', 'stakeAddress');
      }

      return handleRequest(req, async (db) => {
        let row = await db.run(
          SELECT.one.from(Accounts).where({ stakeAddress }),
        );
        if (row) { 
          return row;
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
      if (drepId && !isValidDrepId(drepId)) {
        return rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');
      }
      // proceed with handling the request
      return handleRequest(req, async (db) => {
        if (drepId) {
          const low = await db.run(SELECT.one.from(Dreps).where({ drepId: drepId }));
          if (!low) {
            logger.debug({ drepId },'[CardanoService] Indexing drep via indexer');
            return await indexer.indexDrep(db, drepId);
          }
        }
      return db.run(req.query);}); 
    });
    
    this.on('GetDrepById', async (req: Request) => {
      const drepId  = (req.data as { drepId?: string }).drepId;

      // validate input before business logic
      if (!drepId) {
        return rejectMissing(req, 'Dreps', 'drepId');
      }
      if (drepId && !isValidDrepId(drepId)) {
        return rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');
      }
      // proceed with handling the request
      return handleRequest(req, async (db) => {
        let row = await db.run( SELECT.one.from(Dreps).where({ drepId }));
        if (!row) {
         logger.debug({ drepId },'[CardanoService] Indexing drep via indexer');
         return await indexer.indexDrep(db, drepId);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // Addresses READ & GetAddressByBech32 Action
    // ------------------------------------------------------------------------
    this.on('READ', Addresses, async (req: Request) => {
      const addr = (req.data as { address?: string })?.address;

      // Validate address format before business logic
      if (addr && !isValidBech32Address(addr)) {
        return rejectInvalid(req, 'Addresses', 'Invalid bech32 address format', 'address');
      }
      // Proceed with handling the request
      return handleRequest(req, async (db) => {
        if (addr) {
          let row = await db.run(
            SELECT.one.from(Addresses).where({ address: addr }),
          );
          if (!row) {
            logger.debug({ address: addr }, '[CardanoService] Indexing address');
            return await indexer.indexAddress(db, addr);
          }
          return row;
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
      if (!isValidBech32Address(address)) {
        return rejectInvalid(req, 'GetAddressByBech32', 'Invalid bech32 address format', 'address');
      }

      return handleRequest(req, async (db) => {
        let row = await db.run( SELECT.one.from(Addresses).where({ address }));
        if (!row){
          return await indexer.indexAddress(db, address);
        }
        return row;
      });
    });

    // ------------------------------------------------------------------------
    // AddressAssets READ & GetAssetsByAddress Action
    // ------------------------------------------------------------------------
    this.on('READ', AddressAssets, async (req: Request) => {
      const addr = (req.data as { address?: string })?.address;
      // Validate address format before business logic
      if (addr && !isValidBech32Address(addr)) {
        return rejectInvalid(req, 'AddressAssets', 'Invalid bech32 address format', 'address');
      }
      return handleRequest(req, async (db) => {
        if (addr) {
          let rows = await db.run(
            SELECT.from(AddressAssets).where({ address: addr }),
          );
          logger.debug({ address: addr }, '[CardanoService] Indexing address via indexer');
          await indexer.indexAddress(db, addr);
          // retrieve the assets after indexing
          return await db.run(SELECT.from(AddressAssets).where({ address: addr }));
        }
        return db.run(req.query);
      });
    });

    this.on('GetAssetsByAddress', async (req: Request) => {
      const { address } = req.data as { address?: string };

      // Validate input before business logic
      if (!address) {
        return rejectMissing(req, 'GetAssetsByAddress', 'address');
      }
      if (!isValidBech32Address(address)) {
        return rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');
      }

      return handleRequest(req, async (db) => {
        let rows = await db.run(SELECT.from(AddressAssets).where({ address }));
        if (!rows || rows.length === 0) {
          await indexer.indexAddress(db, address);
          return db.run(SELECT.from(AddressAssets).where({ address }));
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
      if (!isValidBech32Address(address)) {
        return rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');
      }
      return handleRequest(req, async (db) => {
        const row = await db.run(SELECT.from(AddressUTxOs).where({ address }));
        console.log('Database address UTxOs data:', row);
        if (row && row.length > 0) return row;
        console.log('Indexing address via indexer for address:', address);
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
          const row = await db.run(
            SELECT.one.from(Transactions).where({ hash: txHash }),
          );
          if (row) return row;
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
      console.log('Handling GetTransactionByHash for hash:', hash);
      return handleRequest(req, async (db) => {
        const row = await db.run(
          SELECT.one.from(Transactions).where({ hash }));
        if (row) return row;
        console.log('Indexing transaction via indexer for hash:', hash);
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
          const rows = await db.run(SELECT.one.from(TransactionMetadata).where({ tx_hash: tx_hash }));
          if(rows) return rows;
          logger.debug({ tx_hash },'[CardanoService] Indexing transaction metadata via indexer');
          return await indexer.indexTransactionMetadata(db, tx_hash);
        }
        return await db.run(req.query);
      });
    });

    this.on('GetMetadataByTxHash', async (req: Request) => {
      const { tx_hash } = req.data as { tx_hash?: string };

      // validate input before business logic
      if (!tx_hash) {
        return rejectMissing(req, 'GetMetadataByTxHash', 'tx_hash');
      }
      if (!isTxHash(tx_hash)) {
        return rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'tx_hash');
      }
      return handleRequest(req, async (db) => {
        let rows = await db.run(
          SELECT.from(TransactionMetadata).where({ tx_hash: tx_hash }),
        );
        if (rows && rows.length > 0) return rows;
          logger.debug({ tx_hash },'[CardanoService] Indexing transaction metadata via indexer');
          return await indexer.indexTransactionMetadata(db, tx_hash);
        });
    });

    return super.init();
  }
}

