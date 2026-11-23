import cds from '@sap/cds';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { parseJson } from '../../utils/deep-json';
import {
  CardanoBackend,
  EvaluatingBackend,
  PaginatingBackend,
  EnumeratingBackend,
} from './cardano-backend';
import { BackendInitError, NotFoundError, ProviderUnavailableError, RateLimitError, ScriptValidationError, TransactionAlreadySubmittedError, TransactionValidationError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { callSignal, throwIfCallAborted } from './call-signal';
import type {
  Transaction,
  Address,
  UTxO,
  NetworkInformation,
  EpochData,
  MetadataLabelTx,
  BlockData,
  PoolData,
  DrepData,
  AccountData,
  AssetInfo,
  AssetHistoryEntry,
  LedgerProtocolParameters,
  ScriptEvaluationResult,
} from '../../utils/types';
import { Network } from '../cardano-client';

const logger = cds.log('OdatanoBackend');

// `scriptRef` is the script hash. An older remote fed by Koios sends the script CBOR there instead;
// that moves to `scriptRefCbor`, and the hash stays unknown.
function scriptRefAsHash(u: UTxO): UTxO {
  if (!u.scriptRef || u.scriptRef.length <= 56) return u;
  return { ...u, scriptRef: null, scriptRefCbor: u.scriptRefCbor ?? u.scriptRef };
}

/** Public ODATANO API per network; mainnet has no default and needs `odatanoUrl`. */
export const ODATANO_API_URLS: Partial<Record<Network, string>> = {
  preview: 'https://api.preview.odatano.dev',
  preprod: 'https://api.preprod.odatano.dev',
};

const SERVICE_PATH = '/odata/v4/cardano-backend';
/** Ids per GetPools / GetDreps call, below the service's list cap. */
const ENUMERATION_BATCH = 200;

// Backend over another ODATANO instance via its `CardanoBackendService`.
// Answers arrive in the provider shape, so callers treat it like Koios.
export class OdatanoBackend implements CardanoBackend, EvaluatingBackend, PaginatingBackend, EnumeratingBackend {
  public readonly name = 'odatano';
  private readonly api: AxiosInstance;
  /** Units left on the key, from the gateway's `x-access-units-left` header; null when not reported. */
  public unitsLeft: number | null = null;

  constructor(network: Network, timeoutMs: number, url: string | undefined, apiKey: string | undefined) {
    const baseURL = (url || ODATANO_API_URLS[network] || '').replace(/\/+$/, '');
    if (!baseURL) {
      throw new BackendInitError('odatano', new Error(`odatanoUrl is required on ${network}`));
    }
    if (!/^https?:\/\//i.test(baseURL)) {
      throw new BackendInitError('odatano', new Error(`odatanoUrl must be an http(s) URL, got "${baseURL}"`));
    }
    this.api = axios.create({
      baseURL: baseURL + SERVICE_PATH,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
  }

  /** Probe the remote instance with its cheapest call. */
  async init(): Promise<boolean> {
    await this.call<number>('GetCurrentSlot');
    return true;
  }

  // --- CardanoBackend ------------------------------------------------------------------------
  getTransaction(txHash: string): Promise<Transaction> { return this.call('GetTransaction', { hash: txHash }); }
  getAddress(address: string): Promise<Address> { return this.call('GetAddress', { address }); }
  async getAddressUtxos(address: string): Promise<UTxO[]> { return (await this.call<UTxO[]>('GetAddressUtxos', { address })).map(scriptRefAsHash); }
  getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return this.call('GetAddressTransactions', { address, limit });
  }
  getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    return this.call('GetAddressTransactionHashes', { address, limit });
  }
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    const out = new Map<string, Transaction>();
    for (let i = 0; i < txHashes.length; i += ENUMERATION_BATCH) {
      throwIfCallAborted();
      const found = await this.call<Record<string, Transaction>>('GetTransactionsBatch', {
        hashes: JSON.stringify(txHashes.slice(i, i + ENUMERATION_BATCH)),
      });
      for (const [hash, tx] of Object.entries(found ?? {})) out.set(hash, tx);
    }
    return out;
  }
  async getCredentialUtxos(credHash: string): Promise<UTxO[]> {
    return (await this.call<UTxO[]>('GetCredentialUtxos', { credential: credHash })).map(scriptRefAsHash);
  }
  /** Unspent outputs among `refs`, from the remote's node (with reference-script bytes). */
  async getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[]> {
    const out: UTxO[] = [];
    for (let i = 0; i < refs.length; i += ENUMERATION_BATCH) {
      throwIfCallAborted();
      out.push(...(await this.call<UTxO[]>('GetUnspentOutputs', { refs: JSON.stringify(refs.slice(i, i + ENUMERATION_BATCH)) })).map(scriptRefAsHash));
    }
    return out;
  }
  getNetworkInformation(): Promise<NetworkInformation> { return this.call('GetNetworkInformation'); }
  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> { return this.call('GetTransactionMetadata', { hash: txHash }); }
  getBlock(blockHash: string): Promise<BlockData> { return this.call('GetBlock', { hash: blockHash }); }
  getEpoch(epochNumber: number): Promise<EpochData> { return this.call('GetEpoch', { epoch: epochNumber }); }
  getLatestEpoch(): Promise<EpochData> { return this.call('GetLatestEpoch'); }
  getLatestBlock(): Promise<BlockData> { return this.call('GetLatestBlock'); }
  getCurrentSlot(): Promise<number> { return this.call('GetCurrentSlot'); }
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    return this.call('IsUtxoUnspent', { txHash, outputIndex });
  }
  getPool(poolId: string): Promise<PoolData> { return this.call('GetPool', { poolId }); }
  getDrep(drepId: string): Promise<DrepData> { return this.call('GetDrep', { drepId }); }
  async getAccount(stakeAddress: string): Promise<AccountData> {
    const account = await this.call<Omit<AccountData, 'addresses'> & { addresses?: Array<string | { address?: string }> }>('GetAccount', { stakeAddress });
    // an older remote lists the addresses as objects
    const addresses = (account.addresses ?? [])
      .map(a => (typeof a === 'string' ? a : a?.address))
      .filter((a): a is string => typeof a === 'string' && a.length > 0);
    return { ...account, addresses };
  }
  // The remote's own verdict. A remote without the operation answers 404, which says nothing about the account.
  async isRewardAccountRegistered(stakeAddress: string): Promise<boolean | null> {
    try {
      return await this.call<boolean | null>('IsRewardAccountRegistered', { stakeAddress });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }
  getAssetInfo(unit: string): Promise<AssetInfo> { return this.call('GetAssetInfo', { unit }); }
  getAssetHistory(unit: string, limit = 100): Promise<AssetHistoryEntry[]> { return this.call('GetAssetHistory', { unit, limit }); }
  getProtocolParameters(): Promise<LedgerProtocolParameters> { return this.call('GetProtocolParameters'); }
  submitTransaction(signedTxCbor: string): Promise<string> { return this.call('SubmitTransaction', { cbor: signedTxCbor }); }

  // --- EvaluatingBackend -----------------------------------------------------------------------
  evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    return this.call('EvaluateTransaction', { cbor: unsignedTxCbor });
  }

  // --- PaginatingBackend (crawler source) ------------------------------------------------------
  getBlockByHeight(height: number): Promise<BlockData> { return this.call('GetBlockByHeight', { height }); }
  getNextBlocks(afterHash: string, count: number, afterHeight?: number): Promise<BlockData[]> {
    return this.call('GetNextBlocks', { afterHash, count, afterHeight: afterHeight ?? null });
  }
  // The count is checked here, not sent: a remote of an earlier version refuses a parameter it does not know.
  async getBlockTransactions(blockHash: string, txCount?: number): Promise<Transaction[]> {
    const txs = await this.call<Transaction[]>('GetBlockTransactions', { blockHash });
    if (txCount !== undefined && txs.length !== txCount) {
      throw new ProviderUnavailableError(`Incomplete transaction list for block ${blockHash}: ${txs.length}/${txCount} transaction(s)`, this.name);
    }
    return txs;
  }

  // --- EnumeratingBackend (epoch snapshots) -----------------------------------------------------
  getPoolIds(): Promise<string[]> { return this.call('GetPoolIds'); }
  getPools(poolIds: string[]): Promise<PoolData[]> { return this.batched('GetPools', poolIds); }
  getDrepIds(): Promise<string[]> { return this.call('GetDrepIds'); }
  getDreps(drepIds: string[]): Promise<DrepData[]> { return this.batched('GetDreps', drepIds); }

  async shutdown(): Promise<void> { /* stateless HTTP */ }

  private async batched<T>(operation: string, ids: string[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ENUMERATION_BATCH) {
      throwIfCallAborted();
      out.push(...await this.call<T[]>(operation, { ids: JSON.stringify(ids.slice(i, i + ENUMERATION_BATCH)) }));
    }
    return out;
  }

  // POSTs one operation and parses the JSON answer with exact big integers.
  // The remote error message stays verbatim, so `CHAIN_POINT_MISMATCH:` reaches the crawler.
  private async call<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
    try {
      // the request stops when the client gives up the call it belongs to
      const signal = callSignal();
      const res = signal ? await this.api.post(`/${operation}`, body, { signal }) : await this.api.post(`/${operation}`, body);
      const left = Number(res.headers?.['x-access-units-left']);
      if (Number.isFinite(left)) this.unitsLeft = left;
      const value = (res.data as { value?: unknown } | undefined)?.value;
      return (typeof value === 'string' ? parseJson(value) : value) as T;
    } catch (err) {
      throw this.mapError(operation, err);
    }
  }

  private mapError(operation: string, err: unknown): Error {
    const ax = err as AxiosError<{ error?: { message?: string; code?: string } }>;
    if (!ax?.isAxiosError) return err instanceof Error ? err : new Error(String(err));
    const status = ax.response?.status;
    const message = ax.response?.data?.error?.message ?? ax.message;
    // older instances carry the code only as a `[CODE]` prefix of the message
    const code = ax.response?.data?.error?.code ?? message;
    // the remote prefixes `[CODE] Operation: `; the crawler recognises the reorg marker at the start
    const marker = message.indexOf('CHAIN_POINT_MISMATCH:');
    if (marker >= 0) return new ProviderUnavailableError(message.slice(marker), this.name);
    // NotFoundError appends " not found" itself; the remote message already ends with it
    if (status === 404) return new NotFoundError(message.replace(/ not found$/, ''), this.name);
    if (status === 429) {
      const retryAfter = Number(ax.response?.headers?.['retry-after']);
      return new RateLimitError(message, this.name, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    if (status === 409 && code.includes(ERROR_CODES.TX_ALREADY_SUBMITTED)) {
      return new TransactionAlreadySubmittedError(/[0-9a-f]{64}/.exec(message)?.[0] ?? '', message);
    }
    if (status === 400) {
      if (code.includes(ERROR_CODES.SCRIPT_VALIDATION_FAILURE)) return new ScriptValidationError(message);
      // the remote names a node refusal with its JSON-RPC code; it is kept so the refusal is classified alike
      const rpc = /node rejected the transaction \((3\d{3})\)/.exec(message);
      return new TransactionValidationError(message, rpc ? Object.assign(new Error(message), { code: Number(rpc[1]) }) : undefined);
    }
    if (status === 401 || status === 402 || status === 403) {
      logger.error(`${operation}: the remote ODATANO refused the key (${status}): ${message}`);
    }
    return new ProviderUnavailableError(message, this.name);
  }
}
