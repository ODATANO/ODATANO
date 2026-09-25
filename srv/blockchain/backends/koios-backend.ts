import cds from '@sap/cds';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { CardanoBackend, PaginatingBackend, EnumeratingBackend } from './cardano-backend';
import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, NotFoundError, ProviderUnavailableError, isPostgrestServerErrorCode } from '../../utils/errors';
import { normalizeCostModels, decodeAssetName } from '../../utils/mappers';
import { CARDANO_DEFAULTS } from '../../utils/const';
import { inlineDatumToHex } from '../../utils/tx-build-helper';

const logger = cds.log('KoiosBackend');

import {
  Transaction,
  BlockData,
  Address,
  UTxO,
  NetworkInformation,
  EpochData,
  JSONValue,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData,
  AssetInfo,
  AssetHistoryEntry,
  Amount,
  LedgerProtocolParameters,
  TxCertificate,
  CertificateKind,
  TxInputLine,
  TxOutputLine
} from '../../utils/types';
import { Network } from '../cardano-client';

/** Bounded retries for instance-specific PostgREST server errors (42703, 57014, …). */
const PG_SERVER_ERROR_MAX_RETRIES = 2;
const PG_SERVER_ERROR_RETRY_DELAY_MS = 300;

const KOIOS_URLS: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

/** Shape of a Koios tx-in/tx-out row from /tx_info */
interface KoiosTxIO {
  address?: string;
  payment_addr?: { bech32?: string };
  tx_hash: string;
  tx_index: number;
  value: string;
  datum_hash?: string | null;
  inline_datum?: unknown;
  reference_script?: unknown;
  asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }>;
}

/** Shape of a Koios /tx_info response row */
interface KoiosTxInfo {
  tx_hash: string;
  block_hash: string;
  block_height: number | string;
  tx_timestamp?: number;
  block_time?: number;
  absolute_slot?: number;
  slot_no?: number;
  tx_block_index?: number;
  fee?: string;
  deposit?: string;
  tx_size: number;
  metadata?: Record<string, unknown> | null;
  inputs: KoiosTxIO[];
  outputs: KoiosTxIO[];
  /** False when the script phase failed (collateral consumed, regular ins/outs not applied). Absent on older Koios. */
  valid_contract?: boolean | null;
  collateral_inputs?: KoiosTxIO[] | null;
  /** Live Koios returns ONE object here (the spec says array); both shapes are accepted. */
  collateral_output?: KoiosTxIO | KoiosTxIO[] | null;
  reference_inputs?: KoiosTxIO[] | null;
  /**
   * Net mint/burn (`_assets: true`), quantity signed — negative is a burn. Absent on older
   * Koios; the indexer then derives the delta from inputs/outputs.
   */
  assets_minted?: Array<{ policy_id?: string; asset_name?: string | null; quantity?: string | number }> | null;
  /** `_withdrawals: true` only (crawler batch path); null/absent otherwise. */
  withdrawals?: Array<{ amount?: string | number; stake_addr?: string }> | null;
  /**
   * `_certs: true` only (crawler batch path). `type` is Koios' own vocabulary
   * (stake_registration, pool_delegation, …); `info` carries per-type fields.
   */
  certificates?: Array<{ index?: number | null; type?: string; info?: Record<string, unknown> | null }> | null;
}


interface KoiosUtxoRow {
  tx_hash: string;
  tx_index: number;
  address?: string;
  value: string;
  block_hash?: string;
  datum_hash?: string | null;
  reference_script?: unknown;
  inline_datum?: unknown;
  asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }>;
}

/**
 * Koios `reference_script` (`_extended: true`) is an object `{ hash, size, type, bytes, value }`.
 * Returns the full script CBOR when present (needed for local Plutus eval), else the hash.
 */
function koiosRefScriptBytes(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const obj = ref as { bytes?: string | null; hash?: string | null };
  return obj.bytes || obj.hash || null;
}

/** Like koiosRefScriptBytes, but strictly the script HASH (for *Hash fields). */
function koiosRefScriptHash(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const obj = ref as { hash?: string | null };
  return obj.hash || null;
}

/** Sort Koios /address_txs rows newest-first — Koios gives no ordering guarantee. */
function sortAddressTxsDesc<T extends { block_height?: number | string | null; block_time?: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    Number(b.block_height ?? b.block_time ?? 0) - Number(a.block_height ?? a.block_time ?? 0)
  );
}

/** CardanoBackend implementation on the Koios REST API (Axios). */
export class KoiosBackend implements CardanoBackend, PaginatingBackend, EnumeratingBackend {
  public readonly name = 'koios';
  private api: AxiosInstance;
  private network: Network;

  constructor(network: Network, timeoutMs: number, apiKey?: string) {
    const headers: Record<string, string> = {};

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    this.api = axios.create({
      baseURL: KOIOS_URLS[network],
      timeout: timeoutMs,
      headers,
    });
    this.network = network;

    // Koios is load-balanced; single instances serve broken SQL functions (PostgREST 400,
    // e.g. 42703) or statement timeouts (57014) while others are healthy, so a short
    // bounded retry usually lands on a healthy instance. Client-input errors are not retried.
    this.api.interceptors.response.use(undefined, async (error: AxiosError) => {
      const config = error.config as (InternalAxiosRequestConfig & { pgRetryCount?: number }) | undefined;
      const pgCode = (error.response?.data as { code?: unknown } | undefined)?.code;
      if (!config || !isPostgrestServerErrorCode(pgCode)) throw error;

      const attempt = (config.pgRetryCount ?? 0) + 1;
      if (attempt > PG_SERVER_ERROR_MAX_RETRIES) throw error;
      config.pgRetryCount = attempt;

      logger.warn(
        `Koios instance returned server-side SQL error ${pgCode} for ${config.url} — retry ${attempt}/${PG_SERVER_ERROR_MAX_RETRIES}`
      );
      await new Promise(resolve => setTimeout(resolve, PG_SERVER_ERROR_RETRY_DELAY_MS * attempt));
      return this.api.request(config);
    });
  }

