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
import { ogmiosReferenceScript } from '../../utils/reference-script';

import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, ChainSyncClosedError, ChainSyncFrameError, NotFoundError, ProviderUnavailableError, TransactionValidationError, normalizeBackendError } from '../../utils/errors';
import { installOgmiosFrameGuard } from './ogmios-frame-guard';
import { epochOfSlot, epochStartSlot, slotToPosixSeconds } from '../../utils/epoch-slots';
import { normalizeCostModels, credentialToStakeAddress, credentialToDrepId, decodeShelleyAddress, sumUtxoAmounts, compareOutRef, ledgerView } from '../../utils/mappers';
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
  TxCertificate,
  TxRedeemer
} from '../../utils/types';

import { EvaluatingBackend, ChainSyncBackend, ChainSyncCallbacks, ChainSyncHandle, ChainPoint, LedgerStateBackend, EpochStateBackend, EpochLedgerState } from './cardano-backend';

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

/** Hash of an Ogmios `Script`: blake2b-224 over the language tag byte followed by the script CBOR. */
export function ogmiosScriptHash(script: unknown): string | null {
  return ogmiosReferenceScript(script)?.hash ?? null;
}

/** Full CBOR of a Plutus reference script as Ogmios delivers it; null for native or absent scripts. */
export function ogmiosPlutusScriptCbor(script: unknown): string | null {
  return ogmiosReferenceScript(script)?.cbor ?? null;
}

