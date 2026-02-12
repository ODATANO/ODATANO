import cds, { Request } from '@sap/cds';
import { getCardanoIndexer } from './server';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber } from './utils/validators';
import { rejectInvalid, rejectMissing } from './utils/errors';
import { handleRequest, passthroughRead } from './utils/backend-request-handler';

const { SELECT } = cds.ql;

const logger = cds.log(`CardanoService`);

// ---------------------------------------------------------------------------
// Handler Factories - Eliminate duplication in index-on-miss patterns
// ---------------------------------------------------------------------------

type IndexFn = (db: any, key: any) => Promise<any>;
type ValidateFn = ((v: any) => boolean);

/**
 * Factory: READ handler with index-on-miss behavior.
 * If a key is provided, checks cache first; indexes if missing.
 * If no key, passes through to generic req.query.
 */
function indexOnMissRead(
  entity: any,
  reqKeyField: string,
  validate: ValidateFn | null,
  indexFn: IndexFn,
  options?: { entityKeyField?: string; errorMessage?: string }
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  return async (req: Request) => {
    const key = (req.data as any)?.[reqKeyField];
    if (key && validate && !validate(key))
      rejectInvalid(req, dbKey, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      if (key) {
        const existing = await db.run(SELECT.one.from(entity).where({ [dbKey]: key }));
        if (!existing) return await indexFn(db, key);
        return existing;
      }
      return db.run(req.query);
    });
  };
}

/**
 * Factory: Action handler with required key validation and index-on-miss.
 */
function indexOnMissAction(
  actionName: string,
  entity: any,
  reqKeyField: string,
  validate: ValidateFn,
  indexFn: IndexFn,
  options?: { entityKeyField?: string; errorMessage?: string }
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  return async (req: Request) => {
    const key = (req.data as any)?.[reqKeyField];
    if (key == null) rejectMissing(req, actionName, reqKeyField);
    if (!validate(key)) rejectInvalid(req, actionName, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(entity).where({ [dbKey]: key }));
      if (!existing) return await indexFn(db, key);
      return existing;
    });
  };
}

