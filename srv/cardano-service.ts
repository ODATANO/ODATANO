import cds, { Request } from '@sap/cds';
import { getCardanoIndexer } from './server';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber, isValidTxCborHex, isValidCredential, isAssetUnit } from './utils/validators';
import { rejectInvalid, rejectMissing, AllBackendsFailedError } from './utils/errors';
import { handleRequest} from './utils/backend-request-handler';
import { parseTransaction } from './cbor';

const { SELECT } = cds.ql;

const logger = cds.log(`CardanoService`);

// ---------------------------------------------------------------------------
// Handler factories for the index-on-miss pattern
// ---------------------------------------------------------------------------

type IndexFn<K = string> = (db: cds.Transaction, key: K) => Promise<unknown>;
type ValidateFn = ((v: unknown) => boolean);

/** Upper bound of the temporal window; must outlast the slowest index-on-miss of one request. */
const TEMPORAL_WINDOW_SLACK_MS = 60 * 60 * 1000;

/**
 * Let this request see the temporal slices it writes during index-on-miss: CAP's temporal
 * filter (`validFrom < $valid.to`) defaults to a `now`..`now+1ms` window fixed at transaction
 * start, so a slice stamped after the backend fetch would be invisible to the `req.query`
 * re-read. Only the upper bound moves; explicit `sap-valid-*` options are left alone.
 * Must run before the handler's first DB statement.
 */
function widenTemporalWindow(req: Request): void {
  const q = req.http?.req?.query as Record<string, unknown> | undefined;
  if (q && (q['sap-valid-at'] || q['sap-valid-from'] || q['sap-valid-to'])) return;
  const now = Date.now();
  const from = new Date(now).toISOString();
  const to = new Date(now + TEMPORAL_WINDOW_SLACK_MS).toISOString();
  // The DB session reads the bag of whichever context opened the transaction; stamp both.
  const r = req as unknown as { _?: Record<string, unknown>; context?: { _?: Record<string, unknown> } };
  for (const bag of new Set([r._, r.context?._])) {
    if (!bag) continue;
    bag['VALID-FROM'] = from;
    bag['VALID-TO'] = to;
  }
}

/**
 * Factory: READ handler with index-on-miss. With a key, indexes on a cache miss and then
 * runs the client's own query so `$expand` / `$select` apply; without a key, passes through.
 */
function indexOnMissRead<K = string>(
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn | null,
  indexFn: IndexFn<K>,
  options?: { entityKeyField?: string; errorMessage?: string }
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  return async (req: Request) => {
    const key = (req.data as Record<string, unknown>)?.[reqKeyField];
    // Explicit null check: falsy keys such as epoch=0 or '' must still be validated.
    if (key !== undefined && key !== null && validate && !validate(key))
      rejectInvalid(req, dbKey, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      if (key !== undefined && key !== null) {
        widenTemporalWindow(req); // before the first DB statement
        // The temporal aspect hides expired rows, so a miss here triggers a re-index.
        const existing = await db.run(SELECT.one.from(entity as never).where({ [dbKey]: key }));
        if (!existing) await indexFn(db, key as K);
        // The client's query is the only authority on the result: never fall back to
        // `existing`, or an excluding $filter / second key would yield a sibling row instead of 404.
      }
      return db.run(req.query);
    });
  };
}

/** Factory: action handler with required-key validation and index-on-miss. */
function indexOnMissAction<K = string>(
  actionName: string,
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn,
  indexFn: IndexFn<K>,
  options?: { entityKeyField?: string; errorMessage?: string }
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  return async (req: Request) => {
    const key = (req.data as Record<string, unknown>)?.[reqKeyField];
    if (key == null) rejectMissing(req, actionName, reqKeyField);
    if (!validate(key)) rejectInvalid(req, actionName, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      // The temporal aspect hides expired rows, so a miss here triggers a re-index.
      const existing = await db.run(SELECT.one.from(entity as never).where({ [dbKey]: key }));
      if (!existing) return await indexFn(db, key as K);
      return existing;
    });
  };
}

// ---------------------------------------------------------------------------
// Service Registration
// ---------------------------------------------------------------------------