/** Reference-script columns of an output or UTxO from an Ogmios `script`. */
function ogmiosReferenceScriptFields(script: unknown): Pick<TxOutputLine, 'referenceScriptHash' | 'referenceScriptSize' | 'referenceScriptType'> {
  const ref = ogmiosReferenceScript(script);
  return { referenceScriptHash: ref?.hash ?? null, referenceScriptSize: ref?.size ?? null, referenceScriptType: ref?.type ?? null };
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

/** Ogmios `queryLedgerState/delegateRepresentatives` entry. Only the `registered` variant has an id. */
interface OgmiosDrepSummary {
  type: 'registered' | 'noConfidence' | 'abstain';
  id?: string;
  from?: 'verificationKey' | 'script';
  mandate?: { epoch?: number };
  stake?: { ada?: { lovelace?: number | bigint } };
  deposit?: { ada?: { lovelace?: number | bigint } };
  delegators?: unknown[];
}

/** Ogmios `stakePoolsPerformances`. Only nOpt is used, because its stake figures are live, not active. */
interface OgmiosStakePoolsPerformances {
  desiredNumberOfStakePools?: number;
}

/** Raw Ogmios answers for one epoch snapshot, all read at the same acquired block. */
export interface OgmiosEpochStateRaw {
  epoch: number;
  stakePools: Record<string, OgmiosStakePool>;
  performances: OgmiosStakePoolsPerformances | null;
  dreps: OgmiosDrepSummary[];
  pots: { treasury?: { ada?: { lovelace?: number | bigint } }; reserves?: { ada?: { lovelace?: number | bigint } } } | null;
}

/** Fraction a/b of two lovelace amounts; 0 when b is 0. */
function ratio(a: bigint, b: bigint): number {
  return b === 0n ? 0 : Number((a * 1_000_000n) / b) / 1_000_000;
}

// Saturation is live stake over ((max supply - reserves) / nOpt), as in the ledger.
// Figures the ledger does not carry stay 0 or null, such as active stake and block counts.
export function mapOgmiosEpochState(raw: OgmiosEpochStateRaw): EpochLedgerState {
  const lovelace = (v: OgmiosRewardAccountSummary['rewards']) => BigInt(ogmiosValueToLovelaceString(v));
  const reserves = raw.pots?.reserves ? lovelace(raw.pots.reserves) : null;
  const nOpt = raw.performances?.desiredNumberOfStakePools ?? 0;
  const saturationPoint = reserves != null && nOpt > 0
    ? (BigInt(CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY) - reserves) / BigInt(nOpt)
    : 0n;

  const entries = Object.entries(raw.stakePools);
  const liveTotal = entries.reduce((sum, [, p]) => sum + lovelace(p.stake), 0n);
  const pools: PoolData[] = entries.map(([poolId, p]) => {
    const live = lovelace(p.stake);
    return {
      poolId,
      vrfKeyHash: p.vrfVerificationKeyHash || '',
      blocksMinted: 0,
      blocksEpoch: null,
      liveStake: live.toString(),
      liveSize: ratio(live, liveTotal),
      liveSaturation: ratio(live, saturationPoint),
      liveDelegators: null,
      activeStake: '0',
      activeSize: 0,
      pledge: ogmiosValueToLovelaceString(p.pledge),
      margin: parseOgmiosRatio(p.margin),
      fixedCost: ogmiosValueToLovelaceString(p.cost),
      rewardAccount: p.rewardAccount || '',
    };
  });

  let abstain: bigint | null = null;
  let noConfidence: bigint | null = null;
  const dreps: DrepData[] = [];
  for (const d of raw.dreps) {
    if (d.type === 'abstain') { abstain = (abstain ?? 0n) + lovelace(d.stake); continue; }
    if (d.type === 'noConfidence') { noConfidence = (noConfidence ?? 0n) + lovelace(d.stake); continue; }
    if (d.type !== 'registered' || !d.id) continue;
    const mandate = d.mandate?.epoch;
    dreps.push({
      drepId: credentialToDrepId(d.id, d.from === 'script'),
      hex: d.id,
      amount: ogmiosValueToLovelaceString(d.stake),
      hasScript: d.from === 'script',
      lastActiveEpoch: 0,
      expired: typeof mandate === 'number' && mandate < raw.epoch,
      retired: false,
      deposit: d.deposit ? ogmiosValueToLovelaceString(d.deposit) : null,
      expiresEpoch: typeof mandate === 'number' ? mandate : null,
      delegatorCount: Array.isArray(d.delegators) ? d.delegators.length : null,
    });
  }

  return {
    epoch: raw.epoch,
    pools,
    dreps,
    treasury: raw.pots?.treasury ? ogmiosValueToLovelaceString(raw.pots.treasury) : null,
    reserves: reserves == null ? null : reserves.toString(),
    drepAbstainStake: abstain == null ? null : abstain.toString(),
    drepNoConfidenceStake: noConfidence == null ? null : noConfidence.toString(),
  };
}

/** Minimal JSON-RPC envelope seen by the raw `Method()` handler. */
interface OgmiosRpcEnvelope<T> {
  method?: string;
  result?: T;
  error?: { code?: number; message?: string };
}

// Decode a CIP-129 DRep ID into credential hash and type. In the header byte the high
// nibble 0x2 means DRep. The low nibble is 0x2 for a key hash and 0x3 for a script hash.
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

// Redeemers of a chain-sync tx. A spend index points into the inputs sorted by txHash and index.
// A mint index points into the sorted policy ids. Both are resolved here.
function mapOgmiosRedeemers(tx: OgmiosChainSyncTx): TxRedeemer[] {
  const sortedInputs = [...(tx.inputs ?? [])].sort((a, b) =>
    compareOutRef({ txHash: a.transaction.id, outputIndex: a.index }, { txHash: b.transaction.id, outputIndex: b.index }));
  const sortedPolicies = Object.keys(tx.mint ?? {}).sort();
  return (tx.redeemers ?? []).map((r) => {
    const { purpose, index } = r.validator;
    const spent = purpose === 'spend' ? sortedInputs[index] : undefined;
    return {
      purpose,
      index,
      data: r.redeemer,
      mem: r.executionUnits.memory.toString(),
      steps: r.executionUnits.cpu.toString(),
      txHash: spent?.transaction.id ?? null,
      outputIndex: spent?.index ?? null,
      policyId: purpose === 'mint' ? (sortedPolicies[index] ?? null) : null,
    };
  });
}

/** The fields of Ogmios chain-sync blocks and transactions that the mapper reads. */
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
  /** Optional in the tx body, so many phase-2 failures lack it. */
  totalCollateral?: { ada: { lovelace: number | bigint } };
  /** Body mint field: policyId -> assetName -> signed quantity (negative = burn). Never contains `ada`. */
  mint?: Record<string, Record<string, number | bigint>>;
  metadata?: { labels?: Record<string, { json?: unknown; cbor?: string }> };
  certificates?: OgmiosCertificate[];
  /** Keyed by reward account (bech32 `stake…` / `stake_test…`). */
  withdrawals?: Record<string, { ada?: { lovelace?: number | bigint } }>;
  redeemers?: { redeemer: string; executionUnits: { memory: number | bigint; cpu: number | bigint }; validator: { purpose: string; index: number } }[];
  /** Witness-set datums: hash -> CBOR hex (original bytes). */
  datums?: Record<string, string>;
}
/** Ogmios certificate fields we index. Unknown `type` values pass through as the raw kind. */
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
  type: string; // only 'praos' blocks carry indexable txs
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
export class OgmiosBackend implements EvaluatingBackend, ChainSyncBackend, LedgerStateBackend, EpochStateBackend {
  public readonly name = 'ogmios';
  /** Ogmios cannot answer historic queries. The orchestrator skips it for these. */
  public readonly unsupportedMethods: ReadonlySet<string> = new Set([
    // getEpoch is not listed, because Ogmios serves the current epoch.
    // Routing prefers historical backends for it anyway.
    'getBlock',
    'getTransaction',
    'getTransactionMetadata',
    'getAddressTransactions',
    // getDrep is NOT listed: served from the live ledger state via
    // queryLedgerState/delegateRepresentatives (Ogmios ≥ 6.4).
    'getAssetInfo',
  ]);
  private stateQueryClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private txSubmissionClient: Awaited<ReturnType<typeof createTransactionSubmissionClient>> | null = null;
  private context: Awaited<ReturnType<typeof createInteractionContext>> | null = null;
  /** Second connection for address queries (see scanQueryClient). */
  private scanClient: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
  private scanContext: Awaited<ReturnType<typeof createInteractionContext>> | null = null;
  private scanConnecting: Promise<Awaited<ReturnType<typeof createLedgerStateQueryClient>>> | null = null;
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

