import cds, { Request } from '@sap/cds';
import type { expr, predicate, ref, val, list, xpr } from '@sap/cds';
import { getCardanoIndexer } from './server';
import { isTxHash, isBlockHash, isValidBech32Address, isValidBech32StakeAddress, isValidPoolId, isValidDrepId, isEpochNumber, isValidTxCborHex, isValidCredential, isAssetUnit } from './utils/validators';
import { rejectInvalid, rejectMissing, AllBackendsFailedError } from './utils/errors';
import { handleRequest} from './utils/backend-request-handler';
import { parseTransaction, decodePlutusData } from './cbor';
import type { AddressAsset, AddressUTxO, TransactionMetadata as TransactionMetadatum } from '#cds-models/CardanoODataService';
import { pageOf, pageRows, byKey, byOutRef, sortAssetHistory, latestWindowPage } from './utils/paging';
import {
  GetAssetHistory, GetAssetsByAddress, GetUTxOsByAddress, GetUTxOsByCredential, GetTransactionConfirmations,
  GetMetadataByTxHash, GetMetadataByLabel, ParseTransactionCbor, DecodePlutusData, GetLatestTransactionsByAddress,
} from '#cds-models/CardanoODataService';
import { metadataIdFor, txSeqOf } from './utils/mappers';
import { runWithoutAmbientTx, readOutside } from './utils/tx-utils';
import { answerNumbersAsText } from './utils/result-numbers';
import { limitApiReads } from './utils/read-limits';
import { guardLargeReads } from './utils/read-guard';
import { navigationOf, readKey, type NavigationRead } from './utils/navigation';
import { accountAddressList, parseAccountAddressList, type CardanoIndexer, type FetchedAccount, type FetchedAddress } from './blockchain/cardano-indexer';
import type { UTxO } from './utils/types';

/** Pause between two reads of a waiting GetLatestTransactionsByAddress call. */
const ADDRESS_WAIT_POLL_MS = 5000;

/** Newest temporal slice per key; child tables keep one row per validFrom. */
function latestSlices<T extends { validFrom?: string | null }>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = seen.get(key);
    if (!prev || (row.validFrom ?? '') > (prev.validFrom ?? '')) seen.set(key, row);
  }
  return Array.from(seen.values());
}

const { SELECT } = cds.ql;

const logger = cds.log(`CardanoService`);

// ---------------------------------------------------------------------------
// Handler factories for the index-on-miss pattern
// ---------------------------------------------------------------------------

type ValidateFn = ((v: unknown) => boolean);

/** The two halves of an index-on-miss: the provider read, then the write of what it returned. */
interface IndexOnMiss<K, F> {
  fetch: (db: cds.Transaction, key: K) => Promise<F>;
  store: (db: cds.Transaction, fetched: F) => Promise<unknown>;
}

/** Pairs a provider read with the write of its result; the result type follows from the read. */
function indexPair<K, F>(fetch: IndexOnMiss<K, F>['fetch'], store: IndexOnMiss<K, F>['store']): IndexOnMiss<K, F> {
  return { fetch, store };
}

// Fills misses without holding the request transaction while the provider answers: every missing
// key is read from the provider first, then all are stored. A row stored in the meantime is kept.
// Returns the row found or stored per key.
async function indexMissing<K, F>(
  db: cds.Transaction,
  keys: K[],
  exists: (db: cds.Transaction, key: K) => Promise<unknown>,
  index: IndexOnMiss<K, F>
): Promise<unknown[]> {
  return (await prepareMissing(db, keys, exists, index)).store();
}

// The provider half of indexMissing: reads the missing keys from the provider and returns the
// write that stores them, so a caller can collect several before its first write.
async function prepareMissing<K, F>(
  db: cds.Transaction,
  keys: K[],
  exists: (db: cds.Transaction, key: K) => Promise<unknown>,
  index: IndexOnMiss<K, F>
): Promise<{ store: () => Promise<unknown[]> }> {
  const found = await readOutside(db, async (d) => {
    const rows: unknown[] = [];
    for (const key of keys) rows.push(await exists(d, key));
    return rows;
  });
  const fetched = new Map<number, F>();
  for (const [i, key] of keys.entries()) {
    if (!found[i]) fetched.set(i, await index.fetch(db, key));
  }
  return {
    store: async () => {
      const rows = [...found];
      for (const [i, value] of fetched) rows[i] = (await exists(db, keys[i])) || await index.store(db, value);
      return rows;
    },
  };
}

/** Upper bound of the temporal window; must outlast the slowest index-on-miss of one request. */
const TEMPORAL_WINDOW_SLACK_MS = 60 * 60 * 1000;

// CAP's temporal window is fixed at transaction start, so a slice written by index-on-miss would be
// invisible to the re-read. This widens the upper bound unless the client set `sap-valid-*`.
// Must run before the request transaction's first statement.
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

/** READ handler that indexes a missing key first, then runs the client's own query (keeps `$expand`, `$select`). */
/** Options of the keyed handlers; `exists` replaces the plain key lookup that decides a miss. */
interface KeyedOptions<K> {
  entityKeyField?: string;
  errorMessage?: string;
  exists?: (db: cds.Transaction, key: K) => Promise<unknown>;
}

function indexOnMissRead<K, F>(
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn | null,
  index: IndexOnMiss<K, F>,
  options?: KeyedOptions<K>
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  const exists = options?.exists ?? ((d: cds.Transaction, k: K) => d.run(SELECT.one.from(entity as never).where({ [dbKey]: k })));
  return async (req: Request) => {
    const key = readKey(req, reqKeyField);
    // Explicit null check: falsy keys such as epoch=0 or '' must still be validated.
    if (key !== undefined && key !== null && validate && !validate(key))
      rejectInvalid(req, dbKey, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      if (key !== undefined && key !== null) {
        widenTemporalWindow(req);
        // The temporal aspect hides expired rows, so a miss here triggers a re-index.
        await indexMissing(db, [key as K], exists, index);
        // The client's query is the only authority on the result: never answer with the row
        // found here, or an excluding $filter / second key would yield a sibling row instead of 404.
      }
      return db.run(req.query);
    });
  };
}

