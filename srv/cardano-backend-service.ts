import cds, { Request } from '@sap/cds';
import { safeJSON } from '@cardano-ogmios/client';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, ProviderUnavailableError, ChainPointMismatchError } from './utils/errors';
import {
  isTxHash,
  isBlockHash,
  isAssetUnit,
  isValidCredential,
  isValidPoolId,
  isValidDrepId,
  isValidBech32Address,
  isValidBech32StakeAddress,
  isEpochNumber,
  isValidCbor,
} from './utils/validators';
import { getCardanoClient, getCardanoIndexer } from './server';
import {
  readBlock,
  readBlockByHeight,
  readNextBlocks,
  readBlockTransactions,
  readTransactionsByHash,
  lacksOutpoints,
  readTransactionMetadata,
} from './blockchain/stored-chain';
import type { PoolData, DrepData, Transaction as ProviderTransaction } from './utils/types';

const logger = cds.log('CardanoBackendService');

/** Largest list one call may ask for (hashes, refs, ids, blocks). */
const MAX_LIST = 500;
const MAX_LIMIT = 1000;

type Data = Record<string, unknown>;
type Db = Parameters<Parameters<typeof handleRequest>[1]>[0];

/**
 * CardanoBackendService: the provider shape for another ODATANO instance. Stored blocks and
 * transactions come from the index; the rest goes through the indexer's resolvers (crawled data
 * first, then this instance's backends). Answers are JSON strings (safeJSON keeps big integers).
 */
