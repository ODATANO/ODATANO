import cds from '@sap/cds';
import http from 'node:http';
import {
  createInteractionContext,
  createTransactionSubmissionClient,
  createLedgerStateQueryClient,
  createChainSynchronizationClient,
  Method
} from '@cardano-ogmios/client';
import { bech32 } from 'bech32';
import { blake2b_224 } from '@harmoniclabs/crypto';

import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, ChainSyncFrameError, NotFoundError, ProviderUnavailableError } from '../../utils/errors';
import { installOgmiosFrameGuard } from './ogmios-frame-guard';
import { epochOfSlot, epochStartSlot, slotToPosixSeconds } from '../../utils/epoch-slots';
import { normalizeCostModels, credentialToStakeAddress, credentialToDrepId } from '../../utils/mappers';
import {
  Transaction,
  BlockData,
  Address,
  UTxO,
  NetworkInformation,
  EpochData,
  MetadataLabelTx,
  PoolData,
  AccountData,
  DrepData,
  AssetInfo,
  LedgerProtocolParameters,
  ScriptEvaluationResult,
  Amount,
  TxInputLine,
  TxOutputLine,
  TxCertificate
} from '../../utils/types';

import { EvaluatingBackend, ChainSyncBackend, ChainSyncCallbacks, ChainSyncHandle, ChainPoint, LedgerStateBackend } from './cardano-backend';

import { BECH32_MAX_LENGTH, CARDANO_DEFAULTS, EPOCH_CONFIG_BY_NETWORK } from '../../utils/const';
import { Network } from '../cardano-client';

const logger = cds.log('OgmiosBackend');

/** Ogmios response shapes not fully typed in @cardano-ogmios/client. */
interface OgmiosStakePool {
  vrfVerificationKeyHash?: string;
  stake?: { ada?: { lovelace?: number | bigint } };
  // Ogmios v6 delivers pledge/cost as ValueAdaOnly ({ada:{lovelace}})
  pledge?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  margin?: number | string;
  cost?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  rewardAccount?: string;
}

/** Ogmios v6 `DelegateRepresentative`: a registered DRep credential or one of the two predefined DReps. */
interface OgmiosDelegateRepresentative {
  type: 'registered' | 'noConfidence' | 'abstain';
  id?: string;
  from?: 'verificationKey' | 'script';
}

interface OgmiosRewardAccountSummary {
  rewards?: { ada?: { lovelace?: number | bigint } } | number | bigint;
  stakePool?: { id?: string };
  delegateRepresentative?: OgmiosDelegateRepresentative;
}

/** Parse an Ogmios `Ratio` ("num/den", e.g. "3/1000") into a number; `Number("3/1000")` is NaN. */
function parseOgmiosRatio(ratio: string | number | undefined | null): number {
  if (ratio === null || ratio === undefined) return 0;
  if (typeof ratio === 'number') return ratio;
  const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(ratio);
  if (m) {
    const den = Number(m[2]);
    return den === 0 ? 0 : Number(m[1]) / den;
  }
  const n = Number(ratio);
  return Number.isFinite(n) ? n : 0;
}

const SCRIPT_LANGUAGE_TAG: Record<string, number> = { native: 0, 'plutus:v1': 1, 'plutus:v2': 2, 'plutus:v3': 3 };

/** Hash of an Ogmios `Script`: blake2b-224 over the language tag byte followed by the script CBOR. */
export function ogmiosScriptHash(script: unknown): string | null {
  const s = script as { language?: string; cbor?: string } | null | undefined;
  const tag = s?.language === undefined ? undefined : SCRIPT_LANGUAGE_TAG[s.language];
  if (tag === undefined || typeof s?.cbor !== 'string' || s.cbor.length === 0) return null;
  const bytes = Uint8Array.from(Buffer.concat([Buffer.from([tag]), Buffer.from(s.cbor, 'hex')]));
  return Buffer.from(blake2b_224(bytes)).toString('hex');
}

/** Bech32 pool id of a block issuer: blake2b-224 of its cold verification key. */
export function issuerKeyToPoolId(verificationKeyHex: string): string {
  const keyHash = blake2b_224(Uint8Array.from(Buffer.from(verificationKeyHex, 'hex')));
  return bech32.encode('pool', bech32.toWords(keyHash));
}

/** CIP-129 DRep id for a registered DRep, the predefined id for abstain / no confidence. */
function ogmiosDrepToId(d?: OgmiosDelegateRepresentative): string | null {
  if (!d) return null;
  if (d.type === 'abstain') return 'drep_always_abstain';
  if (d.type === 'noConfidence') return 'drep_always_no_confidence';
  return d.id ? credentialToDrepId(d.id, d.from === 'script') : null;
}

/** Lovelace amount from Ogmios' value shapes; v6 returns `{ ada: { lovelace } }` objects. */
function ogmiosValueToLovelaceString(value: OgmiosRewardAccountSummary['rewards']): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  const lovelace = value.ada?.lovelace;
  return lovelace === undefined ? '0' : String(lovelace);
}

/**
 * Ogmios v6 `queryLedgerState/delegateRepresentatives` summary (local wire type; the schema
 * package is only a transitive dependency). Only the `registered` variant carries an id.
 */
interface OgmiosDrepSummary {
  type: 'registered' | 'noConfidence' | 'abstain';
  id?: string;
  from?: 'verificationKey' | 'script';
  mandate?: { epoch?: number };
  stake?: { ada?: { lovelace?: number | bigint } };
  deposit?: { ada?: { lovelace?: number | bigint } };
}

/** Minimal JSON-RPC envelope seen by the raw `Method()` handler. */
interface OgmiosRpcEnvelope<T> {
  method?: string;
  result?: T;
  error?: { code?: number; message?: string };
}

/**
 * Decode a CIP-129 DRep ID (`drep1…`, 29 bytes) into credential hash and type. Header byte:
 * high nibble 0x2 = DRep, low nibble 0x2 = key hash / 0x3 = script hash.
 */