  /** Probe /tip to verify connectivity. */
  async init(): Promise<boolean> {
    try {
    await this.api.get('/tip');
    } catch (error) {
      throw new BackendInitError('koios', error);
    }
    return true;
  }

  /**
   * Retry (500 → 1000 → 2000 ms) when Koios transiently returns [] for a valid query.
   * Element type is `any` on purpose: only non-emptiness is checked; rows are narrowed at use sites.
   */
  private async fetchWithRetryOnEmpty(
    fn: () => Promise<{ data: any[] }>, // eslint-disable-line @typescript-eslint/no-explicit-any
    label: string
  ): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const maxRetries = 3;
    const baseDelayMs = 500;

    const result = await fn();
    if (!Array.isArray(result.data) || result.data.length > 0) {
      return result.data;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`${label}: Koios returned empty array, retry ${attempt}/${maxRetries} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      const retry = await fn();
      if (Array.isArray(retry.data) && retry.data.length > 0) {
        return retry.data;
      }
    }

    return [];
  }

  /**
   * Retry on Postgres 42804 ("structure of query does not match function result type"):
   * version-skewed Koios instances behind the load balancer return it for a request that
   * healthy instances serve fine. Other 400s still fail fast.
   */
  private async getWithRetryOn42804(
    url: string,
    config: AxiosRequestConfig,
    label: string
  ): Promise<{ data: any[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const maxRetries = 8;
    const baseDelayMs = 300;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.get(url, config);
      } catch (err: unknown) {
        const e = err as { response?: { status?: number; data?: { code?: string; message?: string } } };
        const isSkew =
          e?.response?.status === 400 &&
          (e.response.data?.code === '42804' ||
            /structure of query does not match function result type/i.test(e.response.data?.message ?? ''));
        if (!isSkew || attempt >= maxRetries) throw err;
        const delay = baseDelayMs * (attempt + 1);
        logger.warn(`${label}: Koios transient 42804 (grest version skew), retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * Get Transaction Data for specified transaction hash
   * @param hash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        const body = {
          _tx_hashes: [hash],
          _inputs: true,
          _metadata: true,
          _assets: true,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false,
        };

        const { data } = await this.api.post('/tx_info', body);

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Transaction', this.name);
        }