// ---------------------------------------------------------------------------
// Service Registration
// ---------------------------------------------------------------------------

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

  // Helper: shorthand for indexer access
  const indexer = () => getCardanoIndexer();

  // ---------------------------------------------------------------------------
  // Network Information (singleton - no key field)
  // ---------------------------------------------------------------------------

  srv.on('READ', NetworkInformation, async (req: Request) => {
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (!existing) return await indexer().indexNetworkInformation(db);
      return existing;
    });
  });

  srv.on('GetNetworkInformation', async (req: Request) => {
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(NetworkInformation));
      if (!existing) return await indexer().indexNetworkInformation(db);
      return existing;
    });
  });

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  srv.on('READ', Blocks, indexOnMissRead(Blocks, 'hash', isBlockHash, (db, h) => indexer().indexBlock(db, h)));
  srv.on('GetBlockByHash', indexOnMissAction('GetBlockByHash', Blocks, 'hash', isBlockHash, (db, h) => indexer().indexBlock(db, h)));

  srv.on('GetLatestBlock', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexLatestBlock(db));
  });

  // ---------------------------------------------------------------------------
  // Epochs
  // ---------------------------------------------------------------------------

  srv.on('READ', Epochs, indexOnMissRead(Epochs, 'epoch', isEpochNumber, (db, e) => indexer().indexEpoch(db, e), { errorMessage: 'epochNumber has invalid format' }));
  srv.on('GetEpochByNumber', indexOnMissAction('GetEpochByNumber', Epochs, 'epochNumber', isEpochNumber, (db, e) => indexer().indexEpoch(db, e), { entityKeyField: 'epoch', errorMessage: 'epochNumber has invalid format' }));

  srv.on('GetLatestEpoch', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexLatestEpoch(db));
  });

  // ---------------------------------------------------------------------------
  // Pools
  // ---------------------------------------------------------------------------

  srv.on('READ', Pools, indexOnMissRead(Pools, 'poolId', isValidPoolId, (db, p) => indexer().indexPool(db, p)));
  srv.on('GetPoolById', indexOnMissAction('GetPoolById', Pools, 'poolId', isValidPoolId, (db, p) => indexer().indexPool(db, p)));

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  srv.on('READ', Accounts, indexOnMissRead(Accounts, 'stakeAddress', isValidBech32StakeAddress, (db, s) => indexer().indexAccount(db, s)));
  srv.on('GetAccountByStakeAddress', indexOnMissAction('GetAccountByStakeAddress', Accounts, 'stakeAddress', isValidBech32StakeAddress, (db, s) => indexer().indexAccount(db, s)));

  // ---------------------------------------------------------------------------
  // Dreps
  // ---------------------------------------------------------------------------

  srv.on('READ', Dreps, indexOnMissRead(Dreps, 'drepId', isValidDrepId, (db, d) => indexer().indexDrep(db, d)));
  srv.on('GetDrepById', indexOnMissAction('GetDrepById', Dreps, 'drepId', isValidDrepId, (db, d) => indexer().indexDrep(db, d)));

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  srv.on('READ', Addresses, indexOnMissRead(Addresses, 'address', isValidBech32Address, (db, a) => indexer().indexAddress(db, a), { errorMessage: 'Invalid bech32 address format' }));
  srv.on('GetAddressByBech32', indexOnMissAction('GetAddressByBech32', Addresses, 'address', isValidBech32Address, (db, a) => indexer().indexAddress(db, a), { errorMessage: 'Invalid bech32 address format' }));

  srv.on('READ', AddressAssets, passthroughRead());
  srv.on('READ', AddressUTxOs, passthroughRead());

  /**
   * Action: GetAssetsByAddress - indexes parent address if needed, then queries child assets.
   */
  srv.on('GetAssetsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };
    if (!address) rejectMissing(req, 'GetAssetsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) await indexer().indexAddress(db, address);
      return db.run(SELECT.from(AddressAssets).where({ address_address: address }));
    });
  });

  /**
   * Action: GetUTxOsByAddress - indexes parent address if needed, then queries child UTxOs.
   */
  srv.on('GetUTxOsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };
    if (!address) rejectMissing(req, 'GetUTxOsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) await indexer().indexAddress(db, address);
      return db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));
    });
  });

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  srv.on('READ', Transactions, indexOnMissRead(Transactions, 'hash', isTxHash, (db, h) => indexer().indexTransaction(db, h), { errorMessage: 'Invalid transaction hash format' }));
  srv.on('GetTransactionByHash', indexOnMissAction('GetTransactionByHash', Transactions, 'hash', isTxHash, (db, h) => indexer().indexTransaction(db, h), { errorMessage: 'Invalid transaction hash format' }));

  srv.on('READ', TransactionInputs, passthroughRead());
  srv.on('READ', TransactionOutputs, passthroughRead());
  srv.on('READ', TransactionInputAssets, passthroughRead());
  srv.on('READ', TransactionOutputAssets, passthroughRead());

  // ---------------------------------------------------------------------------
  // Transaction Metadata
  // ---------------------------------------------------------------------------

  srv.on('READ', TransactionMetadata, indexOnMissRead(TransactionMetadata, 'tx_hash', isTxHash, (db, h) => indexer().indexTransactionMetadata(db, h), { errorMessage: 'Invalid transaction hash format' }));

  /**
   * Action: GetMetadataByTxHash - returns multiple metadata rows (uses SELECT.from, not SELECT.one).
   */
  srv.on('GetMetadataByTxHash', async (req: Request) => {
    const { tx_hash } = req.data as { tx_hash?: string };
    if (!tx_hash) rejectMissing(req, 'GetMetadataByTxHash', 'tx_hash');
    if (!isTxHash(tx_hash)) rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'tx_hash');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash }));
      if (!existing || existing.length === 0) {
        return await indexer().indexTransactionMetadata(db, tx_hash);
      }
      return existing;
    });
  });

  // ---------------------------------------------------------------------------
  // Protocol Parameters (singleton)
  // ---------------------------------------------------------------------------

  srv.on('READ', LedgerProtocolParameters, async (req: Request) => {
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(LedgerProtocolParameters));
      if (!existing) return indexer().indexProtocolParameters(db);
      return existing;
    });
  });

  srv.on('GetLedgerProtocolParameters', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexProtocolParameters(db));
  });

  // ---------------------------------------------------------------------------
  // Address Transactions
  // ---------------------------------------------------------------------------

  srv.on('GetLatestTransactionsByAddress', async (req: Request) => {
    const { address, limit } = req.data as { address?: string, limit?: number };
    if (!address) rejectMissing(req, 'GetLatestTransactionsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetLatestTransactionsByAddress', 'Invalid bech32 address format', 'address');
    const txLimit = limit && limit > 0 ? limit : 10;

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.from(AddressTransactions).where({ address }).limit(txLimit));
      if (!existing || existing.length === 0) {
        return indexer().indexAddressTransactions(db, address, txLimit);
      }
      return existing;
    });
  });

  logger.debug('All handlers registered');
};
