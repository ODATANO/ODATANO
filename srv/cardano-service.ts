import cds, { Request } from '@sap/cds';
import { getCardanoIndexer } from './server';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber } from './utils/validators';
import { rejectInvalid, rejectMissing } from './utils/errors';
import { handleRequest } from './utils/backend-request-handler';

const { SELECT } = cds.ql;

const logger = cds.log(`CardanoService`);

/**
 * Cardano Service Implementation
 * Handles various Cardano blockchain data queries with index-on-miss behavior.
 */
module.exports = (srv: cds.Service) => {
  logger.debug('[CardanoService] Module loaded - registering handlers');

  const {
    NetworkInformation,
    Blocks,
    Epochs,
    Addresses,
    AddressAssets,
    AddressUTxOs,
    Transactions,
    TransactionInputs,
    TransactionOutputs,
    TransactionInputAssets,
    TransactionOutputAssets,
    TransactionMetadata,
    Pools,
    Accounts,
    Dreps,
    LedgerProtocolParameters,
    AddressTransactions
  } = require('#cds-models/CardanoODataService');

  /**
   * READ handler for `NetworkInformation`.
   * Cache-first read; indexes network information on first access.
   * @param req - The incoming request data
   * @returns {NetworkInformation} The current valid general network information
   */
  srv.on('READ', NetworkInformation, async (req: Request) => {
    logger.debug(`NetworkInformation READ handler called`);
    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (!existing) {
        logger.debug('Indexing network information via indexer');
        return await getCardanoIndexer().indexNetworkInformation(db);
      }
      return existing;
    });
  });

  /**
   * Action handler for `GetNetworkInformation`.
   * Returns network information; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {NetworkInformation} The current valid general network information
   */
  srv.on('GetNetworkInformation', async (req: Request) => {
    logger.debug('GetNetworkInformation Action handler called');
    // handle the action request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (!existing) {
        logger.debug('Indexing network information via indexer');
        return await getCardanoIndexer().indexNetworkInformation(db);
      }
      return existing;
    });
  });

  /**
   * READ handler for `Blocks`.
   * Supports lookup by block hash with index-on-miss behavior.
   * @param req - The incoming request data
   * @returns {Blocks} The block data for the requested block or all fitting blocks for general read
   */
  srv.on('READ', Blocks, async (req: Request) => {
    logger.debug(`Blocks READ handler called`);
    // get possible hash for single block lookup
    const hash = (req.data as { hash?: string })?.hash;

    // validate input before business logic
    if (hash && !isBlockHash(hash)) rejectInvalid(req, 'Blocks', 'Invalid hash format', 'hash');


    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (hash) {
        const existing = await db.run(SELECT.one.from(Blocks).where({ hash: hash }));
        if (!existing) {
          logger.debug({ hash: hash }, 'Indexing block via indexer');
          return await getCardanoIndexer().indexBlock(db, hash);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetBlockByHash`.
   * Returns a block by hash; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Blocks} The block data for the requested block
   */
  srv.on('GetBlockByHash', async (req: Request) => {
    logger.debug(`GetBlockByHash Action handler called`);
    const hash = (req.data?.hash as string | undefined) ?? undefined;

    // validate input before business logic
    if (!hash) rejectMissing(req, 'Blocks', 'hash');
    if (!isTxHash(hash)) rejectInvalid(req, 'Blocks', 'hash has invalid format', 'hash');

    // handle the action request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Blocks).where({ hash: hash }));
      if (!existing) {
        logger.debug({ hash: hash }, 'Indexing block via indexer');
        return await getCardanoIndexer().indexBlock(db, hash);
      }
      return existing;
    });
  });

  /** 
   * Action handler for `GetLatestBlock`.
   * Returns the latest block; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Blocks} The latest block data
   */
  srv.on('GetLatestBlock', async (req: Request) => {
    return handleRequest(req, async (db) => {
      return await getCardanoIndexer().indexLatestBlock(db);
    });
  });

  /**
   * READ handler for `Epochs`.
   * Supports lookup by epoch number with index-on-miss behavior or all epochs fitting general read.
   * @param req - The incoming request data
   * @returns {Epochs} The epoch data for the requested epoch or all fitting epochs for general read
   */
  srv.on('READ', Epochs, async (req: Request) => {

    logger.debug('[CardanoService] Epochs READ handler called');
    const epochNumber = (req.data as { epoch?: number })?.epoch;

    // validate input before business logic
    if (epochNumber && !isEpochNumber(epochNumber))
      rejectInvalid(req, 'Epochs', `epochNumber has invalid format (${String(epochNumber)})`, 'epochNumber');

    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (epochNumber) {
        const existing = await db.run(SELECT.one.from(Epochs).where({ epoch: epochNumber }));
        if (!existing) {
          logger.debug({ epochNumber }, 'Indexing epoch via indexer');
          return await getCardanoIndexer().indexEpoch(db, epochNumber);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetEpochByNumber`.
   * Returns an epoch by number; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Epochs} The epoch data for the requested epoch
   */
  srv.on('GetEpochByNumber', async (req: Request) => {
    logger.debug('GetEpochByNumber Action handler called');
    const epochNumber = req.data?.epochNumber as Number | undefined;

    // validate input before business logic
    if (epochNumber == null) rejectMissing(req, 'Epochs', 'epochNumber');

    if (!isEpochNumber(epochNumber))
      rejectInvalid(req, 'Epochs', `epochNumber has invalid format (${String(epochNumber)})`, 'epochNumber');

    // handle the action request / indexing if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Epochs).where({ epoch: epochNumber }));
      if (!existing) {
        logger.debug({ epochNumber }, 'Indexing epoch via indexer');
        return await getCardanoIndexer().indexEpoch(db, epochNumber);
      }
      return existing;
    });
  });

  /**
   * Action handler for `GetLatestEpoch`.
   * Returns the latest epoch; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Epochs} The latest epoch data
   */
  srv.on('GetLatestEpoch', async (req: Request) => {
    return handleRequest(req, async (db) => {
      return await getCardanoIndexer().indexLatestEpoch(db);
    });
  });

  /**
   * READ handler for `Pools`.
   * Supports lookup by pool id with index-on-miss behavior or all pools fitting general read.
   * @param req - The incoming request data
   * @returns {Pools} The pool data for the requested pool or all fitting pools for general read
   */
  srv.on('READ', Pools, async (req: Request) => {
    logger.debug('Pools READ handler called');
    const poolId = (req.data as { poolId?: string })?.poolId;
    
    // validate pool_id format before business logic
    if (poolId && !isValidPoolId(poolId)) rejectInvalid(req, 'Pools', 'Invalid poolId format', 'poolId');

    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (poolId) {
        const existing = await db.run(SELECT.one.from(Pools).where({ poolId: poolId }));
        if (!existing) {
          logger.debug({ poolId }, 'Indexing Pool data via indexer');
          return await getCardanoIndexer().indexPool(db, poolId);
        }
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetPoolById`.
   * Returns a pool by id; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Pools} The pool data for the requested pool
   */
  srv.on('GetPoolById', async (req: Request) => {
    const { poolId } = req.data as { poolId?: string };

    // validate input before business logic
    if (!poolId) rejectMissing(req, 'Pools', 'poolId');

    if (poolId && !isValidPoolId(poolId)) rejectInvalid(req, 'Pools', 'Invalid poolId format', 'poolId');

    // handle the action request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existent = await db.run(SELECT.one.from(Pools).where({ poolId }));
      if (!existent) {
        logger.debug({ poolId }, 'Indexing pool via indexer');
        return await getCardanoIndexer().indexPool(db, poolId);
      }
      return existent;
    });
  });

  /**
   * READ handler for `Accounts`.
   * Supports lookup by stake address with index-on-miss behavior or all accounts fitting general read.
   * @param req - The incoming request data
   * @returns {Accounts} The account data for the requested account or all fitting accounts for general read
   */
  srv.on('READ', Accounts, async (req: Request) => {
    logger.debug('Accounts READ handler called');
    const stakeAddress = (req.data as { stakeAddress?: string })?.stakeAddress;

    // validate stake address format before business logic
    if (stakeAddress && !isValidBech32StakeAddress(stakeAddress))
      rejectInvalid(req, 'Accounts', 'Invalid stakeAddress format', 'stakeAddress');

    // proceed with handling the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (stakeAddress) {
        const existing = await db.run(SELECT.one.from(Accounts).where({ stakeAddress: stakeAddress }));
        if (!existing) {
          logger.debug({ stakeAddress }, 'Indexing account via indexer');
          return await getCardanoIndexer().indexAccount(db, stakeAddress);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetAccountByStakeAddress`.
   * Returns an account by stake address; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Accounts} The account data for the requested account
   */
  srv.on('GetAccountByStakeAddress', async (req: Request) => {
    logger.debug('GetAccountByStakeAddress Action handler called');
    const { stakeAddress } = req.data as { stakeAddress?: string };

    // validate input before business logic
    if (!stakeAddress) rejectMissing(req, 'GetAccountByStakeAddress', 'stakeAddress');

    if (!isValidBech32StakeAddress(stakeAddress))
      rejectInvalid(req, 'GetAccountByStakeAddress', 'Invalid stakeAddress format', 'stakeAddress');

    // proceed with handling the request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Accounts).where({ stakeAddress }));
      if (!existing) {
        logger.debug({ stakeAddress }, '[CardanoService] Indexing account via indexer');
        return await getCardanoIndexer().indexAccount(db, stakeAddress);
      }
      return existing;
    });
  });

  /**
   * READ handler for `Dreps`.
   *  Supports lookup by drep id with index-on-miss behavior or all dreps fitting general read.
   * @param req - The incoming request data
   * @returns {Dreps} The drep data for the requested drep or all fitting dreps for general read
   */
  srv.on('READ', Dreps, async (req: Request) => {
    logger.debug('Dreps READ handler called');
    const drepId = (req.data as { drepId?: string })?.drepId;

    // validate drepID format before business logic
    if (drepId && !isValidDrepId(drepId)) rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');

    // proceed with handling the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (drepId) {
        const existing = await db.run(SELECT.one.from(Dreps).where({ drepId: drepId }));
        if (!existing) {
          logger.debug({ drepId }, 'Indexing drep via indexer');
          return await getCardanoIndexer().indexDrep(db, drepId);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetDrepById`.
   * Returns a drep by id; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Dreps} The drep data for the requested drep
   */
  srv.on('GetDrepById', async (req: Request) => {
    logger.debug('GetDrepById Action handler called');
    const drepId = (req.data as { drepId?: string }).drepId;

    // validate input before business logic
    if (!drepId) rejectMissing(req, 'Dreps', 'drepId');

    if (!isValidDrepId(drepId))
      rejectInvalid(req, 'Dreps', 'Invalid drepId format', 'drepId');

    // proceed with handling the request
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Dreps).where({ drepId }));
      if (!existing) {
        logger.debug({ drepId }, 'Indexing drep via indexer');
        return await getCardanoIndexer().indexDrep(db, drepId);
      }
      return existing;
    });
  });

  /**
   * READ handler for `Addresses`.
   * Supports lookup by bech32 address with index-on-miss behavior or all addresses fitting general read.
   * @param req - The incoming request data
   * @returns {Addresses} The address data for the requested address or all fitting addresses for general read
   */
  srv.on('READ', Addresses, async (req: Request) => {
    const addr = (req.data as { address?: string })?.address;

    // Validate address format before business logic
    if (addr && !isValidBech32Address(addr)) rejectInvalid(req, 'Addresses', 'Invalid bech32 address format', 'address');

    // Proceed with handling the request
    return handleRequest(req, async (db) => {
      if (addr) {
        const existing = await db.run(SELECT.one.from(Addresses).where({ address: addr }));
        if (!existing) {
          logger.debug({ address: addr }, 'Indexing address');
          return await getCardanoIndexer().indexAddress(db, addr);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetAddressByBech32`.
   * Returns an address by bech32; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Addresses} The address data for the requested address
   */
  srv.on('GetAddressByBech32', async (req: Request) => {
    logger.debug('GetAddressByBech32 Action handler called');
    const { address } = req.data as { address?: string };

    // validate input before business logic
    if (!address) rejectMissing(req, 'GetAddressByBech32', 'address');

    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetAddressByBech32', 'Invalid bech32 address format', 'address');

    // proceed with handling the request / indexing result if needed
    return handleRequest(req, async (db) => {
      // Check if address exists (CAP filters to valid entries automatically)
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) {
        logger.debug({ address }, 'Indexing address via indexer');
        return await getCardanoIndexer().indexAddress(db, address);
      }
      return existing;
    });
  });

  /**
   * READ handler for `AddressAssets`.
   * Supports lookup by bech32 address with index-on-miss behavior or all address assets fitting general read.
   * @param req - The incoming request data
   * @returns {AddressAssets} The address asset data for the requested address or all fitting address assets for general read
   */
  srv.on('READ', AddressAssets, async (req: Request) => {
    logger.debug('AddressAssets READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * Action handler for `GetAssetsByAddress`.
   * Returns address assets by bech32 address; indexes the address if not yet present.
   * @param req - The incoming request data
   * @returns {AddressAssets} The address asset data for the requested address
   */
  srv.on('GetAssetsByAddress', async (req: Request) => {
    logger.debug('GetAssetsByAddress Action handler called');
    const { address } = req.data as { address?: string };

    // Validate input before business logic
    if (!address) rejectMissing(req, 'GetAssetsByAddress', 'address');

    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      // Check if address exists (CAP filters to valid entries automatically)
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) {
        logger.debug({ address }, 'Indexing address via indexer');
        await getCardanoIndexer().indexAddress(db, address);
      }
      return db.run(SELECT.from(AddressAssets).where({ address_address: address }));
    });
  });

  /**
   * READ handler for `AddressUTxOs`.
   * Supports lookup by bech32 address with index-on-miss behavior or all address UTxOs fitting general read.
   * @param req - The incoming request data
   * @returns {AddressUTxOs} The address UTxO data for the requested address or all fitting address UTxOs for general read
   */
  srv.on('READ', AddressUTxOs, async (req: Request) => {
    logger.debug('AddressUTxOs READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * Action handler for `GetUTxOsByAddress`.
   * Returns address UTxOs by bech32 address; indexes the address if not yet present.
   * @param req - The incoming request data
   * @returns {AddressUTxOs} The address UTxO data for the requested address
   */
  srv.on('GetUTxOsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };

    // validate input before business logic
    if (!address) rejectMissing(req, 'GetUTxOsByAddress', 'address');

    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      // Check if address exists (CAP filters to valid entries automatically)
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) {
        logger.debug({ address }, 'Indexing address via indexer');
        await getCardanoIndexer().indexAddress(db, address);
      }
      return db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));
    });
  });

  /**
   * READ handler for `Transactions`.
   * Supports lookup by transaction hash with index-on-miss behavior or all transactions fitting general read.
   * @param req - The incoming request data
   * @returns {Transactions} The transaction data for the requested transaction or all fitting transactions for general read
   */
  srv.on('READ', Transactions, async (req: Request) => {
    logger.debug('Transactions READ handler called');
    const txHash = (req.data as { hash?: string })?.hash;

    // validate input before business logic
    if (txHash && !isTxHash(txHash))
      rejectInvalid(req, 'Transactions', 'Invalid transaction hash format', 'hash');

    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (txHash) {
        const existing = await db.run(SELECT.one.from(Transactions).where({ hash: txHash }));
        if (!existing) {
          logger.debug({ txHash }, 'Indexing transaction via indexer');
          return await getCardanoIndexer().indexTransaction(db, txHash);
        }
        return existing;
      }
      return db.run(req.query);
    });
  });

  /**
   * Action handler for `GetTransactionByHash`.
   * Returns a transaction by hash; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {Transactions} The transaction data for the requested transaction
   */
  srv.on('GetTransactionByHash', async (req: Request) => {
    logger.debug('GetTransactionByHash Action handler called');
    const { hash } = req.data as { hash?: string };

    // validate input before business logic
    if (!hash) rejectMissing(req, 'GetTransactionByHash', 'hash');

    if (!isTxHash(hash))
      rejectInvalid(req, 'GetTransactionByHash', 'Invalid transaction hash format', 'hash');

    // handle the action request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Transactions).where({ hash }));
      if (!existing) {
        logger.debug({ hash }, 'Indexing transaction via indexer');
        return await getCardanoIndexer().indexTransaction(db, hash);
      }
      return existing;
    });
  });

  /**
   * READ handler for `TransactionInputs`.
   * @param req - The incoming request data
   * @returns {TransactionInputs} The transaction input data for the requested inputs or all fitting inputs for general read
   */
  srv.on('READ', TransactionInputs, async (req: Request) => {
    logger.debug('TransactionInputs READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * READ handler for `TransactionOutputs`.
   * @param req - The incoming request data
   * @returns {TransactionOutputs} The transaction output data for the requested outputs or all fitting outputs for general read
   */
  srv.on('READ', TransactionOutputs, async (req: Request) => {
    logger.debug('TransactionOutputs READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * READ handler for `TransactionInputAssets`.
   * @param req - The incoming request data
   * @returns {TransactionInputAssets} The transaction input asset data for the requested input assets or all fitting input assets for general read
   */
  srv.on('READ', TransactionInputAssets, async (req: Request) => {
    logger.debug('TransactionInputAssets READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * READ handler for `TransactionOutputAssets`.
   * @param req - The incoming request data
   * @returns {TransactionOutputAssets} The transaction output asset data for the requested output assets or all fitting output assets for general read
   */
  srv.on('READ', TransactionOutputAssets, async (req: Request) => {
    logger.debug('TransactionOutputAssets READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * READ handler for `TransactionMetadata`.
   * Supports lookup by transaction hash with index-on-miss behavior or all transaction metadata fitting general read.
   * @param req - The incoming request data
   * @returns {TransactionMetadata} The transaction metadata for the requested transaction or all fitting transaction metadata for general read
   */
  srv.on('READ', TransactionMetadata, async (req: Request) => {
    logger.debug('TransactionMetadata READ handler called');
    const { tx_hash } = req.data as { tx_hash?: string };

    // validate input before business logic
    if (tx_hash && !isTxHash(tx_hash))
      rejectInvalid(req, 'TransactionMetadata', 'Invalid transaction hash format', 'hash');

    // handle the request / indexing if needed
    return handleRequest(req, async (db) => {
      if (tx_hash) {
        const existing = await db.run(SELECT.one.from(TransactionMetadata).where({ tx_hash: tx_hash }));
        if (!existing) {
          logger.debug({ tx_hash }, 'Indexing transaction metadata via indexer');
          return await getCardanoIndexer().indexTransactionMetadata(db, tx_hash);
        }
        return existing;
      }
      return await db.run(req.query);
    });
  });

  /**
   * Action handler for `GetMetadataByTxHash`.
   * Returns transaction metadata by transaction hash; indexes it if not yet present.
   * @param req - The incoming request data
   * @returns {TransactionMetadata} The transaction metadata for the requested transaction
   */
  srv.on('GetMetadataByTxHash', async (req: Request) => {
    logger.debug('GetMetadataByTxHash Action handler called');
    const { tx_hash } = req.data as { tx_hash?: string };

    // validate input before business logic
    if (!tx_hash) rejectMissing(req, 'GetMetadataByTxHash', 'tx_hash');

    if (!isTxHash(tx_hash)) rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'tx_hash');

    // handle the action request / indexing result if needed
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash: tx_hash }));
      if (!existing || existing.length == 0) {
        logger.debug({ tx_hash }, '[CardanoService] Indexing transaction metadata via indexer');
        return await getCardanoIndexer().indexTransactionMetadata(db, tx_hash);
      }
      return existing;
    });
  });

  /**
   * READ handler for `LedgerProtocolParameters`.
   * @param req - The incoming request data
   * @returns {LedgerProtocolParameters} The ledger protocol parameters data
   */
  srv.on('READ', LedgerProtocolParameters, async (req: Request) => {
    logger.debug('[CardanoService] LedgerProtocolParameters READ handler called');
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(LedgerProtocolParameters));
      if (!existing) {
        logger.debug('[CardanoService] Indexing protocol parameters via indexer');
        return getCardanoIndexer().indexProtocolParameters(db);
      }
      return existing;
    });
  });

  /** 
   * Action handler for `GetLedgerProtocolParameters`.
   * Returns ledger protocol parameters; indexes them if not yet present.
   * @param req -  The incoming request data
   * @returns {LedgerProtocolParameters} Protocol Parameters 
   */
  srv.on('GetLedgerProtocolParameters', async (req: Request) => {
    logger.debug('GetLedgerProtocolParameters Action handler called');
    return handleRequest(req, async (db) => {
      logger.debug('Indexing protocol parameters via indexer');
      return getCardanoIndexer().indexProtocolParameters(db);
    });
  });

  /**
   * Action handler for `GetLatestTransactionsByAddress`.
   * Returns latest transactions for a given address; indexes them if not yet present.
   * @param req - The incoming request data
   * @returns {AddressTransactions} The latest transactions for the requested address
   */
  srv.on('GetLatestTransactionsByAddress', async (req: Request) => {
    logger.debug('GetLatestTransactionsByAddress Action handler called');
    const { address, limit } = req.data as { address?: string, limit?: number };
    // Validate input before business logic
    if (!address) rejectMissing(req, 'GetLatestTransactionsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetLatestTransactionsByAddress', 'Invalid bech32 address format', 'address');
    const txLimit = limit && limit > 0 ? limit : 10; // Default limit to 10 if not provided or invalid
    return handleRequest(req, async (db) => {
      // Check if address transactions exist
      const existing = await db.run(SELECT.from(AddressTransactions).where({ address }).limit(txLimit));
      if (!existing || existing.length === 0) {
        logger.debug({ address }, 'Indexing address via indexer');
        return getCardanoIndexer().indexAddressTransactions(db, address, txLimit);
      }
      return existing;
    });
  });
  logger.debug('All handlers registered');
};