/** READ handler of an entity without a key in the request: stores its row on a miss, then runs the client's own query. */
function singletonRead<F>(entity: unknown, index: IndexOnMiss<null, F>) {
  return async (req: Request) => handleRequest(req, async (db) => {
    widenTemporalWindow(req);
    await indexMissing(db, [null], (d) => d.run(SELECT.one.from(entity as never)), index);
    return db.run(req.query);
  });
}

/** Factory: action handler with required-key validation and index-on-miss. */
function indexOnMissAction<K, F>(
  actionName: string,
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn,
  index: IndexOnMiss<K, F>,
  options?: KeyedOptions<K>
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  const byKey = (d: cds.Transaction, k: K) => d.run(SELECT.one.from(entity as never).where({ [dbKey]: k }));
  const exists = options?.exists ?? byKey;
  return async (req: Request) => {
    const key = (req.data as Record<string, unknown>)?.[reqKeyField];
    if (key == null) rejectMissing(req, actionName, reqKeyField);
    if (!validate(key)) rejectInvalid(req, actionName, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      // The temporal aspect hides expired rows, so a miss here triggers a re-index.
      const [row] = await indexMissing(db, [key as K], exists, index);
      // the stored row, as a repeated call answers it; the provider mapping may differ in shape
      return (await byKey(db, key as K)) ?? row;
    });
  };
}

/** Addresses one collection read may index on a miss; more is a 400. */
const MAX_ADDRESSES_PER_READ = 10;

const numberVal = (v: unknown): number | undefined => {
  const n = Number((v as { val?: unknown } | undefined)?.val);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

const isRef = (t: expr | string): t is ref => typeof t === 'object' && 'ref' in t;
const isVal = (t: expr | string): t is val => typeof t === 'object' && 'val' in t;
const isList = (t: expr | string): t is list => typeof t === 'object' && 'list' in t;
const isXpr = (t: expr | string): t is xpr => typeof t === 'object' && 'xpr' in t;

/** `address_address` or the association path `address/address`. */
function isAddressRef(t: expr | string): boolean {
  if (!isRef(t)) return false;
  const path = t.ref;
  return (path.length === 1 && path[0] === 'address_address') || (path.length === 2 && path[0] === 'address' && path[1] === 'address');
}

const stringVal = (t: expr | string | undefined): string | undefined =>
  t !== undefined && isVal(t) && typeof t.val === 'string' ? t.val : undefined;

/** Addresses a child-set read names: the navigation parent, or `address_address` in an `eq` or `in` filter. */
function addressesInReadQuery(req: Request): string[] {
  const found = new Set<string>();
  const parent = (req.data as Record<string, unknown>)?.address_address;
  if (typeof parent === 'string') found.add(parent);
  const walk = (tokens: predicate) => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (typeof token === 'string') continue;
      if (isXpr(token)) { walk(token.xpr); continue; }
      const op = tokens[i + 1];
      const right = tokens[i + 2];
      if (isAddressRef(token) && op === '=') {
        const value = stringVal(right);
        if (value) found.add(value);
      } else if (isAddressRef(token) && op === 'in' && right !== undefined && isList(right)) {
        for (const item of right.list as (expr | string)[]) {
          const value = stringVal(item);
          if (value) found.add(value);
        }
      } else if (right !== undefined && isAddressRef(right) && op === '=') {
        const value = stringVal(token);
        if (value) found.add(value);
      }
    }
  };
  const query: cds.ql.Query = req.query;
  walk(('SELECT' in query && query.SELECT?.where) || []);
  return Array.from(found);
}

/** READ handler for a child set of Addresses: indexes the named address on a miss, then runs the query. */
function addressChildRead<F>(
  isIndexed: (db: cds.Transaction, address: string) => Promise<boolean>,
  index: IndexOnMiss<string, F>
) {
  return async (req: Request) => {
    const addresses = addressesInReadQuery(req);
    if (addresses.length > MAX_ADDRESSES_PER_READ) {
      rejectInvalid(req, 'address_address', `A read may name at most ${MAX_ADDRESSES_PER_READ} addresses`, 'address_address');
    }
    for (const address of addresses) {
      if (!isValidBech32Address(address)) rejectInvalid(req, 'address_address', 'Invalid bech32 address format', 'address_address');
    }

    return handleRequest(req, async (db) => {
      if (addresses.length) {
        widenTemporalWindow(req);
        await indexMissing(db, addresses, isIndexed, index);
      }
      return db.run(req.query);
    });
  };
}

// ---------------------------------------------------------------------------
// Service Registration
// ---------------------------------------------------------------------------

