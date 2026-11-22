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
import type { FetchedAddress } from './blockchain/cardano-indexer';
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
  const rows = await readOutside(db, async (d) => {
    const found: unknown[] = [];
    for (const key of keys) found.push(await exists(d, key));
    return found;
  });
  const fetched = new Map<number, F>();
  for (const [i, key] of keys.entries()) {
    if (!rows[i]) fetched.set(i, await index.fetch(db, key));
  }
  for (const [i, value] of fetched) {
    rows[i] = (await exists(db, keys[i])) || await index.store(db, value);
  }
  return rows;
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
function indexOnMissRead<K, F>(
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn | null,
  index: IndexOnMiss<K, F>,
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
        widenTemporalWindow(req);
        // The temporal aspect hides expired rows, so a miss here triggers a re-index.
        await indexMissing(db, [key as K], (d, k) => d.run(SELECT.one.from(entity as never).where({ [dbKey]: k })), index);
        // The client's query is the only authority on the result: never answer with the row
        // found here, or an excluding $filter / second key would yield a sibling row instead of 404.
      }
      return db.run(req.query);
    });
  };
}

/** Factory: action handler with required-key validation and index-on-miss. */
function indexOnMissAction<K, F>(
  actionName: string,
  entity: unknown,
  reqKeyField: string,
  validate: ValidateFn,
  index: IndexOnMiss<K, F>,
  options?: { entityKeyField?: string; errorMessage?: string }
) {
  const dbKey = options?.entityKeyField || reqKeyField;
  const errMsg = options?.errorMessage || `Invalid ${reqKeyField} format`;
  return async (req: Request) => {
    const key = (req.data as Record<string, unknown>)?.[reqKeyField];
    if (key == null) rejectMissing(req, actionName, reqKeyField);
    if (!validate(key)) rejectInvalid(req, actionName, errMsg, reqKeyField);

    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      // The temporal aspect hides expired rows, so a miss here triggers a re-index.
      const [row] = await indexMissing(db, [key as K], (d, k) => d.run(SELECT.one.from(entity as never).where({ [dbKey]: k })), index);
      return row;
    });
  };
}