  // The `/health` probe uses node-fetch v2 on `http.globalAgent`. Its kept-alive sockets fail with
  // "Premature close" once Ogmios half-closes them. There is no agent hook, so keep-alive is off for http.
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
      throw new BackendInitError('ogmios', new Error(`Invalid Ogmios URL scheme "${url.protocol}": only ws:// and wss:// are allowed`));
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

  // The WebSocket handshake has no timeout and can hang on a busy node. The rejection says
  // "timeout" so the orchestrator retries it as a transient error.
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

  /** Force-release a socket after a failed open or close. Test doubles without `terminate` get `close`. */
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
        logger.warn('[OgmiosBackend] WebSocket closed, will reconnect on next request');
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

  // Address queries scan the whole UTxO set and take seconds. Ogmios answers one connection in order,
  // so they get their own connection and do not hold up tip and epoch queries.
  private async scanQueryClient(): Promise<Awaited<ReturnType<typeof createLedgerStateQueryClient>>> {
    this.ensureNotShutdown();
    // never initialized (test-injected clients): the shared client
    if (!this.context) return this.stateQueryClient!;
    const socket = this.scanContext?.socket as { readyState?: number; OPEN?: number } | undefined;
    if (this.scanClient && socket && socket.readyState === (socket.OPEN ?? 1)) return this.scanClient;
    if (!this.scanConnecting) {
      this.scanConnecting = (async () => {
        const url = new URL(this.ogmiosUrl);
        const connection = { host: url.hostname, port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80), tls: url.protocol === 'wss:' };
        const context = await this.withInitTimeout(createInteractionContext(
          (err) => logger.error(`[OgmiosBackend] address-query context error: ${err.message}`),
          () => { this.scanClient = null; },
          { connection }
        ), 'scan/createInteractionContext');
        try {
          const client = await this.withInitTimeout(createLedgerStateQueryClient(context), 'scan/ledgerStateQueryClient');
          this.scanContext = context;
          this.scanClient = client;
          return client;
        } catch (err: unknown) {
          this.forceCloseContext(context);
          throw err;
        }
      })().finally(() => { this.scanConnecting = null; });
    }
    return this.scanConnecting;
  }

  /** Reconnect a dead WebSocket. Concurrent callers share one attempt. No-op before the first init. */
  private async ensureConnected(): Promise<void> {
    this.ensureNotShutdown();
    if (!this.context) return;
    const socket = this.context.socket as { readyState?: number; OPEN?: number } | undefined;
    const socketOpen = !socket || socket.readyState === (socket.OPEN ?? 1);
    if (this.stateQueryClient && socketOpen) return;

    if (!this.reconnectPromise) {
      logger.warn('[OgmiosBackend] WebSocket not connected, reconnecting');
      this.reconnectPromise = this.init()
        .then(() => undefined)
        .finally(() => { this.reconnectPromise = null; });
    }
    await this.reconnectPromise;
  }

  async getBlock(_hash: string): Promise<BlockData> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Block queries not supported', this.name);
    }, this.name);
  }

  /** Only the current epoch. */
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

  async getTransaction(_hash: string): Promise<Transaction> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction queries not supported', this.name);
    }, this.name);
  }

  async getTransactionMetadata(_tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(async () => {
      throw new NotFoundError('Historic Transaction metadata not supported', this.name);
    }, this.name);
  }

  // DRep from `queryLedgerState/delegateRepresentatives` via raw `Method()`, as the client has no wrapper.
  // Ogmios lists only registered DReps, so others are NotFoundError.
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
        // Ogmios reports the mandate expiry epoch, not the last activity.
        lastActiveEpoch: 0,
        expired: typeof mandateEpoch === 'number' && mandateEpoch < Number(currentEpoch),
        retired: false,
      };
    }, this.name);
  }

  /** Not supported. The protocol has no aggregate-supply query. */
  async getAssetInfo(_unit: string): Promise<AssetInfo> {
    return handleBackendRequest(async () => {
      throw new ProviderUnavailableError('Asset info queries not supported by Ogmios backend', this.name);
    }, this.name);
  }

  /** Total supply is max supply minus reserves. Circulating, locked and stake totals stay '0'. */
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

  /** Address at the tip, decoded locally, with UTxOs and balance from the ledger. No tx history. */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      const decoded = decodeShelleyAddress(address);
      const raw = await (await this.scanQueryClient()).utxo({ addresses: [address] });
      const utxos = raw.map((u: typeof raw[number]) => this.mapOgmiosUtxo(u, address));
      return {
        address,
        stakeAddress: decoded.stakeAddress,
        type: decoded.type,
        isScript: decoded.isScript,
        amount: sumUtxoAmounts(utxos),
        utxos,
      };
    }, this.name);
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();
      
      const utxos = await (await this.scanQueryClient()).utxo({ addresses: [address] });
      return utxos.map((u: typeof utxos[number]) => this.mapOgmiosUtxo(u, address));
    }, this.name);
  }

  /** Ogmios `Utxo` entry → normalized UTxO line (shared by the address query and the set import). */
  private mapOgmiosUtxo(
    u: { transaction?: { id: string }; index?: number; address?: string; value: Parameters<OgmiosBackend['convertOgmiosValue']>[0]; datumHash?: string; datum?: unknown; script?: unknown },
    fallbackAddress = '',
  ): UTxO {
    const ref = ogmiosReferenceScript(u.script);
    return {
      txHash: u.transaction?.id || '',
      outputIndex: u.index || 0,
      address: u.address || fallbackAddress,
      amount: this.convertOgmiosValue(u.value),
      blockHash: '',
      datumHash: u.datumHash,
      // Ogmios delivers the inline datum as CBOR hex in `datum`
      inlineDatum: typeof u.datum === 'string' ? u.datum : null,
      scriptRef: ref?.hash,
      scriptRefCbor: ref?.cbor ?? null,
      scriptRefSize: ref?.size ?? null,
      scriptRefType: ref?.type ?? null,
    };
  }

  // Runs `fn` on the ledger state at `point` over a separate WebSocket. A connection holds one acquired
  // point, so the shared socket would pin live queries to the past. `point` must be within k blocks.
  private async withLedgerStateAt<T>(
    point: ChainPoint,
    label: string,
    fn: (client: Awaited<ReturnType<typeof createLedgerStateQueryClient>>) => Promise<T>,
  ): Promise<T> {
    const url = new URL(this.ogmiosUrl);
    const connection = { host: url.hostname, port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80), tls: url.protocol === 'wss:' };
    const context = await createInteractionContext(
      (err) => logger.error(`[OgmiosBackend] ${label} context error: ${err.message}`),
      () => { /* closed by shutdown() below */ },
      { connection }
    );
    let client: Awaited<ReturnType<typeof createLedgerStateQueryClient>> | null = null;
    try {
      client = await createLedgerStateQueryClient(context, { point: { slot: point.slot, id: point.hash } });
      return await fn(client);
    } finally {
      // shutdown() closes THIS connection only; the backend's own socket is untouched
      if (client) { try { await client.shutdown(); } catch { /* best effort */ } }
      else this.forceCloseContext(context);
    }
  }

  /** Whole UTxO set as of `point` (crawler snapshot import). */
  async queryUtxoSetAt(point: ChainPoint): Promise<UTxO[]> {
    return handleBackendRequest(
      () => this.withLedgerStateAt(point, 'snapshot', async (client) => {
        const utxos = await client.utxo();
        return utxos.map((u: typeof utxos[number]) => this.mapOgmiosUtxo(u));
      }),
      this.name,
    );
  }

  /** Pools, DReps and pots at `point` from one ledger state. Without nOpt saturation stays 0. */
  async epochStateAt(point: ChainPoint): Promise<EpochLedgerState> {
    return handleBackendRequest(
      () => this.withLedgerStateAt(point, 'epoch snapshot', async (client) => {
        const ctx = client.context;
        const [epoch, stakePools, performances, dreps, pots] = await Promise.all([
          client.epoch(),
          client.stakePools(undefined, true) as Promise<unknown>,
          (client.stakePoolsPerformances() as Promise<unknown>).catch((err: unknown) => {
            logger.warn(`stakePoolsPerformances unavailable, saturation stays 0: ${(err as Error)?.message ?? err}`);
            return null;
          }),
          Method<{ method: 'queryLedgerState/delegateRepresentatives' }, OgmiosRpcEnvelope<OgmiosDrepSummary[]> & { method: string }, OgmiosDrepSummary[]>(
            { method: 'queryLedgerState/delegateRepresentatives' }, {}, ctx
          ),
          Method<{ method: 'queryLedgerState/treasuryAndReserves' }, OgmiosRpcEnvelope<OgmiosEpochStateRaw['pots']> & { method: string }, OgmiosEpochStateRaw['pots']>(
            { method: 'queryLedgerState/treasuryAndReserves' }, {}, ctx
          ),
        ]);
        return mapOgmiosEpochState({
          epoch: Number(epoch),
          stakePools: (stakePools ?? {}) as Record<string, OgmiosStakePool>,
          performances: performances as OgmiosStakePoolsPerformances | null,
          dreps: Array.isArray(dreps) ? dreps : [],
          pots: pots ?? null,
        });
      }),
      this.name,
    );
  }

  /** Not supported. Ogmios only queries live state. */
  async getAddressTransactions(_address: string): Promise<Transaction[]> {
    throw new NotFoundError(
      'Address transactions not available via Ogmios - use historical backend (Blockfrost/Koios)',
      this.name
    );
  }

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
        // no total live stake to divide by; null = unavailable
        liveSize: null,
        // not in the ledger state; null = unavailable
        liveDelegators: null,
        liveSaturation: 0,
        // Ogmios pool params have no active stake
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

  async getAccount(stakeAddress: string): Promise<AccountData> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      // Ogmios keeps key-hash and script-hash credentials in separate lists. A script stake address
      // asked under `keys` is never found.
      const rawResult = await this.stateQueryClient!.rewardAccountSummaries(
        decodeShelleyAddress(stakeAddress).isScript ? { scripts: [stakeAddress] } : { keys: [stakeAddress] });
      // Ogmios returns a record keyed by stake address; normalize to array
      const summaries: OgmiosRewardAccountSummary[] = Array.isArray(rawResult)
        ? rawResult
        : Object.values(rawResult as Record<string, OgmiosRewardAccountSummary>);

      const account = summaries && summaries.length > 0 ? summaries[0] : null;

      // The summary lists only credentials delegated to a pool or a DRep. A registered credential without
      // delegation is absent here, so "not found" does not mean "not registered".
      if (!account) {
        throw new NotFoundError('Account', this.name);
      }

      return {
        stakeaddress: stakeAddress,
        // a summary exists only for a registered credential
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

  async submitTransaction(signedTxCbor: string): Promise<string> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      try {
        return await this.txSubmissionClient!.submitTransaction(signedTxCbor);
      } catch (err: unknown) {
        // JSON-RPC 3000-3999: the node rejected the transaction. Known kinds keep their class
        // (already submitted = 409, script failure = 400); anything else becomes a 400 with its reason.
        const known = normalizeBackendError(err, this.name);
        if (known.statusCode >= 400 && known.statusCode < 500) throw known;
        const e = err as { code?: unknown; message?: unknown; data?: unknown };
        if (typeof e?.code === 'number' && e.code >= 3000 && e.code < 4000) {
          const detail = e.data === undefined ? '' : ` ${JSON.stringify(e.data).slice(0, 800)}`;
          throw new TransactionValidationError(`node rejected the transaction (${e.code}): ${String(e.message ?? '')}${detail}`, err);
        }
        throw err;
      }
    }, this.name);
  }

  async evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]> {
    return handleBackendRequest(async () => {
      await this.ensureConnected();

      try {
        const results = await this.txSubmissionClient!.evaluateTransaction(unsignedTxCbor);
        return results as ScriptEvaluationResult[];
      } catch (err: unknown) {
        // JSON-RPC 3000-3099 except 3003: the transaction cannot be evaluated as given, a 400 with its reason.
        // 3003 means the node is still syncing, so it stays retryable.
        const known = normalizeBackendError(err, this.name);
        if (known.statusCode >= 400 && known.statusCode < 500) throw known;
        const e = err as { code?: unknown; message?: unknown; data?: unknown };
        if (typeof e?.code === 'number' && e.code >= 3000 && e.code < 3100 && e.code !== 3003) {
          const detail = e.data === undefined ? '' : ` ${JSON.stringify(e.data).slice(0, 800)}`;
          throw new TransactionValidationError(`transaction cannot be evaluated (${e.code}): ${String(e.message ?? '')}${detail}`, err);
        }
        throw err;
      }
    }, this.name);
  }

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
        minFeeRefScriptCostPerByte: params.minFeeReferenceScripts?.base ?? null,
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

  /** Unspent check via `queryLedgerState/utxo`. An empty answer means spent or unknown. */
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

    if (this.scanContext) this.forceCloseContext(this.scanContext);
    this.stateQueryClient = null;
    this.txSubmissionClient = null;
    this.context = null;
    this.scanClient = null;
    this.scanContext = null;
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

  /** Ogmios value `{ ada: { lovelace }, policyId: { assetName: qty } }` to a list of units and quantities. */
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
  // ChainSyncBackend: streamed forward sync for the chain crawler
  // ---------------------------------------------------------------------------

  // Opens a chain-sync stream on its own WebSocket. One block in flight keeps blocks strictly
  // in order, which reorg detection needs. Inputs arrive as bare references the indexer resolves.
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
        const err = new ChainSyncClosedError(
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
          // Byron boundary and bft blocks carry no indexable txs
          if (b.type !== 'praos') { nextBlock(); return; }
          const mapped = this.mapOgmiosBlock(b);
          const t = tip as { slot?: number; id?: string; height?: number } | 'origin';
          const tipPoint = t && t !== 'origin' && t.slot != null && t.id
            ? { slot: t.slot, hash: t.id, height: t.height }
            : undefined;
          await callbacks.rollForward(mapped.block, mapped.txs, tipPoint);
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollForward failed, stream halted:', err);
          await reportStreamError(err);
        }
      },
      rollBackward: async ({ point }, nextBlock) => {
        try {
          const p = point as { slot: number; id: string } | 'origin';
          await callbacks.rollBackward(p === 'origin' ? 'origin' : { slot: p.slot, hash: p.id });
          nextBlock();
        } catch (err) {
          logger.error('[OgmiosBackend] chain-sync rollBackward failed, stream halted:', err);
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

  // Block fees are the sum of tx fees. A phase-2 failure without `total_collateral` keeps
  // its declared fee here, and applyCollateralFees() corrects it later.
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

  // A phase-2 invalid tx consumes its collaterals and creates only the collateral-return output.
  // `spends` selects which side the ledger applied, and the fee follows it.
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
      ...ogmiosReferenceScriptFields(output.script),
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

    // the same ledger view the pagination sources produce (ordering; the partition is already applied)
    return ledgerView({
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
      // chain-sync has no serialized size, and 0 would look like a real size
      size: null,
      blockTime: slotToPosixSeconds(this.network, block.slot),
      inputs,
      outputs,
      // undefined, not [], so hasMetadata stays false as on the Blockfrost path
      metadata: metadataEntries.length ? metadataEntries : undefined,
      certificates: this.mapOgmiosCertificates(tx.certificates ?? []),
      withdrawals: Object.entries(tx.withdrawals ?? {}).map(([stakeAddress, value]) => ({
        stakeAddress,
        amount: (value?.ada?.lovelace ?? 0).toString(),
      })),
      redeemers: mapOgmiosRedeemers(tx),
      datums: Object.entries(tx.datums ?? {}).map(([hash, cbor]) => ({ hash, cbor })),
    });
  }

  // Maps Ogmios certificates to `CertificateKind`. A delegation to both pool and DRep becomes two
  // entries with one index, as db-sync reports it. Credential hashes are re-encoded as bech32.
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
