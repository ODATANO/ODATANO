import cds from '@sap/cds';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { safeJSON } from '@cardano-ogmios/client';
import {
  CardanoBackend,
  EvaluatingBackend,
  PaginatingBackend,
  EnumeratingBackend,
} from './cardano-backend';
import { BackendInitError, NotFoundError, ProviderUnavailableError, RateLimitError, TransactionValidationError } from '../../utils/errors';
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

/** Public ODATANO API per network (ACCESS gateway); mainnet has no default and needs `odatanoUrl`. */
export const ODATANO_API_URLS: Partial<Record<Network, string>> = {
  preview: 'https://api.preview.odatano.dev',
  preprod: 'https://api.preprod.odatano.dev',
};

const SERVICE_PATH = '/odata/v4/cardano-backend';
/** Ids per GetPools / GetDreps call, below the service's list cap. */
const ENUMERATION_BATCH = 200;

/**
 * Backend over another ODATANO instance (typically the hosted API behind the ACCESS gateway),
 * speaking its `CardanoBackendService`. Answers arrive in the provider shape, so everything above
 * this class treats it like Koios. The key goes as `Authorization: Bearer`.
 */
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
  getAddressUtxos(address: string): Promise<UTxO[]> { return this.call('GetAddressUtxos', { address }); }
  getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return this.call('GetAddressTransactions', { address, limit });
  }
  getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    return this.call('GetAddressTransactionHashes', { address, limit });
  }
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    const out = new Map<string, Transaction>();
    for (let i = 0; i < txHashes.length; i += ENUMERATION_BATCH) {
      const found = await this.call<Record<string, Transaction>>('GetTransactionsBatch', {
        hashes: JSON.stringify(txHashes.slice(i, i + ENUMERATION_BATCH)),
      });
      for (const [hash, tx] of Object.entries(found ?? {})) out.set(hash, tx);
    }
    return out;
  }
  getCredentialUtxos(credHash: string): Promise<UTxO[]> { return this.call('GetCredentialUtxos', { credential: credHash }); }
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
  getAccount(stakeAddress: string): Promise<AccountData> { return this.call('GetAccount', { stakeAddress }); }
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
  getBlockTransactions(blockHash: string): Promise<Transaction[]> { return this.call('GetBlockTransactions', { blockHash }); }

  // --- EnumeratingBackend (epoch snapshots) -----------------------------------------------------
  getPoolIds(): Promise<string[]> { return this.call('GetPoolIds'); }
  getPools(poolIds: string[]): Promise<PoolData[]> { return this.batched('GetPools', poolIds); }
  getDrepIds(): Promise<string[]> { return this.call('GetDrepIds'); }
  getDreps(drepIds: string[]): Promise<DrepData[]> { return this.batched('GetDreps', drepIds); }

  async shutdown(): Promise<void> { /* stateless HTTP */ }

  private async batched<T>(operation: string, ids: string[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ENUMERATION_BATCH) {
      out.push(...await this.call<T[]>(operation, { ids: JSON.stringify(ids.slice(i, i + ENUMERATION_BATCH)) }));
    }
    return out;
  }

  /**
   * POST one operation, parse the JSON string it answers (safeJSON keeps big integers) and map
   * HTTP failures to the backend error classes. The remote message is kept verbatim, so markers
   * such as `CHAIN_POINT_MISMATCH:` reach the crawler unchanged.
   */
  private async call<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
    try {
      const res = await this.api.post(`/${operation}`, body);
      const left = Number(res.headers?.['x-access-units-left']);
      if (Number.isFinite(left)) this.unitsLeft = left;
      const value = (res.data as { value?: unknown } | undefined)?.value;
      return (typeof value === 'string' ? safeJSON.parse(value) : value) as T;
    } catch (err) {
      throw this.mapError(operation, err);
    }
  }

  private mapError(operation: string, err: unknown): Error {
    const ax = err as AxiosError<{ error?: { message?: string } }>;
    if (!ax?.isAxiosError) return err instanceof Error ? err : new Error(String(err));
    const status = ax.response?.status;
    const message = ax.response?.data?.error?.message ?? ax.message;
    // NotFoundError appends " not found" itself; the remote message already ends with it
    if (status === 404) return new NotFoundError(message.replace(/ not found$/, ''), this.name);
    if (status === 429) {
      const retryAfter = Number(ax.response?.headers?.['retry-after']);
      return new RateLimitError(message, this.name, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    if (status === 400) return new TransactionValidationError(message);
    if (status === 401 || status === 402 || status === 403) {
      logger.error(`${operation}: the remote ODATANO refused the key (${status}): ${message}`);
    }
    return new ProviderUnavailableError(message, this.name);
  }
}