export function decodeDrepId(drepId: string): { hashHex: string; isScript: boolean } {
  const decoded = bech32.decode(drepId, BECH32_MAX_LENGTH);
  const bytes = Buffer.from(bech32.fromWords(decoded.words));
  if (decoded.prefix !== 'drep' || bytes.length !== 29) {
    throw new NotFoundError('Drep', 'ogmios');
  }
  return {
    hashHex: bytes.subarray(1).toString('hex'),
    isScript: (bytes[0] & 0x0f) === 0x03,
  };
}

/** Resolve Ogmios ledger tip which may be 'origin' (genesis block) or a point */
export function resolveOgmiosTip(tip: 'origin' | { slot: number; id: string }): { slot: number; hash: string } {
  return tip === 'origin' ? { slot: 0, hash: '' } : { slot: tip.slot, hash: tip.id };
}

/** Resolve Ogmios block height which may be 'origin' (genesis block) or a number */
export function resolveOgmiosHeight(height: 'origin' | number): number {
  return height === 'origin' ? 0 : height;
}

/**
 * Structural views of the Ogmios chain-sync `BlockPraos` / `Transaction` JSON we consume
 * (Shelley-era onward); declared locally so the mapper is not coupled to the schema package.
 */
interface OgmiosChainSyncTx {
  id: string;
  /** Which input/output partition was applied by the ledger (phase-2 validity). */
  spends: 'inputs' | 'collaterals';
  inputs: { transaction: { id: string }; index: number }[];
  references?: { transaction: { id: string }; index: number }[];
  collaterals?: { transaction: { id: string }; index: number }[];
  outputs: { address: string; value: { ada: { lovelace: number | bigint } } & Record<string, unknown>; datum?: string; datumHash?: string; script?: unknown }[];
  collateralReturn?: { address: string; value: { ada: { lovelace: number | bigint } } & Record<string, unknown>; datum?: string; datumHash?: string; script?: unknown };
  fee?: { ada: { lovelace: number | bigint } };
  /** `total_collateral` from the body — optional there, so absent on many phase-2 failures. */
  totalCollateral?: { ada: { lovelace: number | bigint } };
  /** Body mint field: policyId -> assetName -> signed quantity (negative = burn). Never contains `ada`. */
  mint?: Record<string, Record<string, number | bigint>>;
  metadata?: { labels?: Record<string, { json?: unknown; cbor?: string }> };
  certificates?: OgmiosCertificate[];
  /** Keyed by reward account (bech32 `stake…` / `stake_test…`). */
  withdrawals?: Record<string, { ada?: { lovelace?: number | bigint } }>;
}
/**
 * Ogmios v6 `Certificate` (cardano.json), structurally typed for the fields we index.
 * Unknown `type` values pass through as the raw kind so nothing is silently dropped.
 */
interface OgmiosCertificate {
  type: string;
  /** Stake credential hash (hex) + origin for stake* certificates. */
  credential?: string;
  from?: 'verificationKey' | 'script';
  deposit?: { ada?: { lovelace?: number | bigint } };
  stakePool?: { id?: string; retirementEpoch?: number };
  delegateRepresentative?: OgmiosDelegateRepresentative;
}
interface OgmiosPraosBlock {
  type: string; // 'praos' | 'ebb' | 'bft' — only 'praos' carries indexable txs
  era: string;
  id: string;
  ancestor: string; // parent block hash (used by the crawler's reorg parent check)
  height: number;
  slot: number;
  size?: { bytes: number };
  issuer?: { verificationKey?: string };
  transactions?: OgmiosChainSyncTx[];
}

/** CardanoBackend implementation over an Ogmios WebSocket (local node). */
export class OgmiosBackend implements EvaluatingBackend, ChainSyncBackend, LedgerStateBackend {
  public readonly name = 'ogmios';
  /**
   * Capability declaration — the orchestrator skips Ogmios for these without counting
   * circuit failures. Historic queries are out of protocol scope, and address aggregates
   * cannot be derived from state queries.
   */
  public readonly unsupportedMethods: ReadonlySet<string> = new Set([
    // getEpoch is NOT listed: Ogmios can serve the CURRENT epoch and only
    // rejects historic ones — routing prefers historical backends anyway.
    'getBlock',
    'getTransaction',
    'getTransactionMetadata',
    'getAddressTransactions',
    // getDrep is NOT listed: served from the live ledger state via
    // queryLedgerState/delegateRepresentatives (Ogmios ≥ 6.4).
    'getAssetInfo',
    'getAddress',
  ]);
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: Awaited<ReturnType<typeof createInteractionContext>> | null = null;
  private isShutdown = false;
  private reconnectPromise: Promise<void> | null = null;
  private network: Network;
  private timeoutMs: number;
  private ogmiosUrl: string;


  constructor(network: Network, timeoutMs: number, ogmiosUrl: string) {
    if (!ogmiosUrl) {
      throw new BackendInitError('ogmios', new Error('ogmiosUrl is not set'));
    }
    this.network = network;
    this.timeoutMs = timeoutMs;
    this.ogmiosUrl = ogmiosUrl;
  }

  /**
   * Force non-keep-alive HTTP for the Ogmios `/health` probe: node-fetch v2 uses `http.globalAgent`,
   * whose pooled sockets (kept alive since Node 19) fail with "Premature close" once Ogmios' Warp server
   * half-closes them. No agent hook exists, so keep-alive is disabled process-wide for `http://` only.
   */
  private static keepAliveDisabled = false;
  private static disableHttpKeepAlive(): void {
    if (OgmiosBackend.keepAliveDisabled) return;
    http.globalAgent = new http.Agent({ keepAlive: false });
    OgmiosBackend.keepAliveDisabled = true;
  }

  /** Validate Ogmios URL scheme and reject dangerous protocols */
  private static validateOgmiosUrl(rawUrl: string): void {
    const url = new URL(rawUrl);

    // Only allow WebSocket schemes (block file://, http://, etc.)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new BackendInitError('ogmios', new Error(`Invalid Ogmios URL scheme "${url.protocol}" — only ws:// and wss:// are allowed`));
    }