        const tx = data[0];
        return this._mapKoiosTx(tx);
      },
      this.name
    );
  }

  /** 
   * Get Block Data for specified block hash
   * @param blockHash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(blockHash: string): Promise<BlockData> {

    return handleBackendRequest(
      async () => {
        const results = await this.fetchWithRetryOnEmpty(
          () => this.api.post('/block_info', { _block_hashes: [blockHash] }),
          `getBlock(${blockHash})`
        );

        if (!results || results.length === 0) {
          throw new NotFoundError('Block', this.name);
        }

        return this.mapKoiosBlockInfo(results[0]);
      },
      this.name
    );
  }

  /** 
   * Get Epoch Data for specified epoch number
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(
      async () => {

        const results = await this.fetchWithRetryOnEmpty(
          () => this.getWithRetryOn42804('/epoch_info', { params: { _epoch_no: epochNumber } }, `getEpoch(${epochNumber})`),
          `getEpoch(${epochNumber})`
        );

        if (!results || results.length === 0) {
          throw new NotFoundError('Epoch', this.name);
        }

        const data = results[0];

        return {
          epoch: data.epoch_no,
          start_time: data.start_time,
          end_time: data.end_time,
          first_block_time: data.first_block_time,
          last_block_time: data.last_block_time,
          block_count: data.block_count,
          tx_count: data.tx_count,
          output: data.total_output,
          fees: data.total_fees,
          active_stake: data.active_stake,
        };
      },
      this.name
    );
  }

  /**
   * Get Address Data (without transactions - use getAddressTransactions() separately)
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/address_info', { _addresses: [address] });

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Address', this.name);
        }

        const addressData = data[0];
        const addressUtxos = await this.getAddressUtxos(address);

        // Sum balances from the mapped UTxOs; address_info's utxo_set may carry a null asset_list.
        const totals = new Map<string, bigint>();
        for (const u of addressUtxos) {
          for (const a of u.amount) {
            totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
          }
        }

        const amount: Amount[] = Array.from(totals.entries()).map(
          ([unit, quantity]) => ({
            unit,
            quantity: quantity.toString(),
          })
        );

        return {
          address: address,
          stakeAddress: addressData.stake_address || null,
          type: addressData.address_type,
          isScript: addressData.is_script,
          amount: amount,
          utxos: addressUtxos,
        };
      },
      this.name
    );
  }

  /**
   * Get Address Transactions
   * @param address bech32 address
   * @returns {Promise<Transaction[]>} list of transactions for this address
   */
  async getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return handleBackendRequest(
      async () => {
        const { data: addressTxs } = await this.api.post('/address_txs', { _addresses: [address] });

        // newest first, THEN limit (saves API calls); batch instead of unbounded Promise.all
        const limitedTxs = sortAddressTxsDesc(addressTxs as Array<{ tx_hash: string; block_height?: number }>).slice(0, limit);
        const batch = await this.getTransactionsBatch(limitedTxs.map(tx => tx.tx_hash));

        const transactions: Transaction[] = [];
        for (const tx of limitedTxs) {
          const resolved = batch.get(tx.tx_hash);
          if (resolved) transactions.push(resolved);
        }
        return transactions;
      },
      this.name
    );
  }

  /** 
   * Get Address UTxOs for specified address
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/address_utxos', { _addresses: [address], _extended: true });
        return (data as KoiosUtxoRow[]).map((utxo) => {
          const amount: Amount[] = [
            { unit: 'lovelace', quantity: utxo.value }
          ];

          // add native asset(s) if present
          if (utxo.asset_list && Array.isArray(utxo.asset_list)) {
            for (const asset of utxo.asset_list) {
              amount.push({
                unit: `${asset.policy_id}${asset.asset_name}`,
                quantity: asset.quantity
              });
            }
          }

          return {
            txHash: utxo.tx_hash,
            outputIndex: utxo.tx_index,
            address: address,
            amount: amount,
            blockHash: utxo.block_hash,
            datumHash: utxo.datum_hash || null,
            scriptRef: koiosRefScriptBytes(utxo.reference_script),
            inlineDatum: inlineDatumToHex(utxo.inline_datum),
          };
        });
      },
      this.name
    );
  }

  /**
   * UTxOs across all bech32 addresses sharing a payment credential (native Koios endpoint).
   * @param credHash 28-byte payment credential as 56-char lowercase hex
   */
  async getCredentialUtxos(credHash: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/credential_utxos', {
          _payment_credentials: [credHash],
          _extended: true,
        });
        return (data as KoiosUtxoRow[]).map((utxo) => {
          const amount: Amount[] = [
            { unit: 'lovelace', quantity: utxo.value }
          ];

          if (utxo.asset_list && Array.isArray(utxo.asset_list)) {
            for (const asset of utxo.asset_list) {
              amount.push({
                unit: `${asset.policy_id}${asset.asset_name}`,
                quantity: asset.quantity
              });
            }
          }

          return {
            txHash: utxo.tx_hash,
            outputIndex: utxo.tx_index,
            address: utxo.address ?? '',
            amount: amount,
            blockHash: utxo.block_hash,
            datumHash: utxo.datum_hash || null,
            scriptRef: koiosRefScriptBytes(utxo.reference_script),
            inlineDatum: inlineDatumToHex(utxo.inline_datum),
          };
        });
      },
      this.name
    );
  }

  /**
   * Get Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(
      async () => {
        // /totals works on mainnet but returns [] on preview/preprod
        const { data: totalsData } = await this.api.get('/totals', {
          params: { order: 'epoch_no.desc', limit: 1 }
        });
        
        if (totalsData && totalsData.length > 0) {
          const latest = totalsData[0];
          return {
            supply: {
              max: CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY,
              total: latest.supply || '0',
              circulating: latest.circulation || '0',
              locked: '0', // Not available in /totals
              treasury: latest.treasury || '0',
              reserves: latest.reserves || '0',
            },
            stake: {
              live: '0',
              active: '0',
            },
          };
        }
        
        // Testnet fallback: max supply from /genesis, remaining fields '0'
        const { data: genesisData } = await this.api.get('/genesis');

        if (!genesisData || !Array.isArray(genesisData) || genesisData.length === 0) {
          throw new NotFoundError('Genesis', this.name);
        }

        const genesis = genesisData[0];
        const maxSupply = genesis.maxlovelacesupply || CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY;

        return {
          supply: {
            max: maxSupply,
            total: maxSupply,
            circulating: maxSupply,
            locked: '0',
            treasury: '0',
            reserves: '0',
          },
          stake: {
            live: '0',
            active: '0',
          },
        };
      },
      this.name
    );
  }

  /** 
   * Get Transaction Metadata for specified transaction hash
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const body = {
          _tx_hashes: [tx_hash],
          _inputs: false,
          _metadata: true,
          _assets: false,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false,
        };

        const { data } = await this.api.post('/tx_info', body);

        if (data.length === 0 || data[0].metadata === null) {
          throw new NotFoundError('Transaction metadata', this.name);
        }
        const labels: MetadataLabelTx[] = Object.entries(data[0].metadata).map(
          ([label, json]) => ({
            txHash: tx_hash,
            label: +label,
            json: json as JSONValue,
          }));
        return labels;
      }, this.name
    );
  }

  /** 
   * Get Pool Data for specified pool id
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(
      async () => {

        const { data } = await this.api.post('/pool_info', { _pool_bech32_ids: [poolId] });

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Pool', this.name);
        }

        return this._mapKoiosPool(data[0], poolId);
      },
      this.name
    );
  }

  /** Map one Koios /pool_info row to the canonical PoolData. */
  private _mapKoiosPool(poolData: Record<string, any>, fallbackId: string): PoolData { // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      poolId: poolData.pool_id_bech32 || poolData.pool_id_hex || fallbackId,
      vrfKeyHash: poolData.vrf_key_hash,
      blocksMinted: poolData.block_count,
      // Koios pool_info has no blocks-in-current-epoch figure. null = not available;
      // a 0 would be indistinguishable from a real zero downstream.
      blocksEpoch: null,
      liveStake: poolData.live_stake || '0',
      liveSize: poolData.live_size || 0,
      liveDelegators: poolData.live_delegators || 0,
      // Koios reports saturation in PERCENT (75.42); PoolData holds a fraction (0.7542)
      // stored in Decimal(9, 4) — the percent value would overflow the column.
      liveSaturation: (Number(poolData.live_saturation) || 0) / 100,
      activeStake: poolData.active_stake || '0',
      activeSize: poolData.active_size || 0,
      pledge: poolData.pledge || '0',
      margin: poolData.margin || 0,
      fixedCost: poolData.fixed_cost || '0',
      rewardAccount: poolData.reward_addr,
    };
  }

  /**
   * Asset info from Koios `asset_info`: supply, mint/burn counts, minting tx, CIP-25 + CIP-26 metadata.
   * @param unit policyId + assetNameHex (concatenated hex)
   */
  async getAssetInfo(unit: string): Promise<AssetInfo> {
    return handleBackendRequest(
      async () => {
        if (unit.length < 56 || !/^[a-f0-9]+$/i.test(unit)) {
          throw new NotFoundError('Asset', this.name);
        }
        const policyId = unit.slice(0, 56);
        const assetNameHex = unit.slice(56);

        const { data } = await this.api.post('/asset_info', {
          _asset_list: [[policyId, assetNameHex]],
        });

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Asset', this.name);
        }

        const a = data[0];
        // Koios token_registry_metadata fields are typically strings, but the
        // CIP-26 registry permits {value, signatures} envelopes — accept either.
        const regRaw = (a.token_registry_metadata ?? null) as Record<string, unknown> | null;
        const regStr = (key: string): string | null => {
          const v = regRaw?.[key];
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
            return (v as { value: string }).value;
          }
          return null;
        };
        const regNum = (key: string): number | null => {
          const v = regRaw?.[key];
          if (typeof v === 'number') return v;
          if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'number') {
            return (v as { value: number }).value;
          }
          return null;
        };
        // Koios returns minting_tx_metadata as { "<label>": <CIP-25 payload> }; pick label 721 (CIP-25 default)
        const mintMeta = (a.minting_tx_metadata ?? null) as Record<string, unknown> | null;
        const onchainMetadata: JSONValue | null = mintMeta && typeof mintMeta === 'object'
          ? (mintMeta['721'] ?? mintMeta) as JSONValue
          : null;

        const decodeUtf8 = (hex: string | null | undefined): string | null => (hex ? decodeAssetName(hex) : null);

        const mintCnt = typeof a.mint_cnt === 'number' ? a.mint_cnt : 0;
        const burnCnt = typeof a.burn_cnt === 'number' ? a.burn_cnt : 0;

        return {
          unit,
          policyId,
          assetNameHex,
          assetName: a.asset_name_ascii ?? decodeUtf8(assetNameHex),
          fingerprint: a.fingerprint,
          totalSupply: a.total_supply ?? '0',
          mintOrBurnCount: mintCnt + burnCnt,
          initialMintTxHash: a.minting_tx_hash ?? null,
          initialMintTime: typeof a.creation_time === 'number' ? a.creation_time : null,
          onchainMetadata,
          registryName: regStr('name'),
          registryTicker: regStr('ticker'),
          registryDecimals: regNum('decimals'),
          registryDescription: regStr('description'),
          registryUrl: regStr('url'),
          registryLogo: regStr('logo'),
        };
      },
      this.name
    );
  }

  /**
   * Latest mint/burn events. Koios `asset_history` returns ALL events with `quantity` SIGNED
   * (negative = burn): action derives from the sign, `quantity` stores the absolute value,
   * `limit` is applied client-side after sorting by block_time desc.
   */
  async getAssetHistory(unit: string, limit: number = 100): Promise<AssetHistoryEntry[]> {
    return handleBackendRequest(
      async () => {
        if (unit.length < 56 || !/^[a-f0-9]+$/i.test(unit)) {
          throw new NotFoundError('Asset', this.name);
        }
        const policyId = unit.slice(0, 56);
        const assetNameHex = unit.slice(56);

        const { data } = await this.api.post('/asset_history', {
          _asset_list: [[policyId, assetNameHex]],
        });

        if (!Array.isArray(data) || data.length === 0) return [];

        const minting_txs = Array.isArray(data[0]?.minting_txs) ? data[0].minting_txs : [];
        const events: AssetHistoryEntry[] = minting_txs.map((entry: { quantity?: string | number; tx_hash?: string; block_time?: number; block_height?: number }) => {
          const rawQty = String(entry.quantity ?? '0');
          const isNegative = rawQty.startsWith('-');
          return {
            unit,
            txHash: entry.tx_hash,
            action: isNegative ? 'burn' : 'mint',
            quantity: isNegative ? rawQty.slice(1) : rawQty,
            blockTime: typeof entry.block_time === 'number' ? entry.block_time : null,
            blockHeight: typeof entry.block_height === 'number' ? entry.block_height : null,
          } as AssetHistoryEntry;
        });

        // Sort newest-first and cap at limit (defensive — Koios may return ascending)
        events.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
        return events.slice(0, Math.max(1, limit));
      },
      this.name
    );
  }

  /**
   * Get Drep Data for specified drep id
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(
      async () => {
        const body = {
          _drep_ids: [drepId],
        };

        const { data } = await this.api.post('/drep_info', body);

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Drep', this.name);
        }

        return this._mapKoiosDrep(data[0]);
      },
      this.name
    );
  }

  /** Map one Koios /drep_info row to the canonical DrepData. */
  private _mapKoiosDrep(drepData: Record<string, any>): DrepData { // eslint-disable-line @typescript-eslint/no-explicit-any
    // Koios /drep_info exposes either `expired`/`retired`/`last_active_epoch` (older schema)
    // or `drep_status` ('registered' | 'retired'), `active` and `expires_epoch_no`; read both.
    const retired: boolean = drepData.retired ?? drepData.drep_status === 'retired';
    const expired: boolean = drepData.expired ?? (drepData.active === false && !retired);
    return {
      drepId: drepData.drep_id,
      hex: drepData.hex,
      amount: drepData.amount,
      hasScript: drepData.has_script,
      // The newer schema has no last-activity epoch (`expires_epoch_no` differs in meaning) — 0 then.
      lastActiveEpoch: drepData.last_active_epoch ?? 0,
      expired,
      retired,
    };
  }

  /** 
   * Get Account Data for specified stake address
   * @param accountId account id
   * @returns {Promise<AccountData>} account data
   */
  async getAccount(accountId: string): Promise<AccountData> {
    return handleBackendRequest(
      async () => {

        const body = {
          _stake_addresses: [accountId],
        };
        const { data } = await this.api.post('/account_info', body);

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Account', this.name);
        }
        const addressDataResponse = await this.api.post('/account_addresses', body);

        // Koios returns [{ stake_address, addresses: [...] }], flatten to get all addresses
        const addressesFlat: string[] = addressDataResponse.data.flatMap((item: { addresses: string[] }) => item.addresses);
        const addresses: Address[] = [];
        const concurrent = 10;
        for (let i = 0; i < addressesFlat.length; i += concurrent) {
          const chunk = addressesFlat.slice(i, i + concurrent);
          const chunkResults = await Promise.all(chunk.map((addr: string) => this.getAddress(addr)));
          addresses.push(...chunkResults);
        }

        const accountData = data[0];
        return {
          stakeaddress: accountData.stake_address,
          active: accountData.active ?? false,
          activeEpoch: accountData.active_epoch ?? 0,
          controlledAmount: accountData.controlled_amount,
          rewardsSum: accountData.rewards_sum,
          withdrawalsSum: accountData.withdrawals_sum,
          reservesSum: accountData.reserves_sum,
          treasurySum: accountData.treasury_sum,
          withdrawableAmount: accountData.withdrawable_amount,
          poolId: accountData.pool_id || null,
          drepId: accountData.drep_id || null,
          addresses: addresses,
        };
      },
      this.name
    );
  }

  /** 
   * Submit Transaction
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    return handleBackendRequest(
      async () => {
        // Koios /submittx expects raw CBOR bytes with Content-Type: application/cbor
        const cborBytes = Buffer.from(signedTxCbor, 'hex');
        const { data } = await this.api.post('/submittx', cborBytes, {
          headers: { 'Content-Type': 'application/cbor' },
          // Prevent axios from JSON-serializing the Buffer
          transformRequest: [(d: unknown) => d],
        });
        return data.trim().replace(/^"|"$/g, '');
      },
      this.name
    );
  }

  /** 
   * Get Protocol Parameters
   * @returns {Promise<any>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get('/cli_protocol_params');

        return {
          network: this.network,
          epoch: 0, // Koios doesn't provide current epoch in this endpoint
          // --- Fees / Sizes ---
          minFeeA: data.txFeePerByte,
          minFeeB: data.txFeeFixed,
          maxBlockSize: data.maxBlockBodySize,
          maxTxSize: data.maxTxSize,
          maxBlockHeaderSize: data.maxBlockHeaderSize,
          // --- Deposits / Pools ---
          keyDeposit: data.stakeAddressDeposit.toString(),
          poolDeposit: data.stakePoolDeposit.toString(),
          eMax: data.poolRetireMaxEpoch,
          nOpt: data.stakePoolTargetNum,
          a0: data.poolPledgeInfluence,
          rho: data.monetaryExpansion,
          tau: data.treasuryCut,
          minPoolCost: data.minPoolCost.toString(),
          // --- Legacy / Misc ---
          decentralisationParam: 0, // deprecated in Conway era
          extraEntropy: null,
          protocolMajorVer: data.protocolVersion.major,
          protocolMinorVer: data.protocolVersion.minor,
          minUtxo: '0', // legacy, replaced by coinsPerUtxoSize
          nonce: '',
          // --- Plutus / Execution units ---
          costModels: JSON.stringify(normalizeCostModels(data.costModels || {})),
          priceMem: data.executionUnitPrices.priceMemory,
          priceStep: data.executionUnitPrices.priceSteps,
          maxTxExMem: data.maxTxExecutionUnits.memory.toString(),
          maxTxExSteps: data.maxTxExecutionUnits.steps.toString(),
          maxBlockExMem: data.maxBlockExecutionUnits.memory.toString(),
          maxBlockExSteps: data.maxBlockExecutionUnits.steps.toString(),
          // --- Babbage+ UTxO cost / Collateral ---
          maxValSize: data.maxValueSize.toString(),
          collateralPercent: data.collateralPercentage,
          maxCollateralInputs: data.maxCollateralInputs,
          coinsPerUtxoSize: data.utxoCostPerByte.toString(),
          // --- Housekeeping ---
          fetchedAt: new Date().toISOString(),
          source: this.name
        };
      },
      this.name
    );
  }

  /** 
   * Get Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
        const tipData = await this.fetchWithRetryOnEmpty(
          () => this.api.get('/tip'),
          'getLatestBlock'
        );

        if (!tipData || tipData.length === 0) {
          throw new NotFoundError('LatestBlock', this.name);
        }

        return await this.getBlock(tipData[0].hash);
      },
      this.name
    );
  }

  /**
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const tipData = await this.fetchWithRetryOnEmpty(
          () => this.api.get('/tip'),
          'getLatestEpoch'
        );

        if (!tipData || tipData.length === 0) {
          throw new NotFoundError('LatestEpoch', this.name);
        }

        const epochNo = tipData[0].epoch_no;
        try {
          return await this.getEpoch(epochNo);
        } catch {
          // Current epoch may not be available yet on Koios — fall back to previous
          return await this.getEpoch(epochNo - 1);
        }
      },
      this.name
    );
  }

  /**
   * Get the latest chain tip slot.
   * @returns {Promise<number>} current chain slot
   */
  async getCurrentSlot(): Promise<number> {
    return handleBackendRequest(
      async () => {
        const tipData = await this.fetchWithRetryOnEmpty(
          () => this.api.get('/tip'),
          'getCurrentSlot'
        );

        if (!tipData || tipData.length === 0) {
          throw new NotFoundError('Tip', this.name);
        }

        const slot = tipData[0].abs_slot;
        if (slot == null) {
          throw new ProviderUnavailableError(
            `${this.name}: /tip has no abs_slot`,
            this.name,
          );
        }
        return slot;
      },
      this.name
    );
  }

  /**
   * Check whether a UTxO is still unspent via Koios `POST /utxo_info`.
   * @param txHash 64-char lowercase hex
   * @param outputIndex non-negative integer
   * @returns {Promise<boolean>} true iff the UTxO exists and is unspent
   */
  async isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return false;
    return handleBackendRequest(
      async () => {
        const ref = `${txHash.toLowerCase()}#${outputIndex}`;
        const { data } = await this.api.post('/utxo_info', {
          _utxo_refs: [ref],
          _extended: false,
        });
        if (!Array.isArray(data) || data.length === 0) return false;
        return data[0].is_spent === false;
      },
      this.name
    );
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /**
   * Get transaction hashes for an address (lightweight — no full tx details).
   * @param address bech32 address
   * @param limit maximum number of hashes
   * @returns {Promise<string[]>} most recent tx hashes
   */
  async getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/address_txs', { _addresses: [address] });
        return sortAddressTxsDesc(data as Array<{ tx_hash: string; block_height?: number }>)
          .slice(0, limit)
          .map(tx => tx.tx_hash);
      },
      this.name
    );
  }

  /** crawler.certificates: ask /tx_info for certificates + withdrawals on the crawl's batch call. */
  private crawlCertificates = false;

  configureCrawl(options: { certificates: boolean }): void {
    this.crawlCertificates = Boolean(options.certificates);
  }

  /** Batch fetch transactions via POST /tx_info, chunked at 100 hashes (Koios limit). */
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    return handleBackendRequest(
      async () => {
        const BATCH_SIZE = 100;
        const result = new Map<string, Transaction>();

        for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
          const chunk = txHashes.slice(i, i + BATCH_SIZE);
          const { data } = await this.api.post('/tx_info', {
            _tx_hashes: chunk,
            _inputs: true,
            _metadata: true,
            _assets: true,
            // certificates + withdrawals only when the crawl will write them (larger payload)
            _withdrawals: this.crawlCertificates,
            _certs: this.crawlCertificates,
            _scripts: false,
            _bytecode: false,
          });

          if (data && Array.isArray(data)) {
            for (const tx of data) {
              result.set(tx.tx_hash, this._mapKoiosTx(tx));
            }
          }
        }

        // Warn about any missing transactions (requested but not returned by Koios)
        const missing = txHashes.filter(h => !result.has(h));
        if (missing.length > 0) {
          logger.warn({ missing, total: txHashes.length, returned: result.size }, 'getTransactionsBatch: some transactions not found');
        }

        return result;
      },
      this.name
    );
  }

  // ---------------------------------------------------------------------------
  // PaginatingBackend — forward iteration for the chain crawler
  // ---------------------------------------------------------------------------

  /** Map a Koios /block_info row to BlockData. */
  private mapKoiosBlockInfo(data: {
    block_time: number; block_height: number | null; hash: string; abs_slot: number | null;
    epoch_no: number | null; epoch_slot: number | null; vrf_key: string; block_size: number;
    tx_count: number; total_fees?: string | null;
  }): BlockData {
    return {
      time: data.block_time,
      height: data.block_height,
      hash: data.hash,
      slot: data.abs_slot,
      epoch: data.epoch_no,
      epochSlot: data.epoch_slot,
      slotLeader: data.vrf_key,
      size: data.block_size,
      txCount: data.tx_count,
      fees: data.total_fees,
    };
  }

  /**
   * Get a block by its height via the PostgREST-filtered /blocks list, then resolve
   * full data through /block_info.
   */
  async getBlockByHeight(height: number): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
        const rows = await this.fetchWithRetryOnEmpty(
          () => this.api.get(`/blocks?block_height=eq.${height}&limit=1`),
          `getBlockByHeight(${height})`
        );
        if (!rows.length) throw new NotFoundError('Block', this.name);
        return await this.getBlock(rows[0].hash);
      },
      this.name
    );
  }

  /**
   * Up to `count` blocks after `afterHash`, ascending. Koios has no "next after hash" endpoint:
   * list blocks above the anchor height (PostgREST gt + order + limit), then batch /block_info.
   * A known `afterHeight` skips the hash→height round-trip.
   */
  async getNextBlocks(afterHash: string, count: number, afterHeight?: number): Promise<BlockData[]> {
    return handleBackendRequest(
      async () => {
        let anchorHeight = afterHeight;
        if (anchorHeight != null && anchorHeight > 0) {
          // A height hint is not proof the cursor is still canonical: after a rollback Koios
          // keeps listing blocks above H while `afterHash` is orphaned. Validate the hash first
          // so the crawler enters reorg recovery.
          const canonical = await this.fetchWithRetryOnEmpty(
            () => this.api.get(`/blocks?block_height=eq.${anchorHeight}&limit=1`),
            `getNextBlocks/anchor(${anchorHeight})`
          );
          const canonicalHash = canonical[0]?.hash;
          if (!canonicalHash) {
            throw new ProviderUnavailableError(
              `Unable to validate canonical block at height ${anchorHeight}`,
              this.name
            );
          }
          if (canonicalHash !== afterHash) {
            throw new ProviderUnavailableError(
              `CHAIN_POINT_MISMATCH: cursor block ${afterHash} at height ${anchorHeight} is no longer canonical (canonical block: ${canonicalHash})`,
              this.name
            );
          }
        } else {
          const info = await this.fetchWithRetryOnEmpty(
            () => this.api.post('/block_info', { _block_hashes: [afterHash] }),
            `getNextBlocks/height(${afterHash})`
          );
          if (!info.length) throw new NotFoundError('Block', this.name);
          anchorHeight = info[0].block_height;
        }

        const rows = await this.fetchWithRetryOnEmpty(
          () => this.api.get(`/blocks?block_height=gt.${anchorHeight}&order=block_height.asc&limit=${count}`),
          `getNextBlocks(${afterHash})`
        );
        if (!rows.length) return [];

        const requestedHashes: string[] = rows.map((r: { hash: string }) => r.hash);
        const infos = await this.fetchWithRetryOnEmpty(
          () => this.api.post('/block_info', { _block_hashes: requestedHashes }),
          `getNextBlocks/info(${afterHash})`
        );
        // Load-balanced instances can return a PARTIAL /block_info batch. Returning the subset
        // would advance the cursor past the missing block and leave a permanent hole (crawled
        // entities are never re-fetched), so fail the round as transient instead.
        if (infos.length < requestedHashes.length) {
          const returned = new Set(infos.map((d: { hash: string }) => d.hash));
          const missing = requestedHashes.filter((h) => !returned.has(h));
          throw new ProviderUnavailableError(
            `Incomplete /block_info batch: ${infos.length}/${requestedHashes.length} blocks returned (missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`,
            this.name
          );
        }
        return infos
          .map((d: Parameters<KoiosBackend['mapKoiosBlockInfo']>[0]) => this.mapKoiosBlockInfo(d))
          .sort((a: BlockData, b: BlockData) => (a.height ?? 0) - (b.height ?? 0));
      },
      this.name
    );
  }

  // ---------------------------------------------------------------------------
  // EnumeratingBackend — full pool/DRep set for the crawler's epoch snapshots
  // ---------------------------------------------------------------------------

  /** Rows per page when listing ids (PostgREST caps a response at 1000 rows). */
  private static readonly LIST_PAGE_SIZE = 1000;
  /** Ids resolved per /pool_info / /drep_info request. */
  private static readonly INFO_BATCH_SIZE = 50;
  /** Page cap — 500 pages is 500 000 ids, far beyond any real pool or DRep set. */
  private static readonly LIST_MAX_PAGES = 500;

  /**
   * Page through a PostgREST list endpoint and collect one id column. Stops on the first
   * short page, so a complete set costs exactly ceil(n / 1000) + 1 requests.
   */
  private async listAllIds(path: string, column: string, label: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 0; page < KoiosBackend.LIST_MAX_PAGES; page++) {
      const offset = page * KoiosBackend.LIST_PAGE_SIZE;
      const { data } = await this.getWithRetryOn42804(
        `${path}?select=${column}&limit=${KoiosBackend.LIST_PAGE_SIZE}&offset=${offset}`,
        {},
        label,
      );
      if (!Array.isArray(data) || data.length === 0) return ids;
      for (const row of data) {
        const id = (row as Record<string, unknown>)[column];
        if (typeof id === 'string' && id) ids.push(id);
      }
      if (data.length < KoiosBackend.LIST_PAGE_SIZE) return ids;
    }
    logger.warn(`${label}: stopped after ${KoiosBackend.LIST_MAX_PAGES} pages — the list may be truncated`);
    return ids;
  }

  /**
   * All stake-pool ids known to Koios (bech32), including retired ones — a snapshot that
   * silently dropped retiring pools would misreport the epoch's pool set.
   */
  async getPoolIds(): Promise<string[]> {
    return handleBackendRequest(
      () => this.listAllIds('/pool_list', 'pool_id_bech32', 'getPoolIds'),
      this.name,
    );
  }

  /**
   * Resolve pool ids in batches. Ids Koios does not return are omitted rather than
   * substituted with empty rows — a missing pool is better than an invented one.
   */
  async getPools(poolIds: string[]): Promise<PoolData[]> {
    return handleBackendRequest(
      async () => {
        const out: PoolData[] = [];
        for (let i = 0; i < poolIds.length; i += KoiosBackend.INFO_BATCH_SIZE) {
          const batch = poolIds.slice(i, i + KoiosBackend.INFO_BATCH_SIZE);
          const { data } = await this.api.post('/pool_info', { _pool_bech32_ids: batch });
          if (!Array.isArray(data)) continue;
          for (const row of data) out.push(this._mapKoiosPool(row, ''));
        }
        return out;
      },
      this.name,
    );
  }

  /** All DRep ids known to Koios (bech32). */
  async getDrepIds(): Promise<string[]> {
    return handleBackendRequest(
      () => this.listAllIds('/drep_list', 'drep_id', 'getDrepIds'),
      this.name,
    );
  }

  /** Resolve DRep ids in batches; unknown ids are omitted (see getPools). */
  async getDreps(drepIds: string[]): Promise<DrepData[]> {
    return handleBackendRequest(
      async () => {
        const out: DrepData[] = [];
        for (let i = 0; i < drepIds.length; i += KoiosBackend.INFO_BATCH_SIZE) {
          const batch = drepIds.slice(i, i + KoiosBackend.INFO_BATCH_SIZE);
          const { data } = await this.api.post('/drep_info', { _drep_ids: batch });
          if (!Array.isArray(data)) continue;
          for (const row of data) out.push(this._mapKoiosDrep(row));
        }
        return out;
      },
      this.name,
    );
  }

  /**
   * Full transaction list of a block in block order via /block_txs → /tx_info batch.
   * Accepts both the flattened ({tx_hash} per row) and the {tx_hashes:[...]} shape.
   */
  async getBlockTransactions(blockHash: string): Promise<Transaction[]> {
    return handleBackendRequest(
      async () => {
        const rows = await this.fetchWithRetryOnEmpty(
          () => this.api.post('/block_txs', { _block_hashes: [blockHash] }),
          `getBlockTransactions(${blockHash})`
        );
        const hashes: string[] = [];
        for (const row of rows) {
          if (Array.isArray(row.tx_hashes)) hashes.push(...row.tx_hashes);
          else if (row.tx_hash) hashes.push(row.tx_hash);
        }
        if (!hashes.length) return [];

        const byHash = await this.getTransactionsBatch(hashes);
        const missing = hashes.filter(h => !byHash.has(h));
        if (missing.length > 0) {
          // A partial /tx_info would make the omitted transactions permanent — 503 so the
          // crawler retries the whole block without persisting it.
          throw new ProviderUnavailableError(
            `Incomplete transaction data for block ${blockHash}: ${missing.length}/${hashes.length} transaction(s) missing`,
            this.name
          );
        }
        return hashes.map(h => byHash.get(h)!);
      },
      this.name
    );
  }

  //-----------------------------------------------------------------------------
  // Private Helpers
  //-----------------------------------------------------------------------------

  /** Map a Koios /tx_info row to the normalized Transaction. */
  private _mapKoiosTx(tx: KoiosTxInfo): Transaction {
    let labels: MetadataLabelTx[] = [];

    if (tx.metadata) {
      labels = Object.entries(tx.metadata).map(
        ([label, json]) => ({
          txHash: tx.tx_hash,
          label: +label,
          json: json as JSONValue,
        }));
    }

    return {
      hash: tx.tx_hash,
      blockHash: tx.block_hash,
      blockHeight: Number(tx.block_height),
      blockTime: tx.tx_timestamp ?? tx.block_time ?? 0,
      slot: tx.absolute_slot ?? tx.slot_no ?? 0,
      // Koios spells these `tx_block_index` and `fee` (not `tx_index` / `tx_fee`)
      index: tx.tx_block_index ?? 0,
      fee: tx.fee || '0',
      deposit: tx.deposit || '0',
      // undefined (not []) when Koios does not report the field at all — the indexer then
      // falls back to the input/output delta instead of reading "no mint" into a gap.
      mint: Array.isArray(tx.assets_minted)
        ? tx.assets_minted
            .filter((a) => a?.policy_id && a.quantity != null)
            .map((a) => ({
              unit: `${a.policy_id}${a.asset_name ?? ''}`,
              quantity: String(a.quantity),
            }))
        : undefined,
      size: tx.tx_size,
      // Phase-2 validity as db-sync records it; undefined on a Koios without the field, so the
      // indexer keeps treating such a source as "no phase-2 information".
      spendsCollaterals: typeof tx.valid_contract === 'boolean' ? tx.valid_contract === false : undefined,
      inputs: [
        ...asKoiosList(tx.inputs).map((input) => mapKoiosInput(input)),
        ...asKoiosList(tx.collateral_inputs).map((input) => mapKoiosInput(input, { isCollateral: true })),
        ...asKoiosList(tx.reference_inputs).map((input) => mapKoiosInput(input, { isReference: true })),
      ],
      outputs: [
        ...asKoiosList(tx.outputs).map((output) => mapKoiosOutput(tx.tx_hash, output, false)),
        // CIP-40 collateral return: produced only when the script phase failed
        ...asKoiosList(tx.collateral_output).map((output) => mapKoiosOutput(tx.tx_hash, output, true)),
      ],
      metadata: labels,
      // undefined (not []) when the call did not ask for them (`_certs: false` on the lazy
      // path) — the indexer tells "none" from "not reported" by exactly this.
      certificates: Array.isArray(tx.certificates) ? mapKoiosCertificates(tx.certificates) : undefined,
      withdrawals: Array.isArray(tx.withdrawals)
        ? tx.withdrawals
            .filter((w) => !!w.stake_addr)
            .map((w) => ({ stakeAddress: String(w.stake_addr), amount: String(w.amount ?? '0') }))
        : undefined,
    };
  }
}