/** CardanoODataService handlers: blockchain read queries with index-on-miss. */
module.exports = (srv: cds.Service) => {
  logger.debug('Module loaded - registering handlers');

  // For plural-shaped names (NetworkInformation, TransactionMetadata, AssetHistory) cds-typer
  // exports the singular class under the plain name and the entity-set class with a trailing
  // underscore. Handlers must register the entity-set class; a singular one never matches under cds 10.
  const {
    NetworkInformation_: NetworkInformation,
    Blocks,
    Epochs,
    Addresses,
    AddressAssets,
    AddressUTxOs,
    Transactions,
    TransactionMetadata_: TransactionMetadata,
    Pools,
    Accounts,
    Dreps,
    Assets,
    AssetHistory_: AssetHistory,
    LedgerProtocolParameters,
    AddressTransactions
  } = require('#cds-models/CardanoODataService');

  // Fail fast on a singular class: it would silently degrade to the generic CRUD handler.
  for (const [name, entity] of Object.entries({
    NetworkInformation, Blocks, Epochs, Addresses, AddressAssets, AddressUTxOs,
    Transactions, TransactionMetadata, Pools, Accounts, Dreps, Assets, AssetHistory,
    LedgerProtocolParameters, AddressTransactions,
  })) {
    if ((entity as { is_singular?: boolean })?.is_singular) {
      throw new Error(
        `CardanoODataService: '${name}' resolves to the SINGULAR cds-typer class — ` +
        `READ handlers registered with it never match under cds 10. Destructure the ` +
        `plural entity-set class instead (e.g. '${name}_ as ${name}').`
      );
    }
  }

  const indexer = () => getCardanoIndexer();

  // ---------------------------------------------------------------------------
  // Network Information (singleton - no key field)
  // ---------------------------------------------------------------------------

  async function fetchNetworkInformation(db: cds.Transaction) {
    const existing = await db.run(SELECT.one.from(NetworkInformation));
    if (!existing) return await indexer().indexNetworkInformation(db);
    return existing;
  }

  srv.on('READ', NetworkInformation, async (req: Request) => {
    return handleRequest(req, fetchNetworkInformation);
  });

  srv.on('GetNetworkInformation', async (req: Request) => {
    return handleRequest(req, fetchNetworkInformation);
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

  srv.on('READ', Epochs, indexOnMissRead<number>(Epochs, 'epoch', isEpochNumber, (db, e) => indexer().indexEpoch(db, e), { errorMessage: 'epochNumber has invalid format' }));
  srv.on('GetEpochByNumber', indexOnMissAction<number>('GetEpochByNumber', Epochs, 'epochNumber', isEpochNumber, (db, e) => indexer().indexEpoch(db, e), { entityKeyField: 'epoch', errorMessage: 'epochNumber has invalid format' }));

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
  // Assets
  // ---------------------------------------------------------------------------

  srv.on('READ', Assets, indexOnMissRead(Assets, 'unit', isAssetUnit, (db, u) => indexer().indexAsset(db, u), { errorMessage: 'Invalid asset unit format' }));
  srv.on('GetAssetInfo', indexOnMissAction('GetAssetInfo', Assets, 'unit', isAssetUnit, (db, u) => indexer().indexAsset(db, u), { errorMessage: 'Invalid asset unit format' }));

  // ---------------------------------------------------------------------------
  // Asset History
  // ---------------------------------------------------------------------------
  // Generic READ is served from the DB only; GetAssetHistory(unit) seeds the rows.
  srv.on('READ', AssetHistory, async (req: Request) => {
    return handleRequest(req, async (db) => db.run(req.query));
  });

  // GetAssetHistory — always-fresh fetch of recent mint/burn events.
  srv.on('GetAssetHistory', async (req: Request) => {
    const { unit, limit } = req.data as { unit?: string; limit?: number };
    if (!unit) return rejectMissing(req, 'GetAssetHistory', 'unit');
    if (!isAssetUnit(unit)) {
      return rejectInvalid(req, 'GetAssetHistory', 'Invalid asset unit format', 'unit');
    }
    // Clamp: an unbounded limit would page the upstream backend indefinitely.
    const effectiveLimit = Math.min(Math.max(typeof limit === 'number' ? limit : 100, 1), 100);
    return handleRequest(req, async (db) => {
      return await indexer().indexAssetHistory(db, unit, effectiveLimit);
    });
  });

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  srv.on('READ', Addresses, indexOnMissRead(Addresses, 'address', isValidBech32Address, (db, a) => indexer().indexAddress(db, a), { errorMessage: 'Invalid bech32 address format' }));
  srv.on('GetAddressByBech32', indexOnMissAction('GetAddressByBech32', Addresses, 'address', isValidBech32Address, (db, a) => indexer().indexAddress(db, a), { errorMessage: 'Invalid bech32 address format' }));
  // GetAssetsByAddress — indexes the parent address if needed, then queries child assets.
  srv.on('GetAssetsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };
    if (!address) rejectMissing(req, 'GetAssetsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(Addresses).where({ address }));
      if (!existing) await indexer().indexAddress(db, address);
      const assets = await db.run(SELECT.from(AddressAssets).where({ address_address: address }));

      // Keep the latest temporal slice per unit
      const seen = new Map<string, any>();
      for (const asset of assets) {
        if (!seen.has(asset.unit) || asset.validFrom > seen.get(asset.unit).validFrom) {
          seen.set(asset.unit, asset);
        }
      }
      return Array.from(seen.values());
    });
  });

  // GetUTxOsByAddress — indexes the parent address if needed, then queries child UTxOs.
  srv.on('GetUTxOsByAddress', async (req: Request) => {
    const { address } = req.data as { address?: string };
    if (!address) rejectMissing(req, 'GetUTxOsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));

      if (!existing || existing.length === 0) {
        // Prefer the full address index; when no configured backend supports getAddress
        // (AllBackendsFailedError with zero collected errors, e.g. Ogmios only), fall back to a
        // UTxO-only index. getAddress is indexAddress's first call, so nothing is persisted before.
        try {
          await indexer().indexAddress(db, address);
        } catch (err: unknown) {
          if (err instanceof AllBackendsFailedError && err.errors.length === 0) {
            await indexer().indexAddressUtxos(db, address);
          } else {
            throw err;
          }
        }
        const fresh = await db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));
        return fresh;
      }

      // Keep the latest temporal slice per hash#index
      const seen = new Map<string, any>();
      for (const utxo of existing) {
        const key = `${utxo.hash}#${utxo.index}`;
        if (!seen.has(key) || utxo.validFrom > seen.get(key).validFrom) {
          seen.set(key, utxo);
        }
      }
      return Array.from(seen.values());
    });
  });

  // GetUTxOsByCredential — Koios-only, always-fresh credential-keyed UTxO query
  // (dApp state reads need current data). ProviderUnavailableError without Koios.
  srv.on('GetUTxOsByCredential', async (req: Request) => {
    const { credential } = req.data as { credential?: string };
    if (!credential) return rejectMissing(req, 'GetUTxOsByCredential', 'credential');
    if (!isValidCredential(credential)) {
      return rejectInvalid(req, 'GetUTxOsByCredential', 'Invalid payment credential — expected 56-char lowercase hex (28 bytes)', 'credential');
    }

    return handleRequest(req, async (db) => {
      return await indexer().indexCredentialUtxos(db, credential);
    });
  });

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  srv.on('READ', Transactions, indexOnMissRead(Transactions, 'hash', isTxHash, (db, h) => indexer().indexTransaction(db, h), { errorMessage: 'Invalid transaction hash format' }));
  srv.on('GetTransactionByHash', indexOnMissAction('GetTransactionByHash', Transactions, 'hash', isTxHash, (db, h) => indexer().indexTransaction(db, h), { errorMessage: 'Invalid transaction hash format' }));

  // ---------------------------------------------------------------------------
  // Transaction Metadata
  // ---------------------------------------------------------------------------

  srv.on('READ', TransactionMetadata, indexOnMissRead(TransactionMetadata, 'tx_hash', isTxHash, (db, h) => indexer().indexTransactionMetadata(db, h), { errorMessage: 'Invalid transaction hash format' }));

  // GetMetadataByTxHash — returns all metadata rows of a transaction.
  srv.on('GetMetadataByTxHash', async (req: Request) => {
    const { txHash } = req.data as { txHash?: string };
    if (!txHash) rejectMissing(req, 'GetMetadataByTxHash', 'txHash');
    if (!isTxHash(txHash)) rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'txHash');

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash: txHash }));
      if (!existing || existing.length === 0) {
        return await indexer().indexTransactionMetadata(db, txHash);
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
  // Transaction CBOR parsing (pure; no backend or DB access)
  // ---------------------------------------------------------------------------

  srv.on('ParseTransactionCbor', async (req: Request) => {
    const { cbor } = req.data as { cbor?: string };
    if (cbor == null || cbor === '') rejectMissing(req, 'ParseTransactionCbor', 'cbor');
    if (!isValidTxCborHex(cbor)) {
      rejectInvalid(req, 'ParseTransactionCbor', 'Invalid CBOR hex or exceeds size limit', 'cbor');
    }
    return handleRequest(req, async () => parseTransaction(cbor as string));
  });

  // ---------------------------------------------------------------------------
  // Address Transactions
  // ---------------------------------------------------------------------------

  srv.on('GetLatestTransactionsByAddress', async (req: Request) => {
    const { address, limit } = req.data as { address?: string, limit?: number };
    if (!address) rejectMissing(req, 'GetLatestTransactionsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetLatestTransactionsByAddress', 'Invalid bech32 address format', 'address');
    const txLimit = Math.min(Math.max(limit || 10, 1), 100);

    return handleRequest(req, async (db) => {
      const existing = await db.run(
        SELECT.from(AddressTransactions)
          .where({ address_address: address })
          .orderBy('blockTime desc')
          .limit(txLimit)
      );
      if (!existing || existing.length < txLimit) {
        return indexer().indexAddressTransactions(db, address, txLimit);
      }
      return existing;
    });
  });

  logger.debug('All handlers registered');
};