    // In production, block link-local / metadata IPs (SSRF prevention).
    // Private/loopback IPs are allowed since Ogmios typically runs on the local node.
    const host = url.hostname.toLowerCase();
    const dangerousPatterns = [
      /^169\.254\./, // AWS/cloud metadata endpoint range
      /^\[?fe80/     // IPv6 link-local
    ];
    if (dangerousPatterns.some(p => p.test(host))) {
      throw new BackendInitError('ogmios', new Error('Ogmios URL must not point to a link-local or metadata address'));
    }
  }

  /**
   * Bound an init step in time: the WebSocket connect/handshake has no built-in timeout and
   * can hang when the node is busy. The rejection message contains "timeout" so the
   * orchestrator's transient-error retry picks it up.
   */
  private withInitTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    // Short on purpose: the orchestrator retries init several times within a bounded bootstrap window.
    const ms = Math.max(1, Math.min(this.timeoutMs, 4000));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Ogmios init timeout after ${ms}ms (${label})`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Force-release an interaction socket after a failed/expired open or close. The runtime
   * socket is `ws` (has `terminate`); the `close` fallback keeps test doubles working.
   */
  private forceCloseContext(context: Awaited<ReturnType<typeof createInteractionContext>>): void {
    const socket = context.socket as unknown as {
      terminate?: () => void;
      close?: () => void;
      readyState?: number;
      CLOSED?: number;
    };
    try {
      if (typeof socket.terminate === 'function') {
        socket.terminate();
      } else if (typeof socket.close === 'function' && socket.readyState !== (socket.CLOSED ?? 3)) {
        socket.close();
      }
    } catch {
      // Best effort only: the socket may already have completed its close event.
    }
  }

  /** Open the interaction context and the query/submission clients. */
  async init(): Promise<boolean> {
    OgmiosBackend.disableHttpKeepAlive();
    OgmiosBackend.validateOgmiosUrl(this.ogmiosUrl);
    const url = new URL(this.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    const context = await this.withInitTimeout(createInteractionContext(
      /* c8 ignore next */
      (err) => logger.error(`[OgmiosBackend] Interaction context error: ${err.message}`),
      () => {
        // Socket closed: clear the clients so the next request reconnects via ensureConnected.
        if (this.isShutdown) return;
        logger.warn('[OgmiosBackend] WebSocket closed — will reconnect on next request');
        this.stateQueryClient = null;
        this.txSubmissionClient = null;
      },
      { connection }
    ), 'createInteractionContext');

    try {
      this.stateQueryClient = await this.withInitTimeout(createLedgerStateQueryClient(context), 'ledgerStateQueryClient');
      this.txSubmissionClient = await this.withInitTimeout(createTransactionSubmissionClient(context), 'txSubmissionClient');
    } catch (err: unknown) {
      // don't leak the WebSocket when client creation fails mid-init
      // (runtime socket is node `ws`, which exposes terminate())
      try { (context.socket as unknown as { terminate: () => void }).terminate(); } catch { /* best effort */ }
      throw err;
    }
    this.context = context;
    return true;
  }

  /**
   * Reconnect when the WebSocket died since the last init. No-op when never initialized
   * (test-injected clients); concurrent callers share one reconnect attempt.
   */
  private async ensureConnected(): Promise<void> {
    this.ensureNotShutdown();
    if (!this.context) return;
    const socket = this.context.socket as { readyState?: number; OPEN?: number } | undefined;
    const socketOpen = !socket || socket.readyState === (socket.OPEN ?? 1);
    if (this.stateQueryClient && socketOpen) return;

    if (!this.reconnectPromise) {
      logger.warn('[OgmiosBackend] WebSocket not connected — reconnecting');
      this.reconnectPromise = this.init()
        .then(() => undefined)
        .finally(() => { this.reconnectPromise = null; });
    }
    await this.reconnectPromise;
  }

  /** 
   * Get specific Block Data (not supported)
   * @param _hash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(_hash: string): Promise<BlockData> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Block queries not supported', this.name);
    }, this.name);
  }

  /** 
   * Get specific Epoch Data (not supported)
   * @param _epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const currentEpoch = await this.stateQueryClient!.epoch();

      // Ogmios only supports current epoch queries
      if (epochNumber !== currentEpoch) {
        throw new NotFoundError(`Historic Epoch ${epochNumber} not supported (current: ${currentEpoch})`, this.name);
      }

      return this.getLatestEpoch();
    }, this.name);
  }

  /** 
   * Get specific Transaction Data (not supported)
   * @param _hash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(_hash: string): Promise<Transaction> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction queries not supported', this.name);
    }, this.name);
  }

  /** 
   * Get specific Transaction Metadata (not supported)
   * @param _tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(_tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction metadata not supported', this.name);
    }, this.name);
  }

  /**
   * DRep data from the live ledger state (`queryLedgerState/delegateRepresentatives`) via the
   * raw `Method()` primitive, since the client ships no wrapper. Ogmios lists only REGISTERED
   * DReps: retired/unknown → NotFoundError; `expired` is derived from the mandate epoch.
   * @param drepId CIP-129 bech32 DRep ID (`drep1…`)
   */
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      if (!this.context) {
        throw new ProviderUnavailableError('Ogmios interaction context not available', this.name);
      }

      const { hashHex, isScript } = decodeDrepId(drepId);

      const [summaries, currentEpoch] = await Promise.all([
        Method<
          { method: 'queryLedgerState/delegateRepresentatives'; params: { keys?: string[]; scripts?: string[] } },
          OgmiosRpcEnvelope<OgmiosDrepSummary[]> & { method: string },
          OgmiosDrepSummary[]
        >(
          {
            method: 'queryLedgerState/delegateRepresentatives',
            params: isScript ? { scripts: [hashHex] } : { keys: [hashHex] },
          },
          {
            handler: (response, resolve, reject) => {
              if (response.error) {
                reject(new Error(response.error.message ?? `Ogmios error ${response.error.code ?? ''}`.trim()));
              } else {
                resolve(Array.isArray(response.result) ? response.result : []);
              }
            },
          },
          this.context
        ),
        this.stateQueryClient!.epoch(),
      ]);

      // Filter by id: the query is already credential-scoped, but never trust a
      // broader answer (abstain/noConfidence rows carry no id and are dropped here).
      const drep = summaries.find((s) => s.type === 'registered' && s.id?.toLowerCase() === hashHex);
      if (!drep) throw new NotFoundError('Drep', this.name);

      const mandateEpoch = drep.mandate?.epoch;
      return {
        drepId,
        hex: hashHex,
        amount: ogmiosValueToLovelaceString(drep.stake),
        hasScript: isScript || drep.from === 'script',
        // Ogmios reports the mandate (expiry) epoch, not the last activity — keep 0.
        lastActiveEpoch: 0,
        expired: typeof mandateEpoch === 'number' && mandateEpoch < Number(currentEpoch),
        retired: false,
      };
    }, this.name);
  }

  /**
   * Get Asset Info (not supported for Ogmios — no aggregate-supply query in the protocol)
   * @param _unit asset unit (policyId + assetNameHex)
   * @returns {Promise<AssetInfo>} asset info
   */
  async getAssetInfo(_unit: string): Promise<AssetInfo> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Asset info queries not supported by Ogmios backend', this.name);
    }, this.name);
  }

  /**
   * Supply figures from `queryLedgerState/treasuryAndReserves`: total = max − reserves.
   * Circulating, locked and stake totals are not in the ledger state and stay '0'.
   */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      if (!this.context) {
        throw new ProviderUnavailableError('Ogmios interaction context not available', this.name);
      }
      type Pots = { treasury?: { ada?: { lovelace?: number | bigint } }; reserves?: { ada?: { lovelace?: number | bigint } } };
      const pots = await Method<
        { method: 'queryLedgerState/treasuryAndReserves' },
        OgmiosRpcEnvelope<Pots> & { method: string },
        Pots
      >(
        { method: 'queryLedgerState/treasuryAndReserves' },
        {
          handler: (response, resolve, reject) => {
            if (response.error) {
              reject(new Error(response.error.message ?? `Ogmios error ${response.error.code ?? ''}`.trim()));
            } else {
              resolve(response.result ?? {});
            }
          },
        },
        this.context
      );
      const max = CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY;
      const reserves = ogmiosValueToLovelaceString(pots.reserves);
      return {
        supply: {
          max,
          total: (BigInt(max) - BigInt(reserves)).toString(),
          circulating: '0',
          locked: '0',
          treasury: ogmiosValueToLovelaceString(pots.treasury),
          reserves,
        },
        stake: { live: '0', active: '0' },
      };
    }, this.name);
  }

  /**
   * Not supported — address type, script flag and stake address are not derivable from
   * state queries. UTxOs remain available via getAddressUtxos.
   */
  async getAddress(_address: string): Promise<Address> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Address detail queries not supported by Ogmios backend — use Blockfrost/Koios', this.name);
    }, this.name);
  }

  /** get current specific Address UTxOs
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} address UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      const utxos = await this.stateQueryClient!.utxo({ addresses: [address] });
      return utxos.map((u: typeof utxos[number]) => this.mapOgmiosUtxo(u, address));
    }, this.name);
  }

  /** Ogmios `Utxo` entry → normalized UTxO line (shared by the address query and the set import). */
  private mapOgmiosUtxo(
    u: { transaction?: { id: string }; index?: number; address?: string; value: Parameters<OgmiosBackend['convertOgmiosValue']>[0]; datumHash?: string; datum?: unknown; script?: unknown },
    fallbackAddress = '',
  ): UTxO {
    return {
      txHash: u.transaction?.id || '',
      outputIndex: u.index || 0,
      address: u.address || fallbackAddress,
      amount: this.convertOgmiosValue(u.value),
      blockHash: '',
      datumHash: u.datumHash,
      // Ogmios delivers the inline datum as CBOR hex in `datum`
      inlineDatum: typeof u.datum === 'string' ? u.datum : null,
      scriptRef: ogmiosScriptHash(u.script) ?? undefined,
    };
  }

  /**
   * Whole UTxO set as of `point` (crawler snapshot import) on a SEPARATE WebSocket: local-state-query
   * holds one acquired point per connection, so the shared socket would pin live queries to the past.
   * The point must be inside the node's volatile window (last 2160 blocks) or acquisition is refused.
   */
  async queryUtxoSetAt(point: ChainPoint): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      const url = new URL(this.ogmiosUrl);
      const connection = { host: url.hostname, port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80), tls: url.protocol === 'wss:' };
      const context = await createInteractionContext(
        (err) => logger.error(`[OgmiosBackend] snapshot context error: ${err.message}`),
        () => { /* closed by shutdown() below */ },
        { connection }
      );
      let client: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
      try {
        client = await createLedgerStateQueryClient(context, { point: { slot: point.slot, id: point.hash } });
        const utxos = await client.utxo();
        return utxos.map((u: typeof utxos[number]) => this.mapOgmiosUtxo(u));
      } finally {
        // shutdown() closes THIS connection only; the backend's own socket is untouched
        if (client) { try { await client.shutdown(); } catch { /* best effort */ } }
        else this.forceCloseContext(context);
      }
    }, this.name);
  }

  /** Not supported — Ogmios is a live state-query backend; use Blockfrost/Koios. */
  async getAddressTransactions(_address: string): Promise<Transaction[]> {
    throw new NotFoundError(
      'Address transactions not available via Ogmios - use historical backend (Blockfrost/Koios)',
      this.name
    );
  }

  /**
   * Get current specific Pool Data
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
            
      // Query from tip (no acquire needed) with stake included
      const pools = await this.stateQueryClient!.stakePools([{ id: poolId }], true) as Record<string, OgmiosStakePool>;

      // stakePools returns an object keyed by poolId
      const pool = pools[poolId];
      if (!pool) throw new NotFoundError('Pool', this.name);

      return {
        poolId,
        vrfKeyHash: pool.vrfVerificationKeyHash || '',
        blocksMinted: 0,
        // not in the ledger state; null = unavailable, as on Koios
        blocksEpoch: null,
        liveStake: pool.stake?.ada?.lovelace ? String(pool.stake.ada.lovelace) : '0',
        liveSize: 0,
        liveDelegators: 0,
        liveSaturation: 0,
        // activeStake is not available from Ogmios pool params — report 0 instead
        // of fabricating it from the pledge
        activeStake: '0',
        activeSize: 0,
        // pledge/cost are ValueAdaOnly objects in Ogmios v6; margin is a Ratio string ("1/10")
        pledge: ogmiosValueToLovelaceString(pool.pledge),
        margin: parseOgmiosRatio(pool.margin),
        fixedCost: ogmiosValueToLovelaceString(pool.cost),
        rewardAccount: pool.rewardAccount || ''
      };
    }, this.name);
  }

  /** 
   * Get Account Data for specified stake address
   * @param stakeAddress stake address
   * @returns {Promise<AccountData>} account data
   */
  async getAccount(stakeAddress: string): Promise<AccountData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const rawResult = await this.stateQueryClient!.rewardAccountSummaries({ keys: [stakeAddress] });
      // Ogmios returns a record keyed by stake address; normalize to array
      const summaries: OgmiosRewardAccountSummary[] = Array.isArray(rawResult)
        ? rawResult
        : Object.values(rawResult as Record<string, OgmiosRewardAccountSummary>);

      const account = summaries && summaries.length > 0 ? summaries[0] : null;
      
      if (!account) {
        throw new NotFoundError('Account', this.name);
      }

      return {
        stakeaddress: stakeAddress,
        // Ogmios only returns reward-account summaries for REGISTERED stake keys —
        // reaching this point (summary found) therefore implies the account is active.
        active: true,
        activeEpoch: 0,
        // reward-account summaries carry no controlled amount and no withdrawal totals
        controlledAmount: '0',
        rewardsSum: ogmiosValueToLovelaceString(account.rewards),
        withdrawalsSum: '0',
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: ogmiosValueToLovelaceString(account.rewards),
        poolId: account.stakePool?.id || null,
        drepId: ogmiosDrepToId(account.delegateRepresentative),
        addresses: []
      };
    }, this.name);
  }

  /**
   * Submit Transaction to the network
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const txHash = await this.txSubmissionClient!.submitTransaction(signedTxCbor);
      return txHash;
    }, this.name);
  }

  /**
   * Evaluate transaction script execution units
   * @param unsignedTxCbor unsigned transaction in CBOR hex format
   * @returns {Promise<ScriptEvaluationResult[]>} evaluation results
   */
  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      const results = await this.txSubmissionClient!.evaluateTransaction(unsignedTxCbor);
      return results as ScriptEvaluationResult[];
    }, this.name);
  }

  /** 
   * Get current Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      // Query protocol parameters and epoch in parallel
      const [params, currentEpoch] = await Promise.all([
        this.stateQueryClient!.protocolParameters(),
        this.stateQueryClient!.epoch()
      ]);

      return {
        network: this.network,
        epoch: currentEpoch,
        minUtxo: params.minUtxoDepositCoefficient?.toString() || '0',
        nonce: '',
        costModels: JSON.stringify(normalizeCostModels(params.plutusCostModels || {})),
        minFeeA: params.minFeeCoefficient || 0,
        minFeeB: Number(params.minFeeConstant?.ada?.lovelace || 0),
        maxBlockSize: params.maxBlockBodySize?.bytes || 0,
        priceMem: parseOgmiosRatio(params.scriptExecutionPrices?.memory),
        priceStep: parseOgmiosRatio(params.scriptExecutionPrices?.cpu),
        maxTxExMem: (params.maxExecutionUnitsPerTransaction?.memory || 0).toString(),
        maxTxExSteps: (params.maxExecutionUnitsPerTransaction?.cpu || 0).toString(),
        maxBlockExMem: (params.maxExecutionUnitsPerBlock?.memory || 0).toString(),
        maxBlockExSteps: (params.maxExecutionUnitsPerBlock?.cpu || 0).toString(),
        maxValSize: (params.maxValueSize?.bytes || 0).toString(),
        collateralPercent: params.collateralPercentage || 0,
        maxCollateralInputs: params.maxCollateralInputs || 0,
        coinsPerUtxoSize: params.minUtxoDepositCoefficient?.toString() || '0',
        maxBlockHeaderSize: params.maxBlockHeaderSize?.bytes || 0,
        maxTxSize: params.maxTransactionSize?.bytes || 0,
        keyDeposit: params.stakeCredentialDeposit?.ada?.lovelace?.toString() || '0',
        minPoolCost: params.minStakePoolCost?.ada?.lovelace?.toString() || '0',
        poolDeposit: params.stakePoolDeposit?.ada?.lovelace?.toString() || '0',
        eMax: params.stakePoolRetirementEpochBound || 0,
        nOpt: params.desiredNumberOfStakePools || 0,
        a0: parseOgmiosRatio(params.stakePoolPledgeInfluence),
        // ρ = monetaryExpansion, τ = treasuryExpansion
        rho: parseOgmiosRatio(params.monetaryExpansion),
        tau: parseOgmiosRatio(params.treasuryExpansion),
        decentralisationParam: 0,
        extraEntropy: null,
        protocolMajorVer: params.version?.major || 0,
        protocolMinorVer: params.version?.minor || 0,
        fetchedAt: new Date().toISOString(),
        source: this.name
      };
    }, this.name);
  }

  /** 
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      const [currentEpoch, tip] = await Promise.all([
        this.stateQueryClient!.epoch(),
        this.stateQueryClient!.ledgerTip()
      ]);

      const { slot } = resolveOgmiosTip(tip);

      // Network-aware epoch geometry + Shelley-anchored slot→time conversion
      const startSlot = epochStartSlot(this.network, currentEpoch);
      const endSlot = startSlot + EPOCH_CONFIG_BY_NETWORK[this.network].slotsPerEpoch;

      return {
        epoch: currentEpoch,
        start_time: slotToPosixSeconds(this.network, startSlot),
        end_time: slotToPosixSeconds(this.network, endSlot),
        first_block_time: slotToPosixSeconds(this.network, startSlot),
        last_block_time: slotToPosixSeconds(this.network, slot),
        block_count: 0, // Not available from Ogmios state queries
        tx_count: 0, // Not available from Ogmios state queries
        output: '0',
        fees: '0',
        active_stake: null,
      };
    }, this.name);
  }

  /** 
   * Get current Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      // Fetch ledger tip, block height and epoch in parallel
      const [tip, blockHeight, epoch] = await Promise.all([
        this.stateQueryClient!.ledgerTip(),
        this.stateQueryClient!.networkBlockHeight(),
        this.stateQueryClient!.epoch()
      ]);

      const { slot, hash } = resolveOgmiosTip(tip);
      const height = resolveOgmiosHeight(blockHeight);

      // network-aware slot-in-epoch
      const epochSlot = Math.max(0, slot - epochStartSlot(this.network, epoch));

      return {
        time: slotToPosixSeconds(this.network, slot), // seconds (mapBlock expects seconds)
        height,
        hash,
        slot,
        epoch,
        epochSlot,
        slotLeader: '', // Not available via ledgerTip - would need chainSync
        size: 0, // Not available via ledgerTip - would need full block data
        txCount: 0, // Not available via ledgerTip - would need full block data
        fees: '0', // Not available via ledgerTip - would need full block data
        headerOnly: true,
      };
    }, this.name);
  }

  /**
   * Get the latest chain tip slot.
   * @returns {Promise<number>} current chain slot
   */
  async getCurrentSlot(): Promise<number> {
    const block = await this.getLatestBlock();
    if (block.slot == null) {
      throw new ProviderUnavailableError(
        `${this.name}: latest block has no slot`,
        this.name,
      );
    }
    return block.slot;
  }

  /**
   * Unspent check via `queryLedgerState/utxo` with an outputReferences filter; empty = spent or nonexistent.
   * @param txHash 64-char lowercase hex
   * @param outputIndex non-negative integer
   */
  async isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return false;
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      const result = await this.stateQueryClient!.utxo({
        outputReferences: [{ transaction: { id: txHash }, index: outputIndex }],
      });
      return Array.isArray(result) && result.length > 0;
    }, this.name);
  }

  /** Outputs among `refs` that are unspent in the live ledger; spent or unknown references are absent. */
  async getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[]> {
    if (refs.length === 0) return [];
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      const result = await this.stateQueryClient!.utxo({
        outputReferences: refs.map(r => ({ transaction: { id: r.txHash }, index: r.outputIndex })),
      });
      return result.map((u: typeof result[number]) => this.mapOgmiosUtxo(u));
    }, this.name);
  }

  /** Close the WebSocket and mark the backend as shut down. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    // Terminate the WebSocket and wait for close confirmation
    if (this.context?.socket) {
      // Ogmios's typed `socket` is browser WebSocket, but at runtime it's the
      // node `ws` WebSocket which exposes `once`/`terminate` and readyState consts.
      const socket = this.context.socket as unknown as {
        readyState: number;
        OPEN: number;
        CONNECTING: number;
        once: (event: string, cb: () => void) => void;
        terminate: () => void;
      };
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          timer.unref(); // Don't keep event loop alive for this timeout
          socket.once('close', () => { clearTimeout(timer); resolve(); });
          socket.terminate();
        });
      }
    }

    this.stateQueryClient = null;
    this.txSubmissionClient = null;
    this.context = null;
  }

  isConnected(): boolean {
    if (this.isShutdown || !this.context?.socket) {
      return false;
    }
    const socket = this.context.socket as unknown as { readyState: number; OPEN: number };
    return socket.readyState === socket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ensureNotShutdown(): void {
    if (this.isShutdown) {
      throw new ProviderUnavailableError('Ogmios client has been shutdown', this.name);
    }
  }

  /**
   * Ogmios value `{ ada: { lovelace }, policyId: { assetName: qty } }` →
   * `[{ unit: 'lovelace', quantity }, { unit: policyId+assetName, quantity }]`.
   */
  private convertOgmiosValue(value: { ada?: { lovelace?: number | bigint } } & Record<string, unknown>): Array<{ unit: string; quantity: string }> {
    const amounts: Array<{ unit: string; quantity: string }> = [];

    if (value.ada?.lovelace) {
      amounts.push({
        unit: 'lovelace',
        quantity: value.ada.lovelace.toString()
      });
    }

    for (const [policyId, assets] of Object.entries(value)) {
      if (policyId === 'ada') continue;

      for (const [assetName, quantity] of Object.entries(assets as Record<string, number | bigint | string>)) {
        amounts.push({
          unit: `${policyId}${assetName}`,
          quantity: quantity.toString()
        });
      }
    }
    return amounts;
  }

  // ---------------------------------------------------------------------------
  // ChainSyncBackend — streamed forward sync for the chain crawler
  // ---------------------------------------------------------------------------

  /**
   * Open a long-lived chain-sync stream on its own WebSocket. `sequential: true` + `inFlight: 1`
   * deliver blocks strictly in order (required by reorg detection and serial persist). Inputs arrive
   * as bare references (resolved by the indexer from indexed outputs); per-tx size/deposit are not surfaced.
   */
  async openChainSync(from: ChainPoint[] | 'origin', callbacks: ChainSyncCallbacks): Promise<ChainSyncHandle> {
    OgmiosBackend.validateOgmiosUrl(this.ogmiosUrl);
    const url = new URL(this.ogmiosUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
      tls: url.protocol === 'wss:'
    };

    let intentionalClose = false;
    let terminalErrorReported = false;

    // Context callbacks are synchronous, while the crawler callback is async.
    // Start it without leaving an unhandled rejection and suppress the common
    // error+close double notification for a single broken socket.
    const reportStreamError = async (err: unknown): Promise<void> => {
      if (intentionalClose || this.isShutdown || terminalErrorReported) return;
      terminalErrorReported = true;
      try {
        await callbacks.onError?.(err);
      } catch (callbackError) {
        logger.error('[OgmiosBackend] chain-sync onError callback failed:', callbackError);
      }
    };

    // A frame the client's parser cannot handle throws inside the library's un-awaited socket
    // handler and would end the process; the guard routes it here as a stream error instead.
    // Registered per open and removed on close, so concurrent streams each get the report.
    const unregisterFrameGuard = installOgmiosFrameGuard(({ height, id, reason }) => {
      void reportStreamError(new ChainSyncFrameError(height, id, reason));
    });

    const contextPromise = createInteractionContext(
      (err) => {
        logger.error(`[OgmiosBackend] chain-sync context error: ${err.message}`);
        void reportStreamError(err);
      },
      (code, reason) => {
        if (intentionalClose || this.isShutdown) return;
        const detail = reason?.toString() || 'no reason supplied';
        const err = new ProviderUnavailableError(
          `Ogmios chain-sync socket closed unexpectedly (code ${code}: ${detail})`,
          this.name
        );
        logger.warn(`[OgmiosBackend] ${err.message}`);
        void reportStreamError(err);
      },
      { connection }
    );

    let context: Awaited<ReturnType<typeof createInteractionContext>>;
    try {
      context = await this.withInitTimeout(contextPromise, 'chainSync/createInteractionContext');
    } catch (err) {
      // A timeout rejects our race but cannot cancel the library's health probe /
      // handshake. If it resolves later, close that late socket as well.
      intentionalClose = true;
      unregisterFrameGuard();
      void contextPromise.then(lateContext => this.forceCloseContext(lateContext)).catch(() => undefined);
      throw err;
    }

    // Both handlers are fully try/caught: the client awaits them without a catch, and with
    // sequential+inFlight:1 a throw before nextBlock() stalls the stream. On error nextBlock()
    // is deliberately NOT called (stop, don't skip a block); the error goes to callbacks.onError.
    const handlers: Parameters<typeof createChainSynchronizationClient>[1] = {
      rollForward: async ({ block, tip }, nextBlock) => {
        try {
          const b = block as unknown as OgmiosPraosBlock;
          // Byron epoch-boundary (ebb) / bft blocks carry no indexable Praos txs — skip.
          if (b.type !== 'praos') { nextBlock(); return; }
          const mapped = this.mapOgmiosBlock(b);
          const t = tip as { slot?: number; id?: string; height?: number } | 'origin';
          const tipPoint = t && t !== 'origin' && t.slot != null && t.id
            ? { slot: t.slot, hash: t.id, height: t.height }
            : undefined;
          await callbacks.rollForward(mapped.block, mapped.txs, tipPoint);
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollForward failed — stream halted:', err);
          await reportStreamError(err);
        }
      },
      rollBackward: async ({ point }, nextBlock) => {
        try {
          const p = point as { slot: number; id: string } | 'origin';
          await callbacks.rollBackward(p === 'origin' ? 'origin' : { slot: p.slot, hash: p.id });
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollBackward failed — stream halted:', err);
          await reportStreamError(err);
        }
      },
    };

    let client: Awaited<ReturnType<typeof createChainSynchronizationClient>> | undefined;
    try {
      client = await this.withInitTimeout(
        createChainSynchronizationClient(context, handlers, { sequential: true }),
        'chainSync/createClient'
      );
      // Ogmios intersects at the FIRST of these still on its chain, so ancestors
      // turn a fork we slept through into a rollBackward instead of a hard failure.
      const points = from === 'origin' ? ['origin'] : from.map((p) => ({ slot: p.slot, id: p.hash }));
      await this.withInitTimeout(
        client.resume(points as Parameters<typeof client.resume>[0], 1),
        'chainSync/resume'
      );
    } catch (err) {
      intentionalClose = true;
      unregisterFrameGuard();
      if (client) {
        try {
          await this.withInitTimeout(client.shutdown(), 'chainSync/failedOpenShutdown');
        } catch {
          // forceCloseContext below is the final cleanup path
        }
      }
      this.forceCloseContext(context);
      throw err;
    }

    let closePromise: Promise<void> | null = null;
    return {
      close: () => {
        // Idempotency matters when an operator stop races an onError-triggered halt.
        if (!closePromise) {
          intentionalClose = true;
          unregisterFrameGuard();
          closePromise = (async () => {
            try {
              await this.withInitTimeout(client.shutdown(), 'chainSync/shutdown');
            } finally {
              // Also handles a shutdown timeout or an already-closed socket.
              this.forceCloseContext(context);
            }
          })();
        }
        return closePromise;
      }
    };
  }

  /**
   * Map an Ogmios Praos block to BlockData + transactions. Block fees are the sum of per-tx
   * fees; epoch/epochSlot derive from the slot via the Shelley anchor. A phase-2 failure without
   * `total_collateral` still carries its declared fee here; applyCollateralFees() corrects it.
   */
  private mapOgmiosBlock(block: OgmiosPraosBlock): { block: BlockData; txs: Transaction[] } {
    const txs = (block.transactions ?? []).map((t, i) => this.mapOgmiosTx(t, block, i));
    const totalFees = txs.reduce((sum, t) => sum + BigInt(t.fee || 0), 0n);

    const epoch = epochOfSlot(this.network, block.slot);
    // Shelley-anchored helpers (handle preview/preprod geometry and the Byron offset)
    const epochSlot = block.slot - epochStartSlot(this.network, epoch);

    const blockData: BlockData = {
      time: slotToPosixSeconds(this.network, block.slot),
      height: block.height,
      hash: block.id,
      slot: block.slot,
      slotLeader: block.issuer?.verificationKey ? issuerKeyToPoolId(block.issuer.verificationKey) : '',
      epoch,
      epochSlot,
      size: block.size?.bytes ?? 0,
      txCount: txs.length,
      fees: totalFees.toString(),
    };
    return { block: blockData, txs };
  }

  /**
   * Map one chain-sync transaction. Inputs stay bare references (resolved by the indexer).
   * `spends` selects the ledger-applied partition: a phase-2-invalid tx consumes collaterals
   * and creates only its collateral-return output; the fee follows that partition too.
   */
  private mapOgmiosTx(tx: OgmiosChainSyncTx, block: OgmiosPraosBlock, index: number): Transaction {
    const mapInput = (
      input: { transaction: { id: string }; index: number },
      flags: Pick<TxInputLine, 'isCollateral' | 'isReference'> = {}
    ): TxInputLine => ({
      address: '',
      amount: [] as Amount[],
      txHash: input.transaction.id,
      outputIndex: input.index,
      ...flags,
    });

    const spendsCollaterals = tx.spends === 'collaterals';
    const inputs: TxInputLine[] = [
      ...(spendsCollaterals ? [] : (tx.inputs ?? []).map(input => mapInput(input))),
      ...(tx.collaterals ?? []).map(input => mapInput(input, { isCollateral: true })),
      ...(tx.references ?? []).map(input => mapInput(input, { isReference: true })),
    ];

    const mapOutput = (
      output: OgmiosChainSyncTx['outputs'][number],
      outputIndex: number,
      isCollateral: boolean
    ): TxOutputLine => ({
      address: output.address,
      amount: this.convertOgmiosValue(output.value),
      txHash: tx.id,
      outputIndex,
      dataHash: output.datumHash ?? null,
      inlineDatum: output.datum ?? null,
      isCollateral,
      referenceScriptHash: ogmiosScriptHash(output.script),
    });

    const outputs: TxOutputLine[] = spendsCollaterals
      ? (tx.collateralReturn
          // The ledger assigns collateral return the index immediately after the
          // declared regular outputs, even though those outputs are not produced.
          ? [mapOutput(tx.collateralReturn, tx.outputs?.length ?? 0, true)]
          : [])
      : (tx.outputs ?? []).map((output, outputIndex) => mapOutput(output, outputIndex, false));

    const metadataEntries: MetadataLabelTx[] = tx.metadata?.labels
      ? Object.entries(tx.metadata.labels).map(([label, v]) => ({
          txHash: tx.id,
          label,
          json: v.json as MetadataLabelTx['json'],
        }))
      : [];

    // A phase-2 failure pays `total_collateral`, not the declared fee; the body often omits it,
    // so the indexer derives the rest from the resolved collateral inputs later.
    const declaredFee = (tx.fee?.ada?.lovelace ?? 0).toString();
    const totalCollateral = tx.totalCollateral ? tx.totalCollateral.ada.lovelace.toString() : null;

    return {
      hash: tx.id,
      blockHash: block.id,
      blockHeight: block.height,
      slot: block.slot,
      index,
      fee: spendsCollaterals ? (totalCollateral ?? declaredFee) : declaredFee,
      spendsCollaterals,
      totalCollateral,
      deposit: '0',
      // The ledger applies no mint when the script phase failed: the body's mint field is
      // declared but never enacted, so a phase-2 failure must report none at all.
      mint: spendsCollaterals ? undefined : this.convertOgmiosValue(tx.mint ?? {}),
      // null = unknown (chain-sync doesn't surface the serialized size) — matches the
      // lazy path's `size ?? null` convention; 0 would masquerade as a real size
      size: null,
      blockTime: slotToPosixSeconds(this.network, block.slot),
      inputs,
      outputs,
      // undefined (not []) when absent — matches the Blockfrost path so
      // mapTransaction's hasMetadata flag stays false for metadata-less txs
      metadata: metadataEntries.length ? metadataEntries : undefined,
      certificates: this.mapOgmiosCertificates(tx.certificates ?? []),
      withdrawals: Object.entries(tx.withdrawals ?? {}).map(([stakeAddress, value]) => ({
        stakeAddress,
        amount: (value?.ada?.lovelace ?? 0).toString(),
      })),
    };
  }

  /**
   * Normalize Ogmios certificates onto the shared `CertificateKind` vocabulary. A `stakeDelegation`
   * with both pool and DRep target is split into two entries with the same index (as db-sync
   * reports it); bare credential hashes are re-encoded as bech32 to match the other tables.
   */
  private mapOgmiosCertificates(certs: OgmiosCertificate[]): TxCertificate[] {
    const out: TxCertificate[] = [];
    const lovelace = (v?: { ada?: { lovelace?: number | bigint } }): string | null =>
      v?.ada?.lovelace != null ? v.ada.lovelace.toString() : null;
    const stakeAddr = (c: OgmiosCertificate): string | null =>
      c.credential ? credentialToStakeAddress(c.credential, c.from === 'script', this.network) : null;
    certs.forEach((c, certIndex) => {
      switch (c.type) {
        case 'stakeCredentialRegistration':
          out.push({ certIndex, kind: 'stake_registration', stakeAddress: stakeAddr(c), deposit: lovelace(c.deposit) });
          break;
        case 'stakeCredentialDeregistration':
          out.push({ certIndex, kind: 'stake_deregistration', stakeAddress: stakeAddr(c), deposit: lovelace(c.deposit) });
          break;
        case 'stakeDelegation': {
          const stakeAddress = stakeAddr(c);
          if (c.stakePool?.id) out.push({ certIndex, kind: 'pool_delegation', stakeAddress, poolId: c.stakePool.id });
          if (c.delegateRepresentative) out.push({ certIndex, kind: 'vote_delegation', stakeAddress, drepId: ogmiosDrepToId(c.delegateRepresentative) });
          break;
        }
        case 'stakePoolRegistration':
          out.push({ certIndex, kind: 'pool_registration', poolId: c.stakePool?.id ?? null });
          break;
        case 'stakePoolRetirement':
          out.push({ certIndex, kind: 'pool_retirement', poolId: c.stakePool?.id ?? null, epoch: c.stakePool?.retirementEpoch ?? null });
          break;
        case 'delegateRepresentativeRegistration':
          out.push({ certIndex, kind: 'drep_registration', drepId: ogmiosDrepToId(c.delegateRepresentative), deposit: lovelace(c.deposit) });
          break;
        case 'delegateRepresentativeUpdate':
          out.push({ certIndex, kind: 'drep_update', drepId: ogmiosDrepToId(c.delegateRepresentative) });
          break;
        case 'delegateRepresentativeRetirement':
          out.push({ certIndex, kind: 'drep_retirement', drepId: ogmiosDrepToId(c.delegateRepresentative), deposit: lovelace(c.deposit) });
          break;
        case 'constitutionalCommitteeDelegation':
          out.push({ certIndex, kind: 'committee_hot_auth' });
          break;
        case 'constitutionalCommitteeRetirement':
          out.push({ certIndex, kind: 'committee_resign' });
          break;
        case 'genesisDelegation':
          out.push({ certIndex, kind: 'genesis_delegation' });
          break;
        default:
          out.push({ certIndex, kind: c.type });
      }
    });
    return out;
  }
}