/**
 * Koios is loose about shapes: `collateral_output` arrives as one object (the spec says
 * array) and `asset_list` on it as the JSON STRING "[]". Normalize both before mapping.
 */
function asKoiosList<T>(v: T | T[] | string | null | undefined): T[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const parsed: unknown = JSON.parse(v); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
  }
  return v && typeof v === 'object' ? [v] : [];
}

function koiosAmount(io: KoiosTxIO): Amount[] {
  const amount: Amount[] = [{ unit: 'lovelace', quantity: io.value }];
  for (const asset of asKoiosList(io.asset_list as KoiosTxIO['asset_list'] | string)) {
    amount.push({ unit: `${asset.policy_id}${asset.asset_name}`, quantity: asset.quantity });
  }
  return amount;
}

function mapKoiosInput(input: KoiosTxIO, flags: { isCollateral?: boolean; isReference?: boolean } = {}): TxInputLine {
  return {
    address: input.payment_addr?.bech32 || input.address || '',
    txHash: input.tx_hash,
    outputIndex: input.tx_index,
    amount: koiosAmount(input),
    dataHash: input.datum_hash || null,
    inlineDatum: inlineDatumToHex(input.inline_datum),
    referenceScriptHash: koiosRefScriptHash(input.reference_script),
    ...flags,
  };
}