module.exports = (srv: cds.Service) => {
  const client = () => getCardanoClient();
  const indexer = () => getCardanoIndexer();

  /** Register an operation: validate, run, answer the JSON of the result. */
  const op = (name: string, run: (data: Data, db: Db) => Promise<unknown>, validate?: (req: Request, data: Data) => void) => {
    srv.on(name, async (req: Request) => {
      const data = (req.data ?? {}) as Data;
      validate?.(req, data);
      return handleRequest(req, async (db) => safeJSON.stringify(toPlain(await run(data, db))));
    });
  };

  // --- validation helpers ----------------------------------------------------------------------
  const need = (check: (v: unknown) => boolean, field: string, what: string) => (req: Request, data: Data) => {
    if (data[field] == null || data[field] === '') rejectMissing(req, req.event, field);
    if (!check(data[field])) rejectInvalid(req, req.event, `Invalid ${what}`, field);
  };
  const both = (...checks: Array<(req: Request, data: Data) => void>) => (req: Request, data: Data) => checks.forEach(c => c(req, data));
  const limitOf = (data: Data, fallback: number) => Math.min(Math.max(Number(data.limit) || fallback, 1), MAX_LIMIT);
  const jsonList = (field: string, check: (v: unknown) => boolean, what: string) => (req: Request, data: Data) => {
    if (data[field] == null) rejectMissing(req, req.event, field);
    let list: unknown;
    try { list = JSON.parse(String(data[field])); } catch { rejectInvalid(req, req.event, `${field} must be a JSON array`, field); }
    if (!Array.isArray(list) || list.length > MAX_LIST || !list.every(check)) {
      rejectInvalid(req, req.event, `${field} must be a JSON array of up to ${MAX_LIST} ${what}`, field);
    }
    data[field] = list;
  };
  const isRef = (r: unknown) => {
    const ref = r as { txHash?: unknown; outputIndex?: unknown };
    return isTxHash(ref?.txHash) && Number.isInteger(ref?.outputIndex) && Number(ref.outputIndex) >= 0;
  };

  // --- blocks and transactions -------------------------------------------------------------------
  op('GetTransaction', async ({ hash }, db) => {
    const stored = (await readTransactionsByHash(db, [String(hash)])).get(String(hash));
    if (stored && !lacksOutpoints(stored)) return stored;
    if (stored) {
      // An old row without input outpoints: the backend's copy when one can serve it
      if (!client().hasBackendFor('getTransaction')) return stored;
      return client().getTransaction(String(hash)).catch(() => stored);
    }
    await indexer().refuseOutsideCrawl(db, 'getTransaction', `Transaction ${hash}`);
    return client().getTransaction(String(hash));
  }, need(isTxHash, 'hash', 'transaction hash'));

  op('GetTransactionsBatch', async ({ hashes }, db) => {
    const wanted = hashes as string[];
    const found = await readTransactionsByHash(db, wanted);
    const absent = wanted.filter(h => !found.has(h));
    // old rows without input outpoints: the backend's copy replaces them when it has one
    const stale = wanted.filter(h => found.has(h) && lacksOutpoints(found.get(h)!));
    if ((absent.length || stale.length) && client().hasBackendFor('getTransactionsBatch')) {
      let fetched: Map<string, ProviderTransaction>;
      try {
        fetched = await client().getTransactionsBatch([...absent, ...stale]);
      } catch (err) {
        if (absent.length) throw err;
        fetched = new Map();
      }
      for (const [h, t] of fetched) found.set(h, t);
    }
    return found;
  }, jsonList('hashes', isTxHash, 'transaction hashes'));

  op('GetTransactionMetadata', async ({ hash }, db) => {
    const stored = await readTransactionMetadata(db, String(hash));
    if (stored) return stored;
    await indexer().refuseOutsideCrawl(db, 'getTransactionMetadata', `Transaction ${hash}`);
    return client().getTransactionMetadata(String(hash));
  }, need(isTxHash, 'hash', 'transaction hash'));

  op('GetBlock', async ({ hash }, db) => {
    const stored = await readBlock(db, String(hash));
    if (stored) return stored;
    await indexer().refuseOutsideCrawl(db, 'getBlock', `Block ${hash}`);
    return client().getBlock(String(hash));
  }, need(isBlockHash, 'hash', 'block hash'));

  op('GetBlockByHeight', async ({ height }, db) => {
    const stored = await readBlockByHeight(db, Number(height));
    if (stored) return stored;
    const paging = client().getPaginatingBackend();
    if (!paging) throw new ProviderUnavailableError(`Block at height ${height} is not indexed here`, 'odatano');
    return paging.getBlockByHeight(Number(height));
  }, need(v => Number.isInteger(Number(v)) && Number(v) >= 0, 'height', 'height'));

  op('GetNextBlocks', async ({ afterHash, count, afterHeight }, db) => {
    const n = Math.min(Math.max(Number(count) || 1, 1), MAX_LIST);
    const anchor = await readBlock(db, String(afterHash));
    if (anchor?.height != null) {
      const next = await readNextBlocks(db, anchor.height, n);
      if (next.length) return next;
    }
    // Unknown cursor block where this chain has another block at that height: the caller's
    // cursor was orphaned. The crawler recognises this prefix and enters reorg recovery.
    if (!anchor && afterHeight != null) {
      const canonical = await readBlockByHeight(db, Number(afterHeight));
      if (canonical) {
        throw new ChainPointMismatchError(
          `CHAIN_POINT_MISMATCH: cursor block ${afterHash} at height ${afterHeight} is no longer canonical (canonical block: ${canonical.hash})`,
          'odatano',
        );
      }
    }
    const paging = client().getPaginatingBackend();
    if (paging) {
      try {
        return await paging.getNextBlocks(String(afterHash), n, afterHeight == null ? undefined : Number(afterHeight));
      } catch (err) {
        // the provider's reorg marker, as 409 so it survives production error masking
        const message = err instanceof Error ? err.message : '';
        if (message.startsWith('CHAIN_POINT_MISMATCH:')) throw new ChainPointMismatchError(message, 'odatano');
        throw err;
      }
    }
    // Nothing indexed past the cursor yet: the caller is at this instance's tip.
    if (anchor) return [];
    throw new ChainPointMismatchError(`CHAIN_POINT_MISMATCH: cursor block ${afterHash} is unknown to this instance`, 'odatano');
  }, need(isBlockHash, 'afterHash', 'block hash'));

  op('GetBlockTransactions', async ({ blockHash }, db) => {
    const stored = await readBlockTransactions(db, String(blockHash));
    if (stored) return stored;
    const paging = client().getPaginatingBackend();
    if (!paging) throw new ProviderUnavailableError(`Transactions of block ${blockHash} are not indexed here`, 'odatano');
    return paging.getBlockTransactions(String(blockHash));
  }, need(isBlockHash, 'blockHash', 'block hash'));

  op('GetLatestBlock', async () => client().getLatestBlock());
  op('GetCurrentSlot', async () => client().getCurrentSlot());
  op('GetEpoch', async ({ epoch }) => client().getEpoch(Number(epoch)), need(isEpochNumber, 'epoch', 'epoch number'));
  op('GetLatestEpoch', async () => client().getLatestEpoch());

  // --- addresses and UTxOs -------------------------------------------------------------------------
  const address = need(isValidBech32Address, 'address', 'bech32 address');
  op('GetAddress', async ({ address: a }, db) => indexer().resolveAddress(db, String(a)), address);
  op('GetAddressUtxos', async ({ address: a }, db) => indexer().resolveAddressUtxos(db, String(a)), address);
  op('GetAddressTransactionHashes', async (data, db) =>
    indexer().resolveAddressTransactionHashes(db, String(data.address), limitOf(data, 10)), address);
  op('GetAddressTransactions', async (data, db) => {
    const hashes = await indexer().resolveAddressTransactionHashes(db, String(data.address), limitOf(data, 10));
    const found = await readTransactionsByHash(db, hashes);
    const missing = hashes.filter(h => !found.has(h));
    if (missing.length) for (const [h, t] of await client().getTransactionsBatch(missing)) found.set(h, t);
    return hashes.map(h => found.get(h)).filter(Boolean);
  }, address);
  op('GetCredentialUtxos', async ({ credential }, db) => indexer().resolveCredentialUtxos(db, String(credential)),
    need(isValidCredential, 'credential', 'payment credential'));
  op('IsUtxoUnspent', async ({ txHash, outputIndex }) => client().isUtxoUnspent(String(txHash), Number(outputIndex)),
    both(need(isTxHash, 'txHash', 'transaction hash'), need(v => Number.isInteger(Number(v)) && Number(v) >= 0, 'outputIndex', 'output index')));
  op('GetUnspentOutputs', async ({ refs }) => {
    const found = await client().getUnspentOutputs(refs as Array<{ txHash: string; outputIndex: number }>);
    if (found == null) throw new ProviderUnavailableError('Output lookup needs a ledger-state backend (Ogmios)', 'odatano');
    return found;
  }, jsonList('refs', isRef, 'output references'));

  // --- stake, governance, assets, network ------------------------------------------------------
  op('GetAccount', async ({ stakeAddress }, db) => indexer().resolveAccount(db, String(stakeAddress)),
    need(isValidBech32StakeAddress, 'stakeAddress', 'stake address'));
  op('GetPool', async ({ poolId }, db) => indexer().resolvePool(db, String(poolId)), need(isValidPoolId, 'poolId', 'pool id'));
  op('GetDrep', async ({ drepId }) => client().getDrep(String(drepId)), need(isValidDrepId, 'drepId', 'DRep id'));
  op('GetPoolIds', async () => (await enumeration()).pools.map(p => p.poolId));
  op('GetPools', async ({ ids }) => {
    const wanted = new Set(ids as string[]);
    return (await enumeration()).pools.filter(p => wanted.has(p.poolId));
  }, jsonList('ids', isValidPoolId, 'pool ids'));
  op('GetDrepIds', async () => (await enumeration()).dreps.map(d => d.drepId));
  op('GetDreps', async ({ ids }) => {
    const wanted = new Set(ids as string[]);
    return (await enumeration()).dreps.filter(d => wanted.has(d.drepId));
  }, jsonList('ids', isValidDrepId, 'DRep ids'));
  op('GetAssetInfo', async ({ unit }, db) => indexer().resolveAssetInfo(db, String(unit)), need(isAssetUnit, 'unit', 'asset unit'));
  op('GetAssetHistory', async (data, db) => indexer().resolveAssetHistory(db, String(data.unit), limitOf(data, 100)),
    need(isAssetUnit, 'unit', 'asset unit'));
  op('GetNetworkInformation', async (_data, db) => indexer().resolveNetworkInformation(db));
  op('GetProtocolParameters', async () => client().getProtocolParameters());

  // --- transactions in flight ------------------------------------------------------------------
  const cbor = need(isValidCbor, 'cbor', 'CBOR hex');
  op('EvaluateTransaction', async ({ cbor: c }) => client().evaluateTransaction(String(c)), cbor);
  op('SubmitTransaction', async ({ cbor: c }) => {
    const hash = await client().submitTransaction(String(c));
    logger.info(`submitted ${hash} for a remote instance`);
    return hash;
  }, cbor);

  /**
   * The full pool and DRep set: an enumerating backend (Koios) when configured, else the node's
   * ledger at the latest block (Ogmios). Cached for a minute; callers page through it by id.
   */
  let enumerated: { at: number; pools: PoolData[]; dreps: DrepData[] } | null = null;
  async function enumeration(): Promise<{ pools: PoolData[]; dreps: DrepData[] }> {
    if (enumerated && Date.now() - enumerated.at < 60_000) return enumerated;
    const koios = client().getEnumeratingBackend();
    if (koios) {
      const [pools, dreps] = await Promise.all([
        koios.getPoolIds().then(ids => koios.getPools(ids)),
        koios.getDrepIds().then(ids => koios.getDreps(ids)),
      ]);
      enumerated = { at: Date.now(), pools, dreps };
      return enumerated;
    }
    const ledger = client().getEpochStateBackend();
    if (!ledger) throw new ProviderUnavailableError('Pool/DRep enumeration needs Ogmios or Koios', 'odatano');
    const tip = await client().getLatestBlock();
    const state = await ledger.epochStateAt({ slot: tip.slot ?? 0, hash: tip.hash });
    enumerated = { at: Date.now(), pools: state.pools, dreps: state.dreps };
    return enumerated;
  }
};

/** Maps become objects, so a batch answer survives JSON. */
function toPlain(value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}