/** Addresses one collection read may index on a miss; more is a 400. */
const MAX_ADDRESSES_PER_READ = 10;

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
        `CardanoODataService: '${name}' resolves to the SINGULAR cds-typer class: ` +
        `READ handlers registered with it never match under cds 10. Destructure the ` +
        `plural entity-set class instead (e.g. '${name}_ as ${name}').`
      );
    }
  }

  const indexer = () => getCardanoIndexer();

  // The read and the store half of each index-on-miss; the indexer is resolved per request.
  const blockIndex = indexPair((db, hash: string) => indexer().fetchBlock(db, hash), (db, fetched) => indexer().storeBlock(db, fetched));
  const epochIndex = indexPair((_db, epoch: number) => indexer().fetchEpoch(epoch), (db, fetched) => indexer().storeEpoch(db, fetched));
  const poolIndex = indexPair((db, poolId: string) => indexer().fetchPool(db, poolId), (db, fetched) => indexer().storePool(db, fetched));
  const accountIndex = indexPair((db, stakeAddress: string) => indexer().fetchAccount(db, stakeAddress), (db, fetched) => indexer().storeAccount(db, fetched));
  const drepIndex = indexPair((_db, drepId: string) => indexer().fetchDrep(drepId), (db, fetched) => indexer().storeDrep(db, fetched));
  const assetIndex = indexPair((db, unit: string) => indexer().resolveAssetInfo(db, unit), (db, fetched) => indexer().storeAsset(db, fetched));
  const addressIndex = indexPair((db, address: string) => indexer().fetchAddress(db, address), (db, fetched) => indexer().storeAddress(db, fetched));
  const transactionIndex = indexPair((db, hash: string) => indexer().fetchTransaction(db, hash), (db, fetched) => indexer().storeTransaction(db, fetched));
  const metadataIndex = indexPair((db, hash: string) => indexer().fetchTransactionMetadata(db, hash), (db, fetched) => indexer().storeTransactionMetadata(db, fetched));
  const networkIndex = indexPair((db, _key: null) => indexer().fetchNetworkInformation(db), (db, fetched) => indexer().storeNetworkInformation(db, fetched));
  const protocolParametersIndex = indexPair((db, _key: null) => indexer().fetchProtocolParameters(db), (db, fetched) => indexer().storeProtocolParameters(db, fetched));

  // ---------------------------------------------------------------------------
  // Network Information (singleton - no key field)
  // ---------------------------------------------------------------------------

  async function fetchNetworkInformation(db: cds.Transaction) {
    const [row] = await indexMissing(db, [null], (d) => d.run(SELECT.one.from(NetworkInformation)), networkIndex);
    return row;
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

  srv.on('READ', Blocks, indexOnMissRead(Blocks, 'hash', isBlockHash, blockIndex));
  srv.on('GetBlockByHash', indexOnMissAction('GetBlockByHash', Blocks, 'hash', isBlockHash, blockIndex));

  srv.on('GetLatestBlock', async (req: Request) => {
    return handleRequest(req, (db) => indexer().indexLatestBlock(db));
  });

  // ---------------------------------------------------------------------------
  // Epochs
  // ---------------------------------------------------------------------------

  srv.on('READ', Epochs, indexOnMissRead(Epochs, 'epoch', isEpochNumber, epochIndex, { errorMessage: 'epochNumber has invalid format' }));
  srv.on('GetEpochByNumber', indexOnMissAction('GetEpochByNumber', Epochs, 'epochNumber', isEpochNumber, epochIndex, { entityKeyField: 'epoch', errorMessage: 'epochNumber has invalid format' }));

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

  // Prefer the full address index; when no configured backend supports getAddress
  // (AllBackendsFailedError with zero collected errors, e.g. Ogmios only), fall back to a
  // UTxO-only index.
  const addressOrUtxosIndex: IndexOnMiss<string, FetchedAddress | { address: string; utxos: UTxO[] }> = {
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
      ? indexer().storeAddressUtxos(db, fetched.address, fetched.utxos)
      : indexer().storeAddress(db, fetched),
  };

  // An address is indexed when its Addresses row is valid. The UTxO-only fallback writes no
  // Addresses row, so for UTxOs a valid AddressUTxOs row counts as well.
  const addressIndexed = async (db: cds.Transaction, address: string) =>
    !!(await db.run(SELECT.one.from(Addresses).where({ address })));
  const addressUtxosIndexed = async (db: cds.Transaction, address: string) =>
    (await addressIndexed(db, address))
    || !!(await db.run(SELECT.one.from(AddressUTxOs).where({ address_address: address })));

  // GetUTxOsByAddress: indexes the address if needed, then queries child UTxOs.
  srv.on(GetUTxOsByAddress, async (req) => {
    const { address } = req.data;
    if (!address) rejectMissing(req, 'GetUTxOsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetUTxOsByAddress', 'Invalid bech32 address format', 'address');
    const page = pageOf(req.data, 1000);

    return handleRequest(req, async (db) => {
      widenTemporalWindow(req);
      await indexMissing(db, [address], addressUtxosIndexed, addressOrUtxosIndex);
      const utxos: AddressUTxO[] = await db.run(SELECT.from(AddressUTxOs).where({ address_address: address }));
      return pageRows(byOutRef(latestSlices(utxos, (utxo) => `${utxo.hash}#${utxo.index}`)), page);
    });
  });

  // Collection reads of the address child sets fill like the parent: an address named in the
  // navigation or the $filter is indexed on a miss, then the client's own query runs.
  srv.on('READ', AddressUTxOs, addressChildRead(addressUtxosIndexed, addressOrUtxosIndex));
  srv.on('READ', AddressAssets, addressChildRead(addressIndexed, addressIndex));

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

    return handleRequest(req, (db) => db.run(
      SELECT.from(TransactionMetadata).where({ id, txSeq: { '>=': txSeqOf(Number(fromSlot ?? 0), 0) } }).orderBy('txSeq').limit(limit, skip)
    ));
  });

  // ---------------------------------------------------------------------------
  // Protocol Parameters (singleton)
  // ---------------------------------------------------------------------------

  srv.on('READ', LedgerProtocolParameters, async (req: Request) => {
    return handleRequest(req, async (db) => {
      const [row] = await indexMissing(db, [null], (d) => d.run(SELECT.one.from(LedgerProtocolParameters)), protocolParametersIndex);
      return row;
    });
  });

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
      // each read in its own transaction: a waiting request holds no database connection
      for (;;) {
        const rows = newer(await runWithoutAmbientTx(() => cds.tx((tx) => indexer().indexAddressTransactions(tx, address, window))));
        const timeUp = Date.now() + ADDRESS_WAIT_POLL_MS > deadline || req.http?.res.destroyed === true;
        if (rows.length || timeUp) return pageRows(rows, page);
        await new Promise((resolve) => setTimeout(resolve, ADDRESS_WAIT_POLL_MS));
      }
    });
  });

  logger.debug('All handlers registered');
};
