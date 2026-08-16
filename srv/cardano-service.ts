import cds, { Request } from '@sap/cds';
import { getCardanoIndexer } from './server';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber, isValidTxCborHex, isValidCredential, isAssetUnit } from './utils/validators';
import { rejectInvalid, rejectMissing, AllBackendsFailedError } from './utils/errors';
import { handleRequest} from './utils/backend-request-handler';
import { parseTransaction } from './cbor';

const { SELECT } = cds.ql;

const logger = cds.log(`CardanoService`);

// ---------------------------------------------------------------------------
// Handler Factories - Eliminate duplication in index-on-miss patterns
// ---------------------------------------------------------------------------

type IndexFn<K = string> = (db: cds.Transaction, key: K) => Promise<unknown>;
type ValidateFn = ((v: unknown) => boolean);

/**
 * Upper bound of the temporal window opened by {@link widenTemporalWindow}.
 * Generous on purpose: it only has to outlast the slowest index-on-miss (chained
 * backend timeouts of several calls) within ONE request.
 */
const TEMPORAL_WINDOW_SLACK_MS = 60 * 60 * 1000;

/**
 * Let this request see temporal slices that IT writes during index-on-miss.
 *
 * CAP filters temporal entities (Pools, Assets, Dreps, Addresses, Accounts, …)
 * with `validFrom < $valid.to AND validTo > $valid.from`. The DB session reads
 * both bounds from the request's `_` bag (`VALID-FROM` / `VALID-TO`) when the
 * transaction begins (HANA) or on first use (sqlite) and otherwise defaults to
 * `now` / `now + 1ms` — a window that is closed long before the backend fetch
 * returns, so a slice stamped after the fetch would be invisible to the
 * `req.query` re-read that honours `$expand` / `$select` (KNOWN_ISSUES #13).
 *
 * Only the UPPER bound is moved. No slice is ever future-dated (every mapper
 * stamps `validFrom = now`), so the only additional rows this admits are the
 * ones this very request writes; expired rows stay hidden (`validTo >
 * $valid.from` is untouched). Explicit `sap-valid-*` query options are left
 * alone. Must run before the handler's first DB statement.
 */
function widenTemporalWindow(req: Request): void {
  const q = req.http?.req?.query as Record<string, unknown> | undefined;
  if (q && (q['sap-valid-at'] || q['sap-valid-from'] || q['sap-valid-to'])) return;
  const now = Date.now();
  const from = new Date(now).toISOString();
  const to = new Date(now + TEMPORAL_WINDOW_SLACK_MS).toISOString();
  // The DB session context is built from the context the transaction was opened
  // with — `req` for our `cds.tx(req)`, the root context if a generic handler got
  // there first — so stamp both bags.
  const r = req as unknown as { _?: Record<string, unknown>; context?: { _?: Record<string, unknown> } };
  for (const bag of new Set([r._, r.context?._])) {
    if (!bag) continue;
    bag['VALID-FROM'] = from;
    bag['VALID-TO'] = to;
  }
}