/** CardanoODataService handlers: blockchain read queries with index-on-miss. */
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);
  limitApiReads(srv);
  guardLargeReads(srv);
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
    TransactionInputs,
    TransactionOutputs,
    AssetHistory_: AssetHistory,
    LedgerProtocolParameters,
    AddressTransactions
  } = require('#cds-models/CardanoODataService');

  // Fail fast on a singular class: it would silently degrade to the generic CRUD handler.
  for (const [name, entity] of Object.entries({
    NetworkInformation, Blocks, Epochs, Addresses, AddressAssets, AddressUTxOs,
    Transactions, TransactionMetadata, Pools, Accounts, Dreps, Assets, AssetHistory,
    LedgerProtocolParameters, AddressTransactions, TransactionInputs, TransactionOutputs,
  })) {
    if ((entity as { is_singular?: boolean })?.is_singular) {
      throw new Error(
        `CardanoODataService: '${name}' resolves to the SINGULAR cds-typer class: ` +
        `READ handlers registered with it never match under cds 10. Destructure the ` +
        `plural entity-set class instead (e.g. '${name}_ as ${name}').`
      );
    }
  }

  const indexer = () => getCardanoIndexer();

  // The read and the store half of each index-on-miss; the indexer is resolved per request.
  const blockIndex = indexPair((db, hash: string) => indexer().fetchBlock(db, hash), (db, fetched) => indexer().storeBlock(db, fetched));
  const poolIndex = indexPair((db, poolId: string) => indexer().fetchPool(db, poolId), (db, fetched) => indexer().storePool(db, fetched));
  const accountIndex = indexPair((db, stakeAddress: string) => indexer().fetchAccount(db, stakeAddress), (db, fetched) => indexer().storeAccount(db, fetched));
  const drepIndex = indexPair((_db, drepId: string) => indexer().fetchDrep(drepId), (db, fetched) => indexer().storeDrep(db, fetched));
  const assetIndex = indexPair((db, unit: string) => indexer().resolveAssetInfo(db, unit), (db, fetched) => indexer().storeAsset(db, fetched));
  const transactionIndex = indexPair((db, hash: string) => indexer().fetchTransaction(db, hash), (db, fetched) => indexer().storeTransaction(db, fetched));
  const metadataIndex = indexPair((db, hash: string) => indexer().fetchTransactionMetadata(db, hash), (db, fetched) => indexer().storeTransactionMetadata(db, fetched));
  const networkIndex = indexPair((db, _key: null) => indexer().fetchNetworkInformation(db), (db, fetched) => indexer().storeNetworkInformation(db, fetched));

  // ---------------------------------------------------------------------------
  // Network Information (singleton - no key field)
  // ---------------------------------------------------------------------------

  async function fetchNetworkInformation(db: cds.Transaction) {
    const [row] = await indexMissing(db, [null], (d) => d.run(SELECT.one.from(NetworkInformation)), networkIndex);
    return row;
  }

  srv.on('READ', NetworkInformation, singletonRead(NetworkInformation, networkIndex));

  srv.on('GetNetworkInformation', async (req: Request) => {
    return handleRequest(req, fetchNetworkInformation);
  });

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  srv.on('READ', Blocks, indexOnMissRead(Blocks, 'hash', isBlockHash, blockIndex));
  srv.on('GetBlockByHash', indexOnMissAction('GetBlockByHash', Blocks, 'hash', isBlockHash, blockIndex));

  srv.on('GetLatestBlock', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexLatestBlock(db));
  });

  // ---------------------------------------------------------------------------
  // Epochs
  // ---------------------------------------------------------------------------

  // An epoch row counts as stored only once it is final; until then a read refreshes it. When the
  // backend cannot answer, the stored row stands.
  type EpochRow = Awaited<ReturnType<CardanoIndexer['fetchEpoch']>>;
  const epochIndex: IndexOnMiss<number, { fresh: EpochRow } | { stored: EpochRow }> = {
    fetch: async (db, epoch) => {
      try {
        return { fresh: await indexer().fetchEpoch(epoch) };
      } catch (err: unknown) {
        const stored = await readOutside(db, (d) => d.run(SELECT.one.from(Epochs).where({ epoch }))) as EpochRow | undefined;
        if (!stored) throw err;
        logger.debug(`epoch ${epoch} not refreshed, the stored row stands: ${err instanceof Error ? err.message : String(err)}`);
        return { stored };
      }
    },
    store: async (db, fetched) => ('fresh' in fetched ? indexer().storeEpoch(db, fetched.fresh) : fetched.stored),
  };
  const finalEpoch = (d: cds.Transaction, epoch: number) => d.run(SELECT.one.from(Epochs).where({ epoch, final: true }));
  const epochOptions = { errorMessage: 'epochNumber has invalid format', exists: finalEpoch };

  srv.on('READ', Epochs, indexOnMissRead(Epochs, 'epoch', isEpochNumber, epochIndex, epochOptions));
  srv.on('GetEpochByNumber', indexOnMissAction('GetEpochByNumber', Epochs, 'epochNumber', isEpochNumber, epochIndex, { ...epochOptions, entityKeyField: 'epoch' }));

  srv.on('GetLatestEpoch', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexLatestEpoch(db));
  });

  // ---------------------------------------------------------------------------
  // Pools
  // ---------------------------------------------------------------------------

  srv.on('READ', Pools, indexOnMissRead(Pools, 'poolId', isValidPoolId, poolIndex));
  srv.on('GetPoolById', indexOnMissAction('GetPoolById', Pools, 'poolId', isValidPoolId, poolIndex));

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  srv.on('READ', Accounts, indexOnMissRead(Accounts, 'stakeAddress', isValidBech32StakeAddress, accountIndex));
  srv.on('GetAccountByStakeAddress', indexOnMissAction('GetAccountByStakeAddress', Accounts, 'stakeAddress', isValidBech32StakeAddress, accountIndex));

  // ---------------------------------------------------------------------------
  // Dreps
  // ---------------------------------------------------------------------------

  srv.on('READ', Dreps, indexOnMissRead(Dreps, 'drepId', isValidDrepId, drepIndex));
  srv.on('GetDrepById', indexOnMissAction('GetDrepById', Dreps, 'drepId', isValidDrepId, drepIndex));

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  srv.on('READ', Assets, indexOnMissRead(Assets, 'unit', isAssetUnit, assetIndex, { errorMessage: 'Invalid asset unit format' }));
  srv.on('GetAssetInfo', indexOnMissAction('GetAssetInfo', Assets, 'unit', isAssetUnit, assetIndex, { errorMessage: 'Invalid asset unit format' }));

  // Asset history: READ serves stored rows only; GetAssetHistory fetches and stores them.
  srv.on('READ', AssetHistory, async (req: Request) => {
    return handleRequest(req, async (db) => db.run(req.query));
  });

  // GetAssetHistory: always-fresh fetch of recent mint/burn events.
  srv.on(GetAssetHistory, async (req) => {
    const { unit } = req.data;
    if (!unit) return rejectMissing(req, 'GetAssetHistory', 'unit');
    if (!isAssetUnit(unit)) {
      return rejectInvalid(req, 'GetAssetHistory', 'Invalid asset unit format', 'unit');
    }
    const page = latestWindowPage(req, 'GetAssetHistory', 100);
    return handleRequest(req, async (db) => {
      const events = await indexer().indexAssetHistory(db, unit, page.skip + page.limit);
      return pageRows(sortAssetHistory(events), page);
    });
  });

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  // The full address read when a backend aggregates addresses; with none of them (Ogmios alone,
  // AllBackendsFailedError without errors) the address is read from its UTxOs. Both write the
  // Addresses row, so a navigation from it finds its parent.
  const addressIndex: IndexOnMiss<string, FetchedAddress | { address: string; utxos: UTxO[] }> = {
    fetch: async (db, address) => {
      try {
        return await indexer().fetchAddress(db, address);
      } catch (err: unknown) {
        if (err instanceof AllBackendsFailedError && err.errors.length === 0) {
          return { address, utxos: await indexer().fetchAddressUtxos(address) };
        }
        throw err;
      }
    },
    store: (db, fetched) => 'utxos' in fetched
      ? indexer().storeAddressFromUtxos(db, fetched.address, fetched.utxos)
      : indexer().storeAddress(db, fetched),
  };

  /** An address is indexed when its Addresses row is valid. */
  const addressIndexed = async (db: cds.Transaction, address: string) =>
    !!(await db.run(SELECT.one.from(Addresses).where({ address })));

  srv.on('READ', Addresses, indexOnMissRead(Addresses, 'address', isValidBech32Address, addressIndex, { errorMessage: 'Invalid bech32 address format' }));
  srv.on('GetAddressByBech32', indexOnMissAction('GetAddressByBech32', Addresses, 'address', isValidBech32Address, addressIndex, { errorMessage: 'Invalid bech32 address format' }));
  // GetAssetsByAddress: indexes the parent address if needed, then queries child assets.
  srv.on(GetAssetsByAddress, async (req) => {
    const { address } = req.data;
    if (!address) rejectMissing(req, 'GetAssetsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetAssetsByAddress', 'Invalid bech32 address format', 'address');
    const page = pageOf(req.data, 1000);

    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      await indexMissing(db, [address], addressIndexed, addressIndex);
      const assets: AddressAsset[] = await db.run(SELECT.from(AddressAssets).where({ address_address: address }));
      return pageRows(byKey(latestSlices(assets, (asset) => asset.unit ?? ''), (a) => a.unit ?? ''), page);
    });
  });

  // GetUTxOsByAddress: indexes the address if needed, then queries child UTxOs.
  srv.on(GetUTxOsByAddress, async (req) => {
    const { address } = req.data;
    if (!address) rejectMissing(req, 'GetUTxOsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');
    const page = pageOf(req.data, 1000);

    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      await indexMissing(db, [address], addressIndexed, addressIndex);
      const utxos: AddressUTxO[] = await db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));
      return pageRows(byOutRef(latestSlices(utxos, (utxo) => `${utxo.hash}#${utxo.index}`)), page);
    });
  });

  // Collection reads of the address child sets fill like the parent: an address named in the
  // navigation or the $filter is indexed on a miss, then the client's own query runs.
  srv.on('READ', AddressUTxOs, addressChildRead(addressIndexed, addressIndex));
  srv.on('READ', AddressAssets, addressChildRead(addressIndexed, addressIndex));
  srv.on('READ', AddressTransactions, addressChildRead(addressIndexed, addressIndex));

  // GetUTxOsByCredential: always-fresh credential-keyed UTxO query (dApp state reads need current
  // data). Crawled UTxO set + node first, else Koios; ProviderUnavailableError without either.
  srv.on(GetUTxOsByCredential, async (req) => {
    const { credential } = req.data;
    if (!credential) return rejectMissing(req, 'GetUTxOsByCredential', 'credential');
    if (!isValidCredential(credential)) {
      return rejectInvalid(req, 'GetUTxOsByCredential', 'Invalid payment credential: expected 56-char lowercase hex (28 bytes)', 'credential');
    }

    const page = pageOf(req.data, 1000);
    return handleRequest(req, async (db) => pageRows(byOutRef(await indexer().indexCredentialUtxos(db, credential)), page));
  });

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  srv.on('READ', Transactions, indexOnMissRead(Transactions, 'hash', isTxHash, transactionIndex, { errorMessage: 'Invalid transaction hash format' }));
  srv.on('GetTransactionByHash', indexOnMissAction('GetTransactionByHash', Transactions, 'hash', isTxHash, transactionIndex, { errorMessage: 'Invalid transaction hash format' }));

  srv.on(GetTransactionConfirmations, async (req) => {
    const { txHash } = req.data;
    if (!txHash) rejectMissing(req, 'GetTransactionConfirmations', 'txHash');
    if (!isTxHash(txHash)) rejectInvalid(req, 'GetTransactionConfirmations', 'Invalid transaction hash format', 'txHash');
    return handleRequest(req, (db) => indexer().resolveTransactionConfirmations(db, txHash));
  });

  // ---------------------------------------------------------------------------
  // Transaction Metadata
  // ---------------------------------------------------------------------------

  srv.on('READ', TransactionMetadata, indexOnMissRead(TransactionMetadata, 'tx_hash', isTxHash, metadataIndex, { errorMessage: 'Invalid transaction hash format' }));

  // GetMetadataByTxHash: returns all metadata rows of a transaction.
  srv.on(GetMetadataByTxHash, async (req) => {
    const { txHash } = req.data;
    if (!txHash) rejectMissing(req, 'GetMetadataByTxHash', 'txHash');
    if (!isTxHash(txHash)) rejectInvalid(req, 'GetMetadataByTxHash', 'Invalid transaction hash format', 'txHash');
    const page = pageOf(req.data, 1000);

    return handleRequest(req, async (db) => {
      const stored = async (d: cds.Transaction, hash: string) => {
        const existing: TransactionMetadatum[] = await d.run(SELECT.from(TransactionMetadata).where({ tx_hash: hash }));
        return existing?.length ? existing : null;
      };
      const [rows] = await indexMissing(db, [txHash as string], stored, metadataIndex) as [TransactionMetadatum[]];
      return pageRows(byKey(rows, (m) => String(m.label ?? '').padStart(20, '0')), page);
    });
  });

  // GetMetadataByLabel: stored metadata of one label along the chain. Reads the database only.
  srv.on(GetMetadataByLabel, async (req) => {
    const { label, fromSlot } = req.data;
    if (label == null || String(label).trim() === '') rejectMissing(req, 'GetMetadataByLabel', 'label');
    const id = metadataIdFor(String(label).trim());
    if (id === null) rejectInvalid(req, 'GetMetadataByLabel', 'label must be an unsigned 64-bit integer', 'label');
    const { limit, skip } = pageOf(req.data, 100);

    // NULLS LAST is the order of the (id, txSeq) index; the filter excludes NULL anyway, and a
    // plain ASC on the nullable column would make PostgreSQL sort every row of the label.
    const query = SELECT.from(TransactionMetadata).where({ id, txSeq: { '>=': txSeqOf(Number(fromSlot ?? 0), 0) } }).limit(limit, skip);
    query.SELECT.orderBy = [{ ref: ['txSeq'], sort: 'asc', nulls: 'last' }];
    return handleRequest(req, (db) => db.run(query));
  });

  // ---------------------------------------------------------------------------
  // Protocol Parameters (singleton)
  // ---------------------------------------------------------------------------

  // One row per epoch. The read stores the current epoch's row once it is older than its TTL,
  // the same rule as GetLedgerProtocolParameters, then runs the client's own query. When the
  // backend cannot answer, the stored rows stand.
  srv.on('READ', LedgerProtocolParameters, async (req: Request) => handleRequest(req, async (db) => {
    try {
      await indexer().indexProtocolParameters(db);
    } catch (err: unknown) {
      if (!(await db.run(SELECT.one.from(LedgerProtocolParameters)))) throw err;
      logger.debug(`protocol parameters not refreshed, the stored rows stand: ${err instanceof Error ? err.message : String(err)}`);
    }
    return db.run(req.query);
  }));

  srv.on('GetLedgerProtocolParameters', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexProtocolParameters(db));
  });

  // ---------------------------------------------------------------------------
  // Transaction CBOR parsing (pure; no backend or DB access)
  // ---------------------------------------------------------------------------

  srv.on(ParseTransactionCbor, async (req) => {
    const { cbor } = req.data;
    if (cbor == null || cbor === '') rejectMissing(req, 'ParseTransactionCbor', 'cbor');
    if (!isValidTxCborHex(cbor)) {
      rejectInvalid(req, 'ParseTransactionCbor', 'Invalid CBOR hex or exceeds size limit', 'cbor');
    }
    return handleRequest(req, async () => parseTransaction(cbor as string));
  });

  srv.on(DecodePlutusData, async (req) => {
    const { cbor } = req.data;
    if (cbor == null || cbor === '') rejectMissing(req, 'DecodePlutusData', 'cbor');
    if (!isValidTxCborHex(cbor)) {
      rejectInvalid(req, 'DecodePlutusData', 'Invalid CBOR hex or exceeds size limit', 'cbor');
    }
    return handleRequest(req, async () => JSON.stringify(decodePlutusData(cbor as string)));
  });

  // ---------------------------------------------------------------------------
  // Address Transactions
  // ---------------------------------------------------------------------------

  // Reads of the address watch, shared by the waiting calls on one address and window: a call takes
  // a read that started after its own last one and within one poll interval, else it starts one.
  // Each read runs in its own transaction, so a waiting request holds no database connection.
  type AddressTransactionRows = Awaited<ReturnType<CardanoIndexer['indexAddressTransactions']>>;
  interface WatchRead { at: number; rows: Promise<AddressTransactionRows> }
  const watchReads = new Map<string, WatchRead>();
  const watchRead = (address: string, window: number, after: number): WatchRead => {
    const key = `${address}|${window}`;
    const now = Date.now();
    const recent = watchReads.get(key);
    if (recent && recent.at > after && now - recent.at < ADDRESS_WAIT_POLL_MS) return recent;
    const read: WatchRead = {
      at: now,
      rows: runWithoutAmbientTx(async (): Promise<AddressTransactionRows> => cds.tx((tx) => indexer().indexAddressTransactions(tx, address, window))),
    };
    watchReads.set(key, read);
    const forget = () => { if (watchReads.get(key) === read) watchReads.delete(key); };
    read.rows.catch(forget);
    setTimeout(forget, ADDRESS_WAIT_POLL_MS).unref?.();
    return read;
  };

  // GetLatestTransactionsByAddress: the newest transactions of an address. With sinceTime only
  // newer ones; with waitMs the call re-reads until one appears or the time is up.
  srv.on(GetLatestTransactionsByAddress, async (req) => {
    const { address, sinceTime, waitMs } = req.data;
    if (!address) rejectMissing(req, 'GetLatestTransactionsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetLatestTransactionsByAddress', 'Invalid bech32 address format', 'address');
    if (waitMs && sinceTime == null) rejectInvalid(req, 'GetLatestTransactionsByAddress', 'waitMs needs sinceTime', 'waitMs');
    const page = latestWindowPage(req, 'GetLatestTransactionsByAddress', 10);
    const window = page.skip + page.limit;
    const since = sinceTime == null ? null : Number(sinceTime);
    const newer = <T extends { blockTime?: number | string | null }>(rows: T[]): T[] =>
      since == null ? rows : rows.filter((r) => Number(r.blockTime ?? 0) > since);
    const deadline = Date.now() + Number(waitMs ?? 0);

    // Every call lists the newest hashes; stored rows are reused, only new ones are fetched.
    return handleRequest(req, async (db) => {
      if (!waitMs) return pageRows(newer(await indexer().indexAddressTransactions(db, address, window)), page);
      // the last read falls on the deadline, so a short waitMs waits as long as it says
      for (let last = -Infinity; ;) {
        const read = watchRead(address, window, last);
        last = read.at;
        const rows = newer(await read.rows);
        const remaining = deadline - Date.now();
        if (rows.length || remaining <= 0 || req.http?.res.destroyed === true) return pageRows(rows, page);
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, ADDRESS_WAIT_POLL_MS)));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Navigation reads
  // ---------------------------------------------------------------------------

  // A navigation such as Transactions('h')/inputs joins its parent row, so the parent is indexed
  // first, and so is the target of an $expand on a keyed read. Each preparation asks the backend
  // and returns its writes; the writes run after every provider call, so no request waits on one.

  /** A write a read prepared: its provider calls are done, only the database write is left. */
  type PendingStore = () => Promise<unknown>;

  /** The table; the service projection leaves the address list out. */
  const ACCOUNTS_TABLE = 'odatano.cardano.Accounts';

  // The valid account row with its address list. The temporal window applies to the service
  // entity, so the valid slice is found there and its list read from the table by the full key.
  async function validAccountRow(d: cds.Transaction, stakeAddress: string): Promise<AccountRow | undefined> {
    const row = await d.run(SELECT.one.from(Accounts).columns('validFrom', 'poolId_poolId', 'drepId_drepId').where({ stakeAddress })) as (AccountRow & { validFrom?: string }) | undefined;
    if (!row) return undefined;
    const list = await d.run(SELECT.one.from(ACCOUNTS_TABLE).columns('addressList').where({ stakeAddress, validFrom: row.validFrom })) as { addressList?: string | null } | undefined;
    return { ...row, addressList: list?.addressList ?? null };
  }

  /** The parts of a valid account row the navigation reads use. */
  interface AccountRow { addressList?: string | null; poolId_poolId?: string | null; drepId_drepId?: string | null }

  // The stored account row, read once, and the backend's account, asked at most once per read.
  interface AccountSource {
    stakeAddress: string;
    row: () => Promise<AccountRow | undefined>;
    fetch: () => Promise<FetchedAccount>;
    fetched: () => FetchedAccount | null;
  }
  function accountSource(db: cds.Transaction, stakeAddress: string): AccountSource {
    let row: ReturnType<AccountSource['row']> | undefined;
    let fetch: Promise<FetchedAccount> | undefined;
    let fetched: FetchedAccount | null = null;
    return {
      stakeAddress,
      row: () => (row ??= readOutside(db, (d) => validAccountRow(d, stakeAddress))),
      fetch: () => (fetch ??= accountIndex.fetch(db, stakeAddress).then((f) => (fetched = f))),
      fetched: () => fetched,
    };
  }

  // The addresses of an account, sorted and unique: the list stored with a valid account row, else
  // the backend's. Only an expired or missing account asks the backend.
  async function accountAddresses(account: AccountSource): Promise<string[]> {
    const stored = parseAccountAddressList((await account.row())?.addressList);
    return stored ?? accountAddressList((await account.fetch()).account.addresses);
  }

  /** Writes the account row when the backend was asked and no valid row exists meanwhile. */
  function storeAccount(db: cds.Transaction, account: AccountSource): PendingStore {
    return async () => {
      const fetched = account.fetched();
      if (fetched && !(await db.run(SELECT.one.from(Accounts).where({ stakeAddress: account.stakeAddress })))) await accountIndex.store(db, fetched);
    };
  }

  /** The parts of a query an account address page is chosen from and written into. */
  interface PagePart {
    where?: unknown[];
    orderBy?: Array<{ ref?: unknown[]; sort?: string }>;
    limit?: { rows?: unknown; offset?: unknown };
    columns?: unknown[];
  }

  // The addresses a read of an account's addresses needs stored. Up to MAX_ADDRESSES_PER_READ the
  // read runs as written. Above that the page is chosen before the rows exist, so it can follow only
  // the address order: no $filter, $orderby on address alone, $top of at most the cap.
  function accountAddressPage(req: Request, all: string[], part: PagePart, countOnly: boolean): string[] {
    if (all.length <= MAX_ADDRESSES_PER_READ) return all;
    if (countOnly) return [];
    const rule = `The account has ${all.length} addresses: read at most ${MAX_ADDRESSES_PER_READ} at a time with $top and $skip, ordered by address, without $filter`;
    const order = part.orderBy ?? [];
    const rows = numberVal(part.limit?.rows);
    const byAddress = order.every((o) => o.ref?.length === 1 && o.ref[0] === 'address');
    if (part.where?.length || order.length > 1 || !byAddress || rows == null || rows > MAX_ADDRESSES_PER_READ) {
      rejectInvalid(req, 'Address', rule, 'Address');
    }
    const offset = numberVal(part.limit?.offset) ?? 0;
    const sorted = order[0]?.sort === 'desc' ? [...all].reverse() : all;
    return sorted.slice(offset, offset + (rows as number));
  }

  /** Narrows `part` to the chosen page; the offset is already in the page. */
  function readPage(part: PagePart, page: string[]): void {
    part.where = [{ ref: ['address'] }, 'in', { list: (page.length ? page : ['']).map((val) => ({ val })) }];
    part.limit = { rows: { val: Math.max(page.length, 1) } };
    if (!part.orderBy?.length) part.orderBy = [{ ref: ['address'], sort: 'asc' }];
  }

  /** Total address count of an account read whose page was narrowed, by request, for its $count. */
  const accountAddressTotals = new WeakMap<Request, number>();
  /** The same for an `$expand=Address` page of a keyed Accounts read. */
  const expandAddressTotals = new WeakMap<Request, number>();

  // Fetches the addresses not stored yet; the returned write stores them. The addresses come from
  // stored rows or the backend, which also name Byron addresses, so they are not checked as bech32.
  async function prepareAddresses(db: cds.Transaction, addresses: Array<string | null | undefined>): Promise<PendingStore> {
    const named = addresses.filter((a): a is string => typeof a === 'string' && a.length > 0);
    return (await prepareMissing(db, named, addressIndexed, addressIndex)).store;
  }

  // Accounts('s')/Address and $expand=Address: a plain collection read gets its page; Address('a')
  // and the paths below it get that one address once it belongs to the account.
  async function prepareAccountAddressRead(req: Request, db: cds.Transaction, account: AccountSource, nav: NavigationRead | null, part: PagePart, totals: WeakMap<Request, number>): Promise<PendingStore[]> {
    const all = await accountAddresses(account);
    let page: string[];
    if (nav?.navKeys) {
      const named = nav.navKeys.address;
      page = typeof named === 'string' && all.includes(named) ? [named] : [];
    } else if (nav && nav.depth > 2) {
      page = [];
    } else {
      const column = part.columns?.length === 1 ? part.columns[0] as { func?: string; as?: string } : undefined;
      page = accountAddressPage(req, all, part, nav !== null && column?.func === 'count' && column.as === '$count');
      if (all.length > MAX_ADDRESSES_PER_READ) {
        readPage(part, page);
        totals.set(req, all.length);
      }
    }
    return [await prepareAddresses(db, page), storeAccount(db, account)];
  }

  // Accounts('s')/poolId and /drepId, and their $expand: the pool or DRep the account names.
  async function prepareAccountTarget(db: cds.Transaction, account: AccountSource, to: 'poolId' | 'drepId'): Promise<PendingStore[]> {
    const row = await account.row();
    const id = row ? row[to === 'poolId' ? 'poolId_poolId' : 'drepId_drepId'] : (await account.fetch()).account[to];
    const stores: PendingStore[] = [storeAccount(db, account)];
    if (!id) return stores;
    if (to === 'poolId') stores.push((await prepareMissing(db, [id], (d, k) => d.run(SELECT.one.from(Pools).where({ poolId: k })), poolIndex)).store);
    else stores.push((await prepareMissing(db, [id], (d, k) => d.run(SELECT.one.from(Dreps).where({ drepId: k })), drepIndex)).store);
    return stores;
  }

  // A block and, when asked, its epoch. Blocks.epoch joins on epochNumber, so a stored block finds
  // its epoch once the epoch row exists.
  async function prepareBlock(db: cds.Transaction, hash: string, withEpoch: boolean): Promise<PendingStore[]> {
    const stored = await readOutside(db, (d) => d.run(SELECT.one.from(Blocks).columns('epochNumber').where({ hash }))) as { epochNumber?: number | null } | undefined;
    const block = stored ? null : await blockIndex.fetch(db, hash);
    // a fetched block carries its epoch when the backend had it
    const epochNumber = stored ? stored.epochNumber : block?.epoch ? null : block?.block.epoch;
    const epoch = withEpoch && epochNumber != null && !(await readOutside(db, (d) => finalEpoch(d, epochNumber)))
      ? await epochIndex.fetch(db, epochNumber)
      : null;
    return [
      async () => { if (block && !(await db.run(SELECT.one.from(Blocks).where({ hash })))) await blockIndex.store(db, block); },
      async () => { if (epoch) await epochIndex.store(db, epoch); },
    ];
  }

  // Transactions('h')/inputs(…)/address and below: the transaction, then the address of that input
  // or output, from its stored row or from the fetched transaction.
  async function prepareTransactionStepAddress(db: cds.Transaction, hash: string, step: 'inputs' | 'outputs', keys: Record<string, unknown>): Promise<PendingStore[]> {
    const indexField = step === 'inputs' ? 'inputIndex' : 'outputIndex';
    const position = Number(keys[indexField]);
    const stored = await readOutside(db, (d) => d.run(SELECT.one.from(Transactions).columns('txSeq').where({ hash }))) as { txSeq?: number | string } | undefined;
    let fetched: Awaited<ReturnType<typeof transactionIndex.fetch>> | null = null;
    let address: string | null | undefined;
    if (stored) {
      const row = await readOutside(db, (d) => d.run(SELECT.one.from(step === 'inputs' ? TransactionInputs : TransactionOutputs)
        .columns('address_address').where({ txSeq: stored.txSeq, [indexField]: position }))) as { address_address?: string | null } | undefined;
      address = row?.address_address;
    } else {
      fetched = await transactionIndex.fetch(db, hash);
      address = step === 'inputs'
        ? fetched.inputs?.[position]?.address
        : fetched.outputs?.find((o) => o.outputIndex === position)?.address;
    }
    const storeAddress = await prepareAddresses(db, [address]);
    const tx = fetched;
    return [
      async () => { if (tx && !(await db.run(SELECT.one.from(Transactions).where({ hash })))) await transactionIndex.store(db, tx); },
      storeAddress,
    ];
  }

  /** TransactionInputs(…)/address and TransactionOutputs(…)/address: the address of the stored row. */
  async function prepareRowAddress(db: cds.Transaction, entity: unknown, keys: Record<string, unknown>): Promise<PendingStore[]> {
    const row = await readOutside(db, (d) => d.run(SELECT.one.from(entity as never).columns('address_address').where(keys))) as { address_address?: string | null } | undefined;
    return [await prepareAddresses(db, [row?.address_address])];
  }

  /** The preparations a navigation read needs, by its parent. */
  async function prepareNavigation(req: Request, db: cds.Transaction, nav: NavigationRead): Promise<PendingStore[]> {
    const select = (req.query as { SELECT: PagePart }).SELECT;
    switch (nav.parent) {
      case 'Transactions': {
        const hash = nav.keys.hash;
        if (!isTxHash(hash)) rejectInvalid(req, 'Transactions', 'Invalid transaction hash format', 'hash');
        if ((nav.nav === 'inputs' || nav.nav === 'outputs') && nav.navKeys && nav.steps[1] === 'address') {
          return prepareTransactionStepAddress(db, hash as string, nav.nav, nav.navKeys);
        }
        return [(await prepareMissing(db, [hash], (d, k) => d.run(SELECT.one.from(Transactions).where({ hash: k })), transactionIndex)).store];
      }
      case 'TransactionInputs':
      case 'TransactionOutputs':
        return nav.nav === 'address' ? prepareRowAddress(db, nav.parent === 'TransactionInputs' ? TransactionInputs : TransactionOutputs, nav.keys) : [];
      case 'Addresses': {
        const address = nav.keys.address;
        if (!isValidBech32Address(address)) rejectInvalid(req, 'Addresses', 'Invalid bech32 address format', 'address');
        return [await prepareAddresses(db, [address as string])];
      }
      case 'Blocks': {
        const hash = nav.keys.hash;
        if (!isBlockHash(hash)) rejectInvalid(req, 'Blocks', 'Invalid block hash format', 'hash');
        return prepareBlock(db, hash as string, nav.nav === 'epoch');
      }
      case 'Accounts': {
        const stakeAddress = nav.keys.stakeAddress;
        if (!isValidBech32StakeAddress(stakeAddress)) rejectInvalid(req, 'Accounts', 'Invalid stake address format', 'stakeAddress');
        const account = accountSource(db, stakeAddress as string);
        if (nav.nav === 'Address') return prepareAccountAddressRead(req, db, account, nav, select, accountAddressTotals);
        if (nav.nav === 'poolId' || nav.nav === 'drepId') return prepareAccountTarget(db, account, nav.nav);
        return [(await prepareMissing(db, [stakeAddress], (d, k) => d.run(SELECT.one.from(Accounts).where({ stakeAddress: k })), accountIndex)).store];
      }
      default:
        return [];
    }
  }

  /** The `$expand` columns of a read, by the association they expand. */
  function expandsOf(req: Request): Map<string, PagePart> {
    const columns = (req.query as { SELECT?: { columns?: unknown[] } }).SELECT?.columns ?? [];
    const found = new Map<string, PagePart>();
    for (const c of columns) {
      const col = c as { expand?: unknown; ref?: unknown[] };
      if (col.expand !== undefined && typeof col.ref?.[0] === 'string') found.set(col.ref[0], c as PagePart);
    }
    return found;
  }

  // The preparations the $expand of a keyed Accounts or Blocks read needs. The keyed row itself is
  // indexed by its own READ handler; this covers what the expand joins.
  async function prepareExpands(req: Request, db: cds.Transaction, expands: Map<string, PagePart>): Promise<PendingStore[]> {
    if (req.target?.name === Blocks.name) {
      const hash = readKey(req, 'hash');
      if (!expands.has('epoch') || typeof hash !== 'string') return [];
      if (!isBlockHash(hash)) rejectInvalid(req, 'Blocks', 'Invalid block hash format', 'hash');
      return prepareBlock(db, hash, true);
    }
    const stakeAddress = readKey(req, 'stakeAddress');
    if (typeof stakeAddress !== 'string') return [];
    if (!isValidBech32StakeAddress(stakeAddress)) rejectInvalid(req, 'Accounts', 'Invalid stake address format', 'stakeAddress');
    const account = accountSource(db, stakeAddress);
    const stores: PendingStore[] = [];
    const address = expands.get('Address');
    if (address) stores.push(...await prepareAccountAddressRead(req, db, account, null, address, expandAddressTotals));
    for (const to of ['poolId', 'drepId'] as const) {
      if (expands.has(to)) stores.push(...await prepareAccountTarget(db, account, to));
    }
    return stores;
  }

  srv.before('READ', async (req: Request) => {
    const nav = navigationOf(req);
    const keyedTarget = req.target?.name === Accounts.name || req.target?.name === Blocks.name;
    const expands = !nav && keyedTarget ? expandsOf(req) : new Map<string, PagePart>();
    if (!nav && !expands.size) return;
    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      const stores = nav ? await prepareNavigation(req, db, nav) : await prepareExpands(req, db, expands);
      for (const store of stores) await store();
    });
  });

  // The $count of a narrowed account address read is the account's total, not the page's.
  srv.after('READ', Addresses, (_rows: unknown, req: Request) => {
    const total = accountAddressTotals.get(req);
    if (total === undefined) return;
    const result = req.results as Array<{ $count?: unknown }> & { $count?: unknown };
    const columns = (req.query as { SELECT?: { columns?: Array<{ as?: string }>; count?: boolean } }).SELECT;
    if (columns?.columns?.length === 1 && columns.columns[0].as === '$count' && result?.[0]) result[0].$count = total;
    else if (columns?.count && result) result.$count = total;
  });

  // The same for `$expand=Address($count=true)` of a keyed Accounts read.
  srv.after('READ', Accounts, (_rows: unknown, req: Request) => {
    const total = expandAddressTotals.get(req);
    if (total === undefined) return;
    const rows = req.results as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
    for (const row of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      if (row && 'Address@odata.count' in row) row['Address@odata.count'] = String(total);
    }
  });

  logger.debug('All handlers registered');
};