function mapKoiosOutput(txHash: string, output: KoiosTxIO, isCollateral: boolean): TxOutputLine {
  return {
    address: output.payment_addr?.bech32 || output.address || '',
    amount: koiosAmount(output),
    txHash,
    outputIndex: output.tx_index,
    dataHash: output.datum_hash || null,
    inlineDatum: inlineDatumToHex(output.inline_datum),
    isCollateral,
    referenceScriptHash: koiosRefScriptHash(output.reference_script),
  };
}

/** Koios certificate `type` → shared `CertificateKind`; anything else passes through raw. */
const KOIOS_CERT_KINDS: Record<string, CertificateKind> = {
  stake_registration: 'stake_registration',
  stake_deregistration: 'stake_deregistration',
  pool_delegation: 'pool_delegation',
  // older Koios releases named the pool delegation plainly
  delegation: 'pool_delegation',
  vote_delegation: 'vote_delegation',
  pool_update: 'pool_registration',
  pool_retire: 'pool_retirement',
  drep_registration: 'drep_registration',
  drep_update: 'drep_update',
  drep_retire: 'drep_retirement',
  drep_deregistration: 'drep_retirement',
  committee_hot_auth: 'committee_hot_auth',
  committee_resign: 'committee_resign',
  treasury_MIR: 'treasury_mir',
  reserve_MIR: 'reserve_mir',
  pot_transfer: 'pot_transfer',
  param_proposal: 'param_proposal',
};

/**
 * Normalize Koios `/tx_info` certificates (`_certs: true`). Field names inside `info` differ
 * per type (`retiring_epoch` is spelled `retiring epoch` in current Koios), so every alias is read.
 */
export function mapKoiosCertificates(
  certs: NonNullable<KoiosTxInfo['certificates']>
): TxCertificate[] {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  return certs.map((c, position) => {
    const info = c.info ?? {};
    const deposit = info.deposit;
    return {
      certIndex: num(c.index) ?? position,
      kind: (c.type && KOIOS_CERT_KINDS[c.type]) || c.type || 'other',
      stakeAddress: str(info.stake_address) ?? str(info.stake_addr),
      poolId: str(info.pool_id_bech32) ?? str(info.pool),
      drepId: str(info.drep_id),
      deposit: deposit != null && deposit !== '' ? String(deposit) : null,
      epoch: num(info.retiring_epoch) ?? num(info['retiring epoch']),
    };
  });
}