/**
 * Factory: READ handler with index-on-miss behavior.
 * If a key is provided, checks cache first; indexes if missing — then runs the
 * client's own query so `$expand` / `$select` are honoured on the keyed branch
 * too (KNOWN_ISSUES #13: returning the bare row silently dropped them).
 * If no key, passes through to generic req.query.
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
    // explicit null/undefined check — `key &&` skipped validation for falsy keys
    // like epoch=0 or an empty string (the latter then hit the backend unvalidated)
    if (key !== undefined && key !== null && validate && !validate(key))
      rejectInvalid(req, dbKey, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      if (key !== undefined && key !== null) {
        widenTemporalWindow(req); // before the first DB statement — see doc comment
        // CAP temporal aspect auto-filters expired records (validTo < now → not returned)
        const existing = await db.run(SELECT.one.from(entity as never).where({ [dbKey]: key }));
        // Populate the row (+ compositions) on a miss, then let CAP run the client's
        // query — one extra SELECT per keyed read, but $expand/$select (and the
        // temporal filter of the projection) apply exactly as on the un-keyed path.
        if (!existing) await indexFn(db, key as K);
        // The client's query is the ONLY authority on what comes back. Falling back
        // to `existing` (or the indexer's return value) when it matches nothing
        // answers a request the client never made — a second key that does not
        // match, or an excluding $filter, would get a sibling row with a 200
        // instead of a 404 (KNOWN_ISSUES #15). Non-temporal entities always see
        // their fresh rows here; temporal ones rely on widenTemporalWindow above,
        // and if that ever stops working the failure is a loud 404 covered by
        // test/integration/keyed-read-expand.test.ts, not silently wrong data.
      }
      return db.run(req.query);
    });
  };
}

/**
 * Factory: Action handler with required key validation and index-on-miss.
 */
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
      // CAP temporal aspect auto-filters expired records (validTo < now → not returned)
      const existing = await db.run(SELECT.one.from(entity as never).where({ [dbKey]: key }));
      if (!existing) return await indexFn(db, key as K);
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
  logger.debug('Module loaded - registering handlers');

  // NOTE: for entities whose name is already plural-shaped (NetworkInformation,
  // TransactionMetadata, AssetHistory) cds-typer exports the SINGULAR class under the
  // plain name and the plural (entity-set) class with a trailing underscore. Handler
  // registration must use the plural class — under cds 10 registering `srv.on('READ',
  // <singular proxy>)` no longer matches incoming OData READs, so the generic CRUD
  // handler silently served those entities (empty results / 404 instead of
  // index-on-miss). All other names below already resolve to plural classes.
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

  // Fail fast if a future edit reintroduces a SINGULAR class here (the cds-10 trap
  // above): a singular registration silently degrades to the generic CRUD handler.
  // Every cds-typer proxy carries an explicit is_singular marker we can assert on.
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

  // Helper: shorthand for indexer access
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
  // Asset History — read-through (always-fresh)
  // ---------------------------------------------------------------------------
  // Generic READ on AssetHistory is served from DB (no auto-index); consumers
  // must call GetAssetHistory(unit) first to seed entries for a given asset,
  // then page via $top/$skip on the AssetHistory entity.
  srv.on('READ', AssetHistory, async (req: Request) => {
    return handleRequest(req, async (db) => db.run(req.query));
  });

  /**
   * Action: GetAssetHistory - Always-fresh fetch of recent mint/burn events.
   * Multi-backend: Koios preferred (block timestamps), Blockfrost fallback.
   */
  srv.on('GetAssetHistory', async (req: Request) => {
    const { unit, limit } = req.data as { unit?: string; limit?: number };
    if (!unit) return rejectMissing(req, 'GetAssetHistory', 'unit');
    if (!isAssetUnit(unit)) {
      return rejectInvalid(req, 'GetAssetHistory', 'Invalid asset unit format', 'unit');
    }
    // clamp like GetLatestTransactionsByAddress — unbounded limits page the upstream backend indefinitely
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
      const assets = await db.run(SELECT.from(AddressAssets).where({ address_address: address }));

      // Deduplicate temporal versions — keep latest validFrom per unit
      const seen = new Map<string, any>();
      for (const asset of assets) {
        if (!seen.has(asset.unit) || asset.validFrom > seen.get(asset.unit).validFrom) {
          seen.set(asset.unit, asset);
        }
      }
      return Array.from(seen.values());
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
      const existing = await db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));

      if (!existing || existing.length === 0) {
        // No valid cached data — re-index fresh (UPSERT is idempotent, no DELETE needed).
        // Prefer getAddress-based full indexing (richer: also captures address detail and
        // returns NotFound for unknown addresses on Blockfrost/Koios). But GetUTxOsByAddress
        // only needs the UTxO set, which Ogmios serves via getAddressUtxos even though it
        // doesn't support getAddress — so when NO configured backend can serve getAddress
        // (AllBackendsFailedError with zero collected errors == every backend skipped it),
        // fall back to a UTxO-only index instead of failing. getAddress is indexAddress's
        // first call, so nothing is persisted before this throws — the fallback is clean.
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

      // Deduplicate temporal versions — keep latest validFrom per hash+index
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

  /**
   * Action: GetUTxOsByCredential - Koios-only credential-keyed UTxO query.
   * Always-fresh (no cache check) — credential queries serve dApp state-read use
   * cases (Indigo CDPs, Liqwid positions) that need current blockchain state.
   * Throws ProviderUnavailableError if Koios backend is not configured.
   */
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

  /**
   * Action: GetMetadataByTxHash - returns multiple metadata rows (uses SELECT.from, not SELECT.one).
   * Takes camelCase `txHash` like every other action (renamed from `tx_hash` in 1.9.4).
   */
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
  // Transaction CBOR parsing (pure utility — no backend / DB touch)
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
