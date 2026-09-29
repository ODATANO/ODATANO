import cds from '@sap/cds';
import type {Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { CardanoTransactionBuilder } from './cardano-tx-builder';

import {
  Addresses,
  Transaction as CardanoTransaction,
  AddressAssets,
  AddressUTxOs,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata,
  TransactionCertificates,
  TransactionWithdrawals,
  TransactionRedeemers,
  NetworkInformation,
  UTxOAssets,
  Block,
  Blocks,
  Epoch,
  Accounts,
  Pools,
  Dreps,
  PoolEpochSnapshots,
  DrepEpochSnapshots,
  EpochLedgerSnapshots,
  Assets,
  AssetHistory,
  Account,
  Drep,
  Pool,
  Asset,
  Address,
  LedgerProtocolParameter,
  AddressTransactions,
  LedgerAddresses,
  LedgerAccounts,
} from '#cds-models/CardanoODataService';

import {
  TransactionBuild,
  TransactionBuilds,
  TransactionBuildInputs,
  TransactionBuildOutputs,
  TransactionBuildRedeemers,
  TransactionSubmission,
  TransactionSubmissions,
  AddressTransactionBuilds,
} from '#cds-models/CardanoTransactionService';

import {
  SigningRequests,
  SignatureVerifications,
  AddressSigningRequests,
} from '#cds-models/CardanoSignService';

// DB-level entity: the catalogue's existence check must bypass the temporal filter that the
// service projection carries (see ensureAssetRows).
import { Assets as AssetsTable, LedgerUTxOs, LedgerUTxOAssets } from '#cds-models/odatano/cardano';

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  txSeqOf,
  mapTransactionCertificates,
  mapTransactionWithdrawals,
  mapTransactionRedeemers,
  sumUtxoAmounts,
  decodeShelleyAddress,
  decodeAssetName,
  computeCip14Fingerprint,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
  mapNetworkInfo,
  mapBlock,
  mapEpoch,
  mapAccount,
  mapAsset,
  mapBareAsset,
  mapAssetHistory,
  mapDrep,
  mapPool,
  mapPoolSnapshot,
  mapDrepSnapshot,
  mapTransactionMetadata,
  mapAddressUtxoAssets,
  mapBuildResult,
  mapBuildInputs,
  mapBuildOutputs,
  mapProtocolParameters,
  mapTransactionSubmission,
  mapAddressTransactions,
  mapAddressSigningRequest,
  mapAddressTransactionBuild
} from '../utils/mappers';

import { ProviderUnavailableError, AllBackendsFailedError, NotFoundError } from '../utils/errors';
import { TxBuildRequest, TxBuildPlutusRequest, AssetInfo, JSONValue, AccountData, PoolData, NetworkInformation as ProviderNetworkInformation, Address as ProviderAddress, Transaction as ProviderTransaction, UTxO as OdatanoUtxo, TxBuildResult, BlockData, Amount, TxInputLine, TxOutputLine, AssetHistoryEntry as AssetHistoryEntryProviderData } from '../utils/types';
import { chunk, IN_CHUNK } from '../utils/collections';
import { deleteTransactionRows, readTxKeys, seqKey, type TxKey } from './transaction-rows';
import {
  applyBlockToLedger,
  backfillPaymentCredentials,
  ledgerRowAmount,
  readLedgerOutputs,
  type LedgerAnchor,
  type LedgerLookup,
} from './ledger-state';
import { readCursor, setUtxoSetState, isCrawlerLeaseActive } from './crawler/sync-state';
import { epochOfSlot, epochStartSlot, slotToPosixSeconds } from '../utils/epoch-slots';
import { CARDANO_DEFAULTS, EPOCH_CONFIG_BY_NETWORK } from '../utils/const';
import type { EpochStateBackend } from './backends/cardano-backend';
import type { TxCacheTargets } from '../utils/tx-build-helper';

const { UPSERT, INSERT, UPDATE, SELECT, DELETE } = cds.ql;

const logger = cds.log('CardanoIndexer');

/** Lovelace aggregate from the DB (string, number or null) as an integer string. */
/** TransactionOutputs columns resolveInputs copies onto a spending input. */
interface StoredOutputRow {
  txSeq: number | string;
  outputIndex: number;
  address_address: string | null;
  utxo_dataHash: string | null;
  utxo_inlineDatum: string | null;
  utxo_referenceScriptHash: string | null;
}

/** Datum hash, inline datum and reference-script hash of the spent output onto its input. */
function copyUtxoData(input: TxInputLine, dataHash?: string | null, inlineDatum?: string | null, referenceScriptHash?: string | null): void {
  input.dataHash = input.dataHash ?? dataHash ?? null;
  input.inlineDatum = input.inlineDatum ?? inlineDatum ?? null;
  input.referenceScriptHash = input.referenceScriptHash ?? referenceScriptHash ?? null;
}

function lovelaceSum(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  return typeof value === 'number' ? BigInt(Math.trunc(value)).toString() : String(value).split('.')[0];
}

/** Provider-shaped address from its unspent outputs: type and stake address decoded from the address. */
function addressFromUtxos(address: string, utxos: OdatanoUtxo[]): ProviderAddress {
  const decoded = decodeShelleyAddress(address);
  return { address, stakeAddress: decoded.stakeAddress, type: decoded.type, isScript: decoded.isScript, amount: sumUtxoAmounts(utxos), utxos };
}

/**
 * Indexes Cardano data into the OData entities: fetches via CardanoClient, maps provider data
 * to entity rows and UPSERTs them inside the caller's CAP transaction.
 */
export class CardanoIndexer {
  private client: CardanoClient;
  private txBuilder: CardanoTransactionBuilder;
  private lastParamsFetchTime = 0;

  private static readonly CRAWL_EPOCH_REFRESH_MS = 5 * 60 * 1000;
  private static readonly CRAWL_EPOCH_RETRY_MS = 30 * 1000;

  /**
   * Crawler epoch memo: refreshed periodically while an epoch is live and once more when the
   * next one starts; holds at most the current and previous epoch. A row is UPSERTed until a
   * block transaction that wrote it has committed (`confirmBlockCommit`).
   */
  private crawlEpochCache = new Map<number, {
    row?: Epoch;
    nextRefreshAt: number;
    finalized: boolean;
  }>();
  private crawlEpochCurrent: number | null = null;
  /** Epoch rows known to be committed; a refresh creates a new row object and is written again. */
  private crawlEpochWritten = new WeakSet<Epoch>();
  /** Memo updates of the running block transaction, applied only after its commit. */
  private pendingCommit: Array<() => void> = [];
  private crawlEpochPrevious: number | null = null;

  /** Analytics coverage of the crawl path; defaults mirror the crawler config defaults. */
  private crawlAssetHistory = true;
  private crawlAssetCatalogue: 'off' | 'bare' | 'enrich' = 'bare';
  /** Certificates + withdrawals per block (ledger-state coverage). Opt-in. */
  private crawlCertificates = false;
  /** Logged once per process: the active source reports no certificates (Blockfrost). */
  private certificatesUnreportedWarned = false;
  /**
   * Crawler-fed ledger state (`crawler.utxoSet`): blocks after `utxoAnchor` are applied to the
   * Ledger* tables; no anchor means configured but inactive.
   */
  private crawlUtxoSet = false;
  /** crawler.authoritative: misses in the crawled chain are 404, no provider call. */
  private crawlAuthoritative = false;
  private utxoAnchor: LedgerAnchor | null = null;
  /** `LedgerAddresses.paymentCredential` is complete; the running fill and its table generation. */
  private credentialsReady = false;
  private credentialFill: Promise<void> | null = null;
  private credentialGeneration = 0;
  /** The anchor block was found in the crawled chain (checked once, before the first apply). */
  private utxoAnchorVerified = false;
  /**
   * Invalidation decided inside a block transaction; the anchor stays until the crawler confirms
   * the commit (`takeLedgerInvalidation`), so a rolled-back attempt changes nothing.
   */
  private ledgerInvalidation: string | null = null;

  /** Units known to have an `Assets` row, so a repeat sighting costs no DB round-trip. */
  private static readonly ASSET_MEMO_CAP = 200_000;
  /** Output references per node lookup when checking crawled UTxOs. */
  private static readonly OUTREF_CHUNK = 500;
  private assetMemo = new Set<string>();

  /**
   * Background registry enrichment queue (`assetCatalogue: 'enrich'`), drained at a fixed rate
   * outside the block transaction. Above the cap the oldest units are dropped (bare row stays).
   */
  private static readonly ENRICH_QUEUE_CAP = 50_000;
  private enrichQueue: string[] = [];
  private enrichTimer: ReturnType<typeof setInterval> | null = null;
  private enrichRate = 2;

  /** Adopt the crawler's coverage settings; the lazy request path never touches these. */
  configureCrawlCoverage(coverage: {
    assetHistory: boolean;
    assetCatalogue: 'off' | 'bare' | 'enrich';
    assetEnrichRate?: number;
    certificates?: boolean;
    utxoSet?: boolean;
    authoritative?: boolean;
  }): void {
    this.crawlAuthoritative = coverage.authoritative ?? false;
    this.crawlAssetHistory = coverage.assetHistory;
    this.crawlAssetCatalogue = coverage.assetCatalogue;
    this.crawlCertificates = coverage.certificates ?? false;
    this.crawlUtxoSet = coverage.utxoSet ?? false;
    this.enrichRate = coverage.assetEnrichRate ?? this.enrichRate;
    if (coverage.assetCatalogue !== 'enrich') this.stopAssetEnrichment();
  }

  /**
   * What the crawled data answers authoritatively: only while a live crawler is at the tip.
   * Every block after `fromSlot` is held; `ledger` = the crawled UTxO set is active.
   */
  private async localCoverage(tx: CapTransaction): Promise<{ fromSlot: number; lastSlot: number; ledger: boolean } | null> {
    const cursor = await readCursor(tx);
    if (!cursor || cursor.syncStatus !== 'synced' || cursor.startSlot == null || !isCrawlerLeaseActive(cursor)) return null;
    return { fromSlot: cursor.startSlot, lastSlot: cursor.lastSlot, ledger: cursor.utxoSet.status === 'active' };
  }

  /**
   * Block counts of a pool from crawled blocks (`slotLeader` = pool id): the current epoch when the
   * crawl covers it from its first slot, the lifetime total when it covers the chain since Shelley.
   */
  private async localPoolBlocks(tx: CapTransaction, poolId: string): Promise<{ blocksEpoch?: number; blocksMinted?: number }> {
    const coverage = await this.localCoverage(tx);
    if (!coverage) return {};
    const network = this.client.network;
    const countSince = async (fromSlot: number): Promise<number> => {
      const row = await tx.run(
        SELECT.one.from(Blocks).columns('count(*) as n').where({ slotLeader: poolId, slot: { '>=': fromSlot } })
      ) as { n?: number | string } | undefined;
      return Number(row?.n ?? 0);
    };
    const counts: { blocksEpoch?: number; blocksMinted?: number } = {};
    const epochStart = epochStartSlot(network, epochOfSlot(network, coverage.lastSlot));
    if (coverage.fromSlot < epochStart) counts.blocksEpoch = await countSince(epochStart);
    if (coverage.fromSlot <= EPOCH_CONFIG_BY_NETWORK[network].shelleyStartSlot) counts.blocksMinted = await countSince(0);
    return counts;
  }

  /**
   * The crawled chain answers `method` on its own: live crawler at the tip, crawl from the Shelley
   * start, and either crawler.authoritative or no configured backend can serve the method.
   */
  private async crawlAnswers(tx: CapTransaction, method: string): Promise<{ lastSlot: number } | null> {
    const coverage = await this.localCoverage(tx);
    if (!coverage || coverage.fromSlot > EPOCH_CONFIG_BY_NETWORK[this.client.network].shelleyStartSlot) return null;
    if (!this.crawlAuthoritative && this.client.hasBackendFor(method)) return null;
    return { lastSlot: coverage.lastSlot };
  }

  /** 404 for a lookup the crawled chain answers on its own (the caller already missed in the DB). */
  async refuseOutsideCrawl(tx: CapTransaction, method: string, what: string): Promise<void> {
    const coverage = await this.crawlAnswers(tx, method);
    if (coverage) throw new NotFoundError(`${what} (not in the crawled chain up to slot ${coverage.lastSlot})`);
  }

  /**
   * Asset from crawled mint/burn rows: supply = mints − burns, first mint, CIP-25 payload (label 721)
   * of the latest mint. Registry fields stay null. null = the crawled chain does not answer.
   */
  private async localAssetInfo(tx: CapTransaction, unit: string): Promise<AssetInfo | null> {
    if (!this.crawlAssetHistory || !(await this.crawlAnswers(tx, 'getAssetInfo'))) return null;
    const events = await tx.run(
      SELECT.from(AssetHistory).columns('txHash', 'action', 'quantity', 'blockTime', 'blockHeight').where({ unit })
    ) as Array<{ txHash: string; action: string; quantity: unknown; blockTime?: number | string | null; blockHeight?: number | string | null }>;
    if (!events?.length) throw new NotFoundError(`Asset ${unit} (never minted in the crawled chain)`);

    const ordered = [...events].sort((a, b) => Number(a.blockHeight ?? 0) - Number(b.blockHeight ?? 0));
    let supply = 0n;
    for (const e of ordered) supply += (e.action === 'burn' ? -1n : 1n) * BigInt(String(e.quantity ?? '0'));
    const mints = ordered.filter(e => e.action !== 'burn');
    const first = mints[0];
    const latest = mints[mints.length - 1];

    let onchainMetadata: JSONValue | null = null;
    if (latest) {
      const meta = await tx.run(
        SELECT.one.from(TransactionMetadata).columns('payload').where({ tx_hash: latest.txHash, label: '721' })
      ) as { payload?: string | null } | undefined;
      if (meta?.payload) {
        try { onchainMetadata = JSON.parse(meta.payload) as JSONValue; } catch { /* unparseable payload: leave empty */ }
      }
    }

    const policyId = unit.slice(0, 56);
    const assetNameHex = unit.slice(56);
    return {
      unit,
      policyId,
      assetNameHex,
      assetName: assetNameHex ? decodeAssetName(assetNameHex) : null,
      fingerprint: computeCip14Fingerprint(policyId, assetNameHex),
      totalSupply: supply.toString(),
      mintOrBurnCount: ordered.length,
      initialMintTxHash: first?.txHash ?? null,
      initialMintTime: first?.blockTime == null ? null : Number(first.blockTime),
      onchainMetadata,
      registryName: null,
      registryTicker: null,
      registryDecimals: null,
      registryDescription: null,
      registryUrl: null,
      registryLogo: null,
    };
  }

  /** Address from the crawled UTxO set when it answers, else from the backend. */
  async resolveAddress(tx: CapTransaction, addr: string): Promise<ProviderAddress> {
    return (await this.localAddress(tx, addr)) ?? await this.client.getAddress(addr);
  }

  /** UTxOs of an address: the crawled set (checked unspent at the node) when it answers, else the backend. */
  async resolveAddressUtxos(tx: CapTransaction, addr: string): Promise<OdatanoUtxo[]> {
    return (await this.localAddress(tx, addr))?.utxos ?? await this.client.getAddressUtxos(addr);
  }

  /** Asset from the crawled chain when it answers, else from the backend. */
  async resolveAssetInfo(tx: CapTransaction, unit: string): Promise<AssetInfo> {
    return (await this.localAssetInfo(tx, unit)) ?? await this.client.getAssetInfo(unit);
  }

  /** Mint/burn events, newest first: crawled rows when the crawled chain answers, else the backend. */
  async resolveAssetHistory(tx: CapTransaction, unit: string, limit: number): Promise<AssetHistoryEntryProviderData[]> {
    if (this.crawlAssetHistory && await this.crawlAnswers(tx, 'getAssetHistory')) {
      const rows = await tx.run(
        SELECT.from(AssetHistory).where({ unit }).orderBy('blockHeight desc').limit(limit)
      ) as Array<Record<string, unknown>>;
      return (rows ?? []).map(r => ({
        unit: String(r.unit),
        txHash: String(r.txHash),
        action: r.action === 'burn' ? 'burn' as const : 'mint' as const,
        quantity: String(r.quantity),
        blockTime: r.blockTime == null ? null : Number(r.blockTime),
        blockHeight: r.blockHeight == null ? null : Number(r.blockHeight),
      }));
    }
    return this.client.getAssetHistory(unit, limit);
  }

  /** UTxOs of a payment credential: the crawled set when it answers, else Koios. */
  async resolveCredentialUtxos(tx: CapTransaction, credHash: string): Promise<OdatanoUtxo[]> {
    return (await this.localCredentialUtxos(tx, credHash)) ?? await this.client.getCredentialUtxos(credHash);
  }

  /** Latest transaction hashes of an address: the crawled set when it has enough, else the backend. */
  async resolveAddressTransactionHashes(tx: CapTransaction, addr: string, limit: number): Promise<string[]> {
    const local = await this.localAddressTransactions(tx, addr, limit);
    if (local && (local.complete || local.rows.length >= limit)) {
      return local.rows.map(r => String((r as unknown as { tx_hash: string }).tx_hash));
    }
    try {
      return await this.client.getAddressTransactionHashes(addr, limit);
    } catch (err) {
      if (local && (err instanceof ProviderUnavailableError || err instanceof AllBackendsFailedError)) {
        return local.rows.map(r => String((r as unknown as { tx_hash: string }).tx_hash));
      }
      throw err;
    }
  }

  /** True while the crawled UTxO set answers address queries (live crawler at the tip, set active). */
  async ledgerCoverageActive(tx: CapTransaction): Promise<boolean> {
    return Boolean((await this.localCoverage(tx))?.ledger);
  }

  /**
   * Address from the crawled UTxO set: the unspent `LedgerUTxOs` (see openLedgerUtxos), type and
   * stake address decoded from the address. An address the set has never
   * seen is an empty address, not an error. null = the set cannot answer.
   */
  private async localAddress(tx: CapTransaction, addr: string): Promise<ProviderAddress | null> {
    if (!(await this.localCoverage(tx))?.ledger) return null;
    return addressFromUtxos(addr, await this.openLedgerUtxos(tx, [addr]));
  }

  /** Addresses of a stake key from the crawled UTxO set, with their unspent outputs (one read for all). */
  private async localAccountAddresses(tx: CapTransaction, stakeAddress: string): Promise<ProviderAddress[]> {
    const rows = await tx.run(
      SELECT.from(LedgerAddresses).columns('address').where({ stakeAddress })
    ) as Array<{ address: string }>;
    const addresses = (rows ?? []).map(r => r.address);
    if (addresses.length === 0) return [];
    const byAddress = new Map<string, OdatanoUtxo[]>(addresses.map(a => [a, []]));
    for (const u of await this.openLedgerUtxos(tx, addresses)) byAddress.get(u.address)?.push(u);
    return addresses.map(a => addressFromUtxos(a, byAddress.get(a)!));
  }

  /**
   * Latest transactions of an address from the crawled UTxO set: the outputs it received
   * (`LedgerUTxOs.txHash`) and spent (`spentTxHash`) since the anchor. `complete` = the address was
   * first seen after the anchor, so nothing older exists. null = the set cannot answer.
   */
  private async localAddressTransactions(
    tx: CapTransaction,
    addr: string,
    limit: number,
  ): Promise<{ rows: AddressTransactions[]; complete: boolean } | null> {
    if (!(await this.localCoverage(tx))?.ledger) return null;
    const known = await tx.run(
      SELECT.one.from(LedgerAddresses).columns('firstSeenSlot').where({ address: addr })
    ) as { firstSeenSlot?: number | string | null } | undefined;
    if (!known) return { rows: [], complete: false };
    const complete = known.firstSeenSlot != null;

    // Candidate transactions by slot; a transaction can touch the address with several outputs.
    const scan = Math.min(limit * 20, 2000);
    const [created, spent] = await Promise.all([
      tx.run(SELECT.from(LedgerUTxOs).columns('txHash', 'createdSlot')
        .where({ address: addr, createdSlot: { '>=': 0 } }).orderBy('createdSlot desc').limit(scan)),
      tx.run(SELECT.from(LedgerUTxOs).columns('spentTxHash', 'spentSlot')
        .where({ address: addr, spentSlot: { '>=': 0 } }).orderBy('spentSlot desc').limit(scan)),
    ]) as [Array<{ txHash: string; createdSlot: number | string }>, Array<{ spentTxHash: string; spentSlot: number | string }>];
    const slotOf = new Map<string, number>();
    for (const r of created ?? []) slotOf.set(r.txHash, Number(r.createdSlot));
    for (const r of spent ?? []) slotOf.set(r.spentTxHash, Number(r.spentSlot));
    const selected = [...slotOf].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([hash]) => hash);
    if (selected.length === 0) return { rows: [], complete };

    const [outRows, inRows] = await Promise.all([
      tx.run(SELECT.from(LedgerUTxOs).where({ address: addr, txHash: { in: selected } })),
      tx.run(SELECT.from(LedgerUTxOs).where({ address: addr, spentTxHash: { in: selected } })),
    ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
    const amounts = await this.ledgerAmounts(tx, [...(outRows ?? []), ...(inRows ?? [])]);
    const amountOf = (r: Record<string, unknown>) => amounts.get(`${r.txHash}#${Number(r.outputIndex)}`) ?? [];

    const txs = selected.map((hash) => ({
      hash,
      blockTime: slotToPosixSeconds(this.client.network, slotOf.get(hash)!),
      inputs: (inRows ?? []).filter(r => r.spentTxHash === hash).map(r => ({ address: addr, amount: amountOf(r) })),
      outputs: (outRows ?? []).filter(r => r.txHash === hash).map(r => ({ address: addr, amount: amountOf(r) })),
    }));
    const rows = mapAddressTransactions(addr, txs as unknown as ProviderTransaction[]);
    rows.sort((a, b) => Number(b.blockTime ?? 0) - Number(a.blockTime ?? 0));
    return { rows: rows as unknown as AddressTransactions[], complete };
  }

  /** Amount lists (lovelace + assets) of `LedgerUTxOs` rows, keyed `txHash#outputIndex`. */
  private async ledgerAmounts(tx: CapTransaction, rows: Array<Record<string, unknown>>): Promise<Map<string, Amount[]>> {
    const out = new Map<string, Amount[]>();
    for (const r of rows) out.set(`${r.txHash}#${Number(r.outputIndex)}`, [{ unit: 'lovelace', quantity: String(r.lovelace ?? '0') }]);
    const withAssets = [...new Set(rows.filter(r => r.hasAssets).map(r => String(r.txHash)))];
    for (const hashChunk of chunk(withAssets, IN_CHUNK)) {
      const assetRows = await tx.run(
        SELECT.from(LedgerUTxOAssets).columns('utxo_txHash', 'utxo_outputIndex', 'unit', 'asset_quantity')
          .where({ utxo_txHash: { in: hashChunk } })
      ) as Array<{ utxo_txHash: string; utxo_outputIndex: number | string; unit: string; asset_quantity: unknown }>;
      for (const a of assetRows ?? []) {
        out.get(`${a.utxo_txHash}#${Number(a.utxo_outputIndex)}`)?.push({ unit: a.unit, quantity: String(a.asset_quantity) });
      }
    }
    return out;
  }

  /**
   * Active stake of a pool from the Ogmios epoch snapshot of the running epoch (constant within
   * an epoch). Empty when the crawler is not at the tip or the epoch has no such snapshot.
   */
  private async snapshotActiveStake(tx: CapTransaction, poolId: string): Promise<{ activeStake?: string; activeSize?: number }> {
    const coverage = await this.localCoverage(tx);
    if (!coverage) return {};
    const epoch = epochOfSlot(this.client.network, coverage.lastSlot);
    const row = await tx.run(
      SELECT.one.from(PoolEpochSnapshots).columns('activeStake', 'activeSize').where({ poolId, epoch, source: 'ogmios' })
    ) as { activeStake?: unknown; activeSize?: unknown } | undefined;
    if (!row || row.activeStake == null) return {};
    return { activeStake: lovelaceSum(row.activeStake), activeSize: Number(row.activeSize ?? 0) };
  }

  /**
   * Lifetime withdrawals of a stake key from crawled withdrawals — only when certificates are
   * crawled and the crawl covers the chain since Shelley; null otherwise.
   */
  private async localWithdrawalsSum(tx: CapTransaction, stakeAddress: string): Promise<string | null> {
    const coverage = await this.localCoverage(tx);
    if (!coverage || !this.crawlCertificates) return null;
    if (coverage.fromSlot > EPOCH_CONFIG_BY_NETWORK[this.client.network].shelleyStartSlot) return null;
    const row = await tx.run(
      SELECT.one.from(TransactionWithdrawals).columns('sum(lovelace) as total').where({ stakeAddress })
    ) as { total?: unknown } | undefined;
    return lovelaceSum(row?.total);
  }

  /** The anchor the imported UTxO set describes (null = ledger mode inactive). */
  setUtxoAnchor(anchor: LedgerAnchor | null): void {
    this.utxoAnchor = anchor;
    this.utxoAnchorVerified = false;
    this.ledgerInvalidation = null;
  }

  /**
   * The imported set describes the chain AT the anchor block, so before the first block past it
   * is applied the cursor (not yet advanced in this transaction) must equal the anchor exactly;
   * otherwise the snapshot was taken on a fork. Skipped once `utxoAppliedSlot` is set.
   */
  private async verifyUtxoAnchor(tx: CapTransaction, anchor: LedgerAnchor): Promise<boolean> {
    const cursor = await readCursor(tx);
    if (cursor?.utxoSet.appliedSlot != null) return true;
    if (cursor && cursor.lastSlot === anchor.slot && (cursor.lastBlockHash ?? '').toLowerCase() === anchor.hash.toLowerCase()) return true;
    const reason = cursor
      ? `anchor ${anchor.slot}/${anchor.hash} is not the block the crawler followed (cursor ${cursor.lastSlot}/${cursor.lastBlockHash})`
      : `no crawler cursor to verify the anchor ${anchor.slot}/${anchor.hash} against`;
    logger.error(`UTxO set invalidated: ${reason} — the snapshot describes a fork; re-import at the crawler cursor`);
    await setUtxoSetState(tx, { status: 'invalid', error: reason.slice(0, 500) });
    this.ledgerInvalidation = reason;
    return false;
  }

  /** Null while the mode is off, nothing is imported, or an invalidation awaits its commit. */
  getUtxoAnchor(): LedgerAnchor | null {
    return this.crawlUtxoSet && !this.ledgerInvalidation ? this.utxoAnchor : null;
  }

  /** Apply the memo updates of the block transaction that just committed. */
  confirmBlockCommit(): void {
    const pending = this.pendingCommit;
    this.pendingCommit = [];
    for (const apply of pending) apply();
  }

  /** Hand out a pending invalidation (dropping the anchor) exactly once after the block commit, or null. */
  takeLedgerInvalidation(): string | null {
    const reason = this.ledgerInvalidation;
    if (reason) {
      this.ledgerInvalidation = null;
      this.utxoAnchor = null;
      this.utxoAnchorVerified = false;
    }
    return reason;
  }

  /**
   * Drain the enrichment queue at `enrichRate` units per second, one `indexAsset()` per tick in
   * its own transaction. A failing unit is dropped; its bare row stays for the lazy path.
   */
  private startAssetEnrichment(): void {
    if (this.enrichTimer || this.crawlAssetCatalogue !== 'enrich') return;
    const intervalMs = Math.max(1, Math.round(1000 / Math.max(1, this.enrichRate)));
    this.enrichTimer = setInterval(() => {
      const unit = this.enrichQueue.shift();
      if (unit === undefined) {
        this.stopAssetEnrichment();
        return;
      }
      void cds.tx((tx) => this.indexAsset(tx as CapTransaction, unit)).catch((err: unknown) => {
        logger.debug(`asset enrichment for ${unit} failed (bare row kept):`, err);
      });
    }, intervalMs);
    this.enrichTimer.unref?.();
  }

  /** Stop the enrichment loop and forget what is still queued (shutdown, crawler halt, mode change). */
  stopAssetEnrichment(): void {
    if (this.enrichTimer) {
      clearInterval(this.enrichTimer);
      this.enrichTimer = null;
    }
    this.enrichQueue = [];
  }

  /**
   * Network-only epoch prefetch for the crawler. Call BEFORE opening the per-block write
   * transaction so no backend round-trip runs under the DB write lock. Never throws.
   */
  async prefetchCrawlEpoch(epochNumber: number): Promise<void> {
    const previousEpoch = this.crawlEpochCurrent;
    const enteringNewEpoch = previousEpoch !== null && previousEpoch !== epochNumber;

    // At an epoch boundary, refresh the completed epoch one last time. A failed
    // final refresh is retried with a short backoff on subsequent blocks.
    if (enteringNewEpoch && previousEpoch !== null) {
      await this.refreshCrawlEpoch(previousEpoch, true, true);
      this.crawlEpochPrevious = previousEpoch;
    } else {
      for (const [cachedEpoch, entry] of this.crawlEpochCache) {
        if (cachedEpoch !== epochNumber && !entry.finalized) {
          await this.refreshCrawlEpoch(cachedEpoch, false, true);
        }
      }
    }

    await this.refreshCrawlEpoch(epochNumber, false, false);
    this.crawlEpochCurrent = epochNumber;

    // Keep only the live epoch and its predecessor/final snapshot.
    for (const cachedEpoch of this.crawlEpochCache.keys()) {
      if (cachedEpoch !== epochNumber && cachedEpoch !== this.crawlEpochPrevious) {
        this.crawlEpochCache.delete(cachedEpoch);
      }
    }
  }

  private async refreshCrawlEpoch(
    epochNumber: number,
    force: boolean,
    finalized: boolean,
  ): Promise<void> {
    const now = Date.now();
    const existing = this.crawlEpochCache.get(epochNumber);
    if (existing?.finalized && finalized) return;
    if (!force && existing && now < existing.nextRefreshAt) return;

    const crawled = await this.crawledEpochTotals(epochNumber);
    try {
      const provided = mapEpoch(await this.client.getEpoch(epochNumber));
      this.crawlEpochCache.set(epochNumber, {
        row: crawled ? { ...provided, ...crawled } : provided,
        nextRefreshAt: now + CardanoIndexer.CRAWL_EPOCH_REFRESH_MS,
        finalized,
      });
    } catch {
      // Keep the last good snapshot (or the crawled totals alone), but retry transient/negative
      // results soon rather than suppressing enrichment for the rest of the five-day epoch.
      const base = existing?.row ?? (crawled ? this.bareEpochRow(epochNumber) : undefined);
      this.crawlEpochCache.set(epochNumber, {
        row: base && crawled ? { ...base, ...crawled } : base,
        nextRefreshAt: now + CardanoIndexer.CRAWL_EPOCH_RETRY_MS,
        finalized: false,
      });
    }
  }

  /**
   * Block, transaction and fee totals of an epoch summed over the crawled blocks, when the crawl
   * covers the epoch from its first slot; null otherwise. Output and active stake stay with the backend.
   */
  private async crawledEpochTotals(epochNumber: number): Promise<Partial<Epoch> | null> {
    try {
      const cursor = await readCursor(cds.db as unknown as CapTransaction);
      if (cursor?.startSlot == null || cursor.startSlot >= epochStartSlot(this.client.network, epochNumber)) return null;
      const row = await cds.db.run(
        SELECT.one.from(Blocks)
          .columns('count(*) as blockCount', 'sum(txCount) as txCount', 'sum(fees) as fees', 'min(time) as firstBlockTime', 'max(time) as lastBlockTime')
          .where({ epochNumber })
      ) as { blockCount?: number | string; txCount?: number | string | null; fees?: unknown; firstBlockTime?: string | null; lastBlockTime?: string | null } | undefined;
      if (!row || Number(row.blockCount ?? 0) === 0) return null;
      return {
        blockCount: Number(row.blockCount),
        txCount: Number(row.txCount ?? 0),
        fees: lovelaceSum(row.fees),
        firstBlockTime: row.firstBlockTime != null ? Number(row.firstBlockTime) : null,
        lastBlockTime: row.lastBlockTime != null ? Number(row.lastBlockTime) : null,
      };
    } catch (err) {
      logger.debug(`Crawled totals for epoch ${epochNumber} unavailable:`, err);
      return null;
    }
  }

  /** Epoch row with only the slot-derived bounds, for an epoch the backend cannot describe. */
  private bareEpochRow(epochNumber: number): Epoch {
    const network = this.client.network;
    const start = epochStartSlot(network, epochNumber);
    return {
      epoch: epochNumber,
      startTime: slotToPosixSeconds(network, start),
      endTime: slotToPosixSeconds(network, epochStartSlot(network, epochNumber + 1)),
      output: null,
      activeStake: null,
    };
  }

  constructor(client: CardanoClient, txBuilder: CardanoTransactionBuilder) {
    this.client = client;
    this.txBuilder = txBuilder;
    txBuilder.setAddressUtxoSource?.((address) => this.localAddressUtxos(address));
    logger.info('CardanoIndexer instance created');
  }

  /**
   * Unspent outputs of an address from the crawled set for the transaction builder; null = the set
   * cannot answer. Runs on `cds.db`, i.e. inside the caller's request transaction when there is one.
   */
  private async localAddressUtxos(address: string): Promise<OdatanoUtxo[] | null> {
    return (await this.localAddress(cds.db as unknown as CapTransaction, address))?.utxos ?? null;
  }

  /**
   * Index a transaction with inputs/outputs/assets/metadata; all UPSERTs run in the caller's
   * transaction, so either everything persists or nothing does.
   */
  async indexTransaction(tx: CapTransaction, txHash: string): Promise<CardanoTransaction> {
    await this.refuseOutsideCrawl(tx, 'getTransaction', `Transaction ${txHash}`);
    const providerTx = await this.client.getTransaction(txHash);
    const txRow = mapTransaction(providerTx);

    await tx.run(UPSERT.into(Transactions).entries(txRow))

    logger.debug(`indexTransaction: upserted transaction ${txHash}`);

    await this.writeTransactionChildren(tx, providerTx, txRow.txSeq as number);
    return txRow;
  }

  /** Lazy path: inputs, outputs, their assets and metadata of one transaction. */
  private async writeTransactionChildren(tx: CapTransaction, providerTx: ProviderTransaction, txSeq: number): Promise<void> {
    if (providerTx.inputs) {
      const inputRows = mapTransactionInputs(txSeq, providerTx.inputs);
      const inputAssetRows = mapTransactionInputAssets(txSeq, providerTx.inputs);
      if (inputRows.length) await tx.run(UPSERT.into(TransactionInputs).entries(inputRows));
      if (inputAssetRows.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows));
    }
    // outputs must not depend on the inputs branch
    if (providerTx.outputs) {
      const outputRows = mapTransactionOutputs(txSeq, providerTx.outputs);
      const outputAssetRows = mapTransactionOutputAssets(txSeq, providerTx.outputs);
      if (outputRows.length) await tx.run(UPSERT.into(TransactionOutputs).entries(outputRows));
      if (outputAssetRows.length) await tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows));
    }
    const metadataRows = mapTransactionMetadata(providerTx.metadata || []);
    if (metadataRows.length) await tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows));
  }

  /**
   * Index address data with assets and UTxOs; transactions are loaded separately via
   * indexAddressTransactions(). `prefetched` = address data the caller already fetched in a batch.
   */
  async indexAddress(tx: CapTransaction, addr: string, prefetched?: ProviderAddress): Promise<Address> {
    const addrData = prefetched ?? await this.resolveAddress(tx, addr);

    logger.debug(`indexAddress: provider response for ${addr}: ${addrData.amount?.length ?? 0} amounts, ${addrData.utxos?.length ?? 0} utxos`);

    const AddrEntity = mapAddress(addr, addrData, this.client.max_age_ms);
    const now = new Date().toISOString();
    const validFrom = AddrEntity.validFrom ?? now;
    const validTo = AddrEntity.validTo ?? now;

    await tx.run(UPSERT.into(Addresses).entries(AddrEntity));

    // Supplement address-level amounts with assets only present in UTxOs
    const addressAssetUnits = new Set(addrData.amount.filter(a => a.unit !== 'lovelace').map(a => a.unit));
    for (const utxo of addrData.utxos) {
      for (const amt of utxo.amount) {
        if (amt.unit === 'lovelace' || addressAssetUnits.has(amt.unit)) continue;
        addrData.amount.push(amt);
        addressAssetUnits.add(amt.unit);
      }
    }

    const assetEntities = mapAddressAssets(addr, validFrom, validTo, addrData.amount);

    logger.debug(`indexAddress: ${assetEntities.length} asset entities`);

    if (assetEntities.length > 0) {
      await tx.run(UPSERT.into(AddressAssets).entries(assetEntities));
    }

    // UTxOs are included in getAddress response
    const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, addrData.utxos);

    logger.debug(`indexAddress: ${utxoEntities.length} utxo entities`);

    if (utxoEntities.length) {
      await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
    }

    const utxoAssetEntities = mapAddressUtxoAssets(addrData.utxos, validFrom, validTo);
    logger.debug(`indexAddress: ${utxoAssetEntities.length} utxo asset entities`);

    if (utxoAssetEntities.length) {
      // Remove possible duplicates before upsert
      const seen = new Set<string>();
      const uniqueAssets = utxoAssetEntities.filter(asset => {
        const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      logger.debug(`indexAddress: ${utxoAssetEntities.length} assets, ${uniqueAssets.length} unique (removed ${utxoAssetEntities.length - uniqueAssets.length} duplicates)`);
      await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
    }

    // Always pre-index recent transactions (regardless of asset presence)
    try {
      const txEntities = await this.indexAddressTransactions(tx, addr, 10);
      if (txEntities.length > 0) {
        await tx.run(
          UPDATE.entity(Addresses).set({ hasTransactions: true }).where({ address: addr })
        );
        AddrEntity.hasTransactions = true;
      }
    } catch (err) {
      logger.error(`indexAddressTransactions failed for address ${addr}: ${(err as Error).message}`);
    }

    return AddrEntity;
  }

  /**
   * Index UTxOs by 28-byte payment credential (56-char hex), always fresh from Koios. Child
   * rows are UPSERTed without a parent Addresses row (same pattern as TransactionInputs).
   */
  async indexCredentialUtxos(tx: CapTransaction, credHash: string): Promise<AddressUTxOs[]> {
    const local = await this.localCredentialUtxos(tx, credHash);
    const utxos = local ?? await this.client.getCredentialUtxos(credHash);

    logger.debug(`indexCredentialUtxos: ${local ? 'crawled UTxO set' : 'provider'} returned ${utxos.length} utxos for credential ${credHash}`);

    if (utxos.length === 0) return [];

    // Group by bech32 address — Koios returns UTxOs across all bech32 forms
    // sharing the credential; mapAddressUtxos keys rows by address parameter.
    const byAddress = new Map<string, OdatanoUtxo[]>();
    for (const u of utxos) {
      const list = byAddress.get(u.address) ?? [];
      list.push(u);
      byAddress.set(u.address, list);
    }

    const validFrom = new Date().toISOString();
    const validTo = new Date(Date.now() + this.client.max_age_ms).toISOString();
    const allRows: AddressUTxOs[] = [];

    for (const [addr, group] of byAddress) {
      const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, group);
      if (utxoEntities.length) {
        await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
      }

      const utxoAssetEntities = mapAddressUtxoAssets(group, validFrom, validTo);
      if (utxoAssetEntities.length) {
        const seen = new Set<string>();
        const uniqueAssets = utxoAssetEntities.filter(asset => {
          const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
      }

      allRows.push(...(utxoEntities as AddressUTxOs[]));
    }

    logger.debug(`indexCredentialUtxos: indexed ${allRows.length} utxos across ${byAddress.size} addresses`);
    return allRows;
  }

  /**
   * UTxOs of a payment credential without a provider: addresses and unspent outputs from the crawled
   * UTxO set (see openLedgerUtxos).
   * null = the crawled set cannot answer (not synced, no set, credential column still filling).
   * An address first used in the last `confirmationDepth` blocks is not in the set yet.
   */
  private async localCredentialUtxos(tx: CapTransaction, credHash: string): Promise<OdatanoUtxo[] | null> {
    if (!(await this.localCoverage(tx))?.ledger || !(await this.paymentCredentialsReady())) return null;
    const rows = await tx.run(
      SELECT.from(LedgerAddresses).columns('address').where({ paymentCredential: credHash })
    ) as Array<{ address: string }>;
    const addresses = (rows ?? []).map(r => r.address);
    if (addresses.length === 0) return [];
    return this.openLedgerUtxos(tx, addresses);
  }

  /**
   * Unspent outputs of addresses from the crawled set, checked against the node by output reference
   * (a keyed lookup; the node's address query scans its whole UTxO set): drops what was spent after
   * the cursor. Without a usable node, or when the check fails, the set as of the cursor.
   */
  private async openLedgerUtxos(tx: CapTransaction, addresses: string[]): Promise<OdatanoUtxo[]> {
    const rows = await this.ledgerUtxosOf(tx, addresses);
    if (rows.length === 0) return rows;
    try {
      const unspent = new Map<string, OdatanoUtxo>();
      for (const refChunk of chunk(rows, CardanoIndexer.OUTREF_CHUNK)) {
        const live = await this.client.getUnspentOutputs(refChunk.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })));
        if (live === null) return rows;
        for (const u of live) unspent.set(`${u.txHash}#${u.outputIndex}`, u);
      }
      // The node's answer names the reference script, which a snapshot row from a file import lacks
      return rows.flatMap(u => {
        const live = unspent.get(`${u.txHash}#${u.outputIndex}`);
        if (!live) return [];
        return [{ ...u, scriptRef: u.scriptRef ?? live.scriptRef ?? undefined, scriptRefCbor: live.scriptRefCbor ?? u.scriptRefCbor }];
      });
    } catch (err) {
      logger.warn(`unspent check of ${rows.length} crawled outputs failed, answering as of the cursor: ${(err as Error)?.message ?? err}`);
      return rows;
    }
  }

  /** Unspent `LedgerUTxOs` (+ assets) of the given addresses in the provider UTxO shape. */
  private async ledgerUtxosOf(tx: CapTransaction, addresses: string[]): Promise<OdatanoUtxo[]> {
    const out: OdatanoUtxo[] = [];
    for (const addrChunk of chunk(addresses, IN_CHUNK)) {
      const utxos = await tx.run(
        SELECT.from(LedgerUTxOs).where({ address: { in: addrChunk }, spentTxHash: null })
      ) as Array<Record<string, unknown>>;
      const amounts = await this.ledgerAmounts(tx, utxos ?? []);
      for (const u of utxos ?? []) {
        const txHash = String(u.txHash);
        const outputIndex = Number(u.outputIndex);
        out.push({
          txHash,
          outputIndex,
          address: String(u.address),
          amount: amounts.get(`${txHash}#${outputIndex}`) ?? [],
          blockHash: '',
          datumHash: (u.utxo_dataHash as string | null) ?? undefined,
          inlineDatum: (u.utxo_inlineDatum as string | null) ?? null,
          scriptRef: (u.utxo_referenceScriptHash as string | null) ?? undefined,
        });
      }
    }
    return out;
  }

  /**
   * True once every Shelley-type `LedgerAddresses` row carries its payment credential. Until then
   * the fill runs in the background (started once per process) and callers use the provider.
   */
  async paymentCredentialsReady(): Promise<boolean> {
    if (this.credentialsReady) return true;
    if (!this.credentialFill) {
      const generation = this.credentialGeneration;
      this.credentialFill = backfillPaymentCredentials()
        .then((n) => {
          if (generation !== this.credentialGeneration) return;
          this.credentialsReady = true;
          if (n > 0) logger.info(`payment credentials filled for ${n} ledger addresses`);
        })
        .catch((err: unknown) => logger.error('payment credential fill failed (retried on the next lookup):', err))
        .finally(() => { this.credentialFill = null; });
    }
    return false;
  }

  /** The ledger tables were replaced (re-import): the credential column has to be filled again. */
  resetPaymentCredentials(): void {
    this.credentialGeneration++;
    this.credentialsReady = false;
  }

  /**
   * Index only the UTxOs of an address via getAddressUtxos (no getAddress call), so it works on
   * backends without address aggregation such as Ogmios. Writes no parent Addresses row.
   */
  async indexAddressUtxos(tx: CapTransaction, addr: string): Promise<AddressUTxOs[]> {
    const utxos = await this.client.getAddressUtxos(addr);
    logger.debug(`indexAddressUtxos: provider returned ${utxos.length} utxos for ${addr}`);

    const validFrom = new Date().toISOString();
    const validTo = new Date(Date.now() + this.client.max_age_ms).toISOString();

    const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, utxos);
    if (utxoEntities.length) {
      await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
    }

    const utxoAssetEntities = mapAddressUtxoAssets(utxos, validFrom, validTo);
    if (utxoAssetEntities.length) {
      const seen = new Set<string>();
      const uniqueAssets = utxoAssetEntities.filter(asset => {
        const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
    }

    return utxoEntities as AddressUTxOs[];
  }

  /**
   * Evict cached rows a submitted transaction made stale: every consumed input ref (under any
   * address) and all address-level rows of the output addresses plus `extraAddresses`. Only the
   * read cache is touched; lagging backends may still serve pre-submit state on refetch.
   */
  async invalidateUtxoCacheForTx(
    tx: CapTransaction,
    targets: TxCacheTargets,
    extraAddresses: string[] = []
  ): Promise<void> {
    const addresses = [...new Set([...targets.outputAddresses, ...extraAddresses])];
    for (const address of addresses) {
      await tx.run(DELETE.from(UTxOAssets).where({ utxo_address_address: address }));
      await tx.run(DELETE.from(AddressUTxOs).where({ address_address: address }));
      await tx.run(DELETE.from(AddressAssets).where({ address_address: address }));
      await tx.run(DELETE.from(Addresses).where({ address }));
    }
    for (const input of targets.inputs) {
      await tx.run(DELETE.from(UTxOAssets).where({ utxo_hash: input.txHash, utxo_index: input.outputIndex }));
      await tx.run(DELETE.from(AddressUTxOs).where({ hash: input.txHash, index: input.outputIndex }));
    }
    if (addresses.length || targets.inputs.length) {
      logger.debug(`Invalidated UTxO cache: ${addresses.length} address(es), ${targets.inputs.length} spent input ref(s)`);
    }
  }

  /** Index address transactions (separate from indexAddress for lazy loading). */
  async indexAddressTransactions(tx: CapTransaction, addr: string, limit: number): Promise<AddressTransactions[]> {
    logger.debug(`indexAddressTransactions: fetching transactions for ${addr}`);

    const local = await this.localAddressTransactions(tx, addr, limit);
    const keepLocal = async (): Promise<AddressTransactions[]> => {
      if (local!.rows.length) await tx.run(UPSERT.into(AddressTransactions).entries(local!.rows as never));
      return local!.rows;
    };
    if (local && (local.complete || local.rows.length >= limit)) return keepLocal();

    // Hash-only listing (one API call)
    let txHashes: string[];
    try {
      txHashes = await this.client.getAddressTransactionHashes(addr, limit);
    } catch (err) {
      // No backend with address history: what the crawled set holds is the best answer there is.
      if (local && (err instanceof ProviderUnavailableError || err instanceof AllBackendsFailedError)) return keepLocal();
      throw err;
    }

    logger.debug(`indexAddressTransactions: found ${txHashes.length} tx hashes for ${addr}`);

    if (txHashes.length === 0) return [];

    // DB-first dedup + batch fetch
    const batchFetched = await this.ensureTransactionsIndexed(tx, txHashes);

    // For address-transaction mapping we need full provider tx data (inputs/outputs for net amounts).
    // Transactions already in DB were not re-fetched — batch-fetch those separately.
    const allTxData: ProviderTransaction[] = [];
    const missingFromBatch: string[] = [];

    for (const hash of txHashes) {
      const fromBatch = batchFetched.get(hash);
      if (fromBatch) {
        allTxData.push(fromBatch);
      } else {
        missingFromBatch.push(hash);
      }
    }

    if (missingFromBatch.length > 0) {
      const fetched = await this.client.getTransactionsBatch(missingFromBatch);
      for (const hash of missingFromBatch) {
        const providerTx = fetched.get(hash);
        if (providerTx) allTxData.push(providerTx);
      }
    }

    // Create address-transaction mapping entries (no TTL — keyed by (address, tx),
    // immutable per confirmed tx; the entity has no temporal columns)
    const transactionsEntities = mapAddressTransactions(addr, allTxData);

    logger.debug({ count: transactionsEntities.length }, 'indexAddressTransactions: transaction entities');

    if (transactionsEntities.length) {
      await tx.run(UPSERT.into(AddressTransactions).entries(transactionsEntities));
    }

    // Sort by blockTime descending for consistency with GetLatestTransactionsByAddress
    transactionsEntities.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
    return transactionsEntities as AddressTransactions[];
  }

  /** Link an address to a signing request for address-based queries. */
  async indexAddressSigningRequests(tx: CapTransaction, addr: string, signingRequestId: string): Promise<void> {
    logger.debug(`indexAddressSigningRequests: linking address ${addr} to signing request ${signingRequestId}`);

    const addressSigningRequestEntity = mapAddressSigningRequest(addr, signingRequestId);

    await tx.run(UPSERT.into(AddressSigningRequests).entries(addressSigningRequestEntity));

    logger.debug(`indexAddressSigningRequests: linked address ${addr} to signing request ${signingRequestId}`);
  }

  /** Link an address to a transaction build for address-based queries. */
  async indexAddressTransactionBuilds(tx: CapTransaction, addr: string, buildId: string): Promise<void> {
    logger.debug(`indexAddressTransactionBuilds: linking address ${addr} to build ${buildId}`);

    const addressTransactionBuildEntity = mapAddressTransactionBuild(addr, buildId);

    await tx.run(UPSERT.into(AddressTransactionBuilds).entries(addressTransactionBuildEntity));

    logger.debug(`indexAddressTransactionBuilds: linked address ${addr} to build ${buildId}`);
  }

  /** Index the metadata rows of a transaction. */
  async indexTransactionMetadata(tx: CapTransaction, tx_hash: string): Promise<TransactionMetadata[]> {
    // A crawled transaction without metadata rows has no metadata.
    if (await this.crawlAnswers(tx, 'getTransactionMetadata')) {
      const known = await tx.run(SELECT.one.from(Transactions).columns('hash').where({ hash: tx_hash }));
      if (known) return [];
      await this.refuseOutsideCrawl(tx, 'getTransactionMetadata', `Transaction ${tx_hash}`);
    }
    const metadata = await this.client.getTransactionMetadata(tx_hash);
    const rows = mapTransactionMetadata(metadata);
    if (rows.length) {
      await tx.run(UPSERT.into(TransactionMetadata).entries(rows))
    }
    return rows;
  }

  /** Index the network information; circulating supply comes from the crawled UTxO set when it is current. */
  async indexNetworkInformation(tx: CapTransaction): Promise<NetworkInformation> {
    const netEntity = mapNetworkInfo(await this.resolveNetworkInformation(tx), this.client.max_age_ms, this.client.network);

    await tx.run(UPSERT.into(NetworkInformation).entries(netEntity));
    return netEntity;
  }

  /** Network information from the backend; circulating supply from the crawled UTxO set when current. */
  async resolveNetworkInformation(tx: CapTransaction): Promise<ProviderNetworkInformation> {
    const netInfo = await this.client.getNetworkInformation();
    const circulating = (await this.localCoverage(tx))?.ledger
      ? lovelaceSum((await tx.run(SELECT.one.from(LedgerAddresses).columns('sum(totalLovelace) as total')) as { total?: unknown } | undefined)?.total)
      : null;
    return circulating === null ? netInfo : { ...netInfo, supply: { ...netInfo.supply, circulating } };
  }

  /** Index a block by hash, with best-effort epoch enrichment. */
  async indexBlock(tx: CapTransaction, blockHash: string): Promise<Block> {
    await this.refuseOutsideCrawl(tx, 'getBlock', `Block ${blockHash}`);
    const blockInfo = await this.client.getBlock(blockHash);
    let epoch: Epoch | undefined;
    try {
      epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    } catch {
      // Epoch data may not be available (e.g., Koios drops old/in-progress epochs)
    }
    const blockEntity = mapBlock(blockInfo, epoch);
    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  /**
   * Bulk-index a whole block and its transactions in one pass for the crawler: no per-hash
   * re-fetch, one UPSERT per table, all inside the caller's transaction so the block persists
   * atomically. Bare chain-sync inputs are backfilled by resolveInputs() first.
   */
  async indexBlockFull(tx: CapTransaction, blockData: BlockData, txs: ProviderTransaction[]): Promise<void> {
    // Memo updates of a rolled-back attempt must not survive into this one.
    this.pendingCommit = [];
    // Epoch from the prefetched memo; if the caller skipped prefetchCrawlEpoch, resolve now
    // (memoized) and accept the in-tx fetch.
    let epoch: Epoch | undefined;
    if (blockData.epoch != null) {
      await this.prefetchCrawlEpoch(blockData.epoch);
      epoch = this.crawlEpochCache.get(blockData.epoch)?.row;

      const epochRows = [...this.crawlEpochCache.values()]
        .map((entry) => entry.row)
        .filter((row): row is Epoch => row !== undefined && !this.crawlEpochWritten.has(row));
      if (epochRows.length) {
        await tx.run(UPSERT.into(Epoch).entries(epochRows));
        this.pendingCommit.push(() => { for (const row of epochRows) this.crawlEpochWritten.add(row); });
      }
    }
    // Ledger state (crawler.utxoSet): only blocks AFTER the anchor the imported set describes.
    // Decided up front so input resolution and the ledger apply share one read of the set.
    const ledgerDue = this.crawlUtxoSet && this.utxoAnchor != null && (blockData.slot ?? 0) > this.utxoAnchor.slot;
    const priorInvalidation = ledgerDue ? this.ledgerInvalidation : null;
    let anchorVerified = false;
    if (ledgerDue && !priorInvalidation) {
      anchorVerified = this.utxoAnchorVerified;
      if (!anchorVerified) {
        const anchor = this.utxoAnchor!;
        anchorVerified = await this.verifyUtxoAnchor(tx, anchor);
        // Remembered only once this transaction commits, like the other crawl memos.
        if (anchorVerified) this.pendingCommit.push(() => { if (this.utxoAnchor === anchor) this.utxoAnchorVerified = true; });
      }
    }
    const ledgerLookup: LedgerLookup | undefined = anchorVerified
      ? { hashes: new Set(), rows: new Map(), assets: new Map() }
      : undefined;

    // Backfill chain-sync inputs (empty address/amount) from local outputs, then settle
    // the fee of any phase-2 failure. Both run before the block row is written, because a
    // corrected fee changes the block's fee total.
    await this.resolveInputs(tx, txs, ledgerLookup);
    this.applyCollateralFees(blockData, txs);

    await tx.run(UPSERT.into(Block).entries(mapBlock(blockData, epoch)));
    await this.removeSupersededBlocks(tx, blockData);
    await this.removeStaleTxSeqs(tx, txs);

    // One bulk UPSERT per table. NUL safety for PostgreSQL is enforced by the db-level hook in
    // srv/utils/db-sanitize.ts, not per call site.
    const txRows = txs.map(t => mapTransaction(t));
    const inputRows = txs.flatMap(t => mapTransactionInputs(txSeqOf(t.slot, t.index), t.inputs ?? []));
    const inputAssetRows = txs.flatMap(t => mapTransactionInputAssets(txSeqOf(t.slot, t.index), t.inputs ?? []));
    const outputRows = txs.flatMap(t => mapTransactionOutputs(txSeqOf(t.slot, t.index), t.outputs ?? []));
    const outputAssetRows = txs.flatMap(t => mapTransactionOutputAssets(txSeqOf(t.slot, t.index), t.outputs ?? []));
    const metadataRows = txs.flatMap(t => mapTransactionMetadata(t.metadata ?? []));
    // Certificates + withdrawals are keyed (tx, certIndex, kind) / (tx, stakeAddress), so a
    // re-crawl is idempotent and a reorg removes them with their tx.
    const certificateRows = this.crawlCertificates
      ? txs.flatMap(t => mapTransactionCertificates(t.hash, t.certificates ?? []))
      : [];
    const withdrawalRows = this.crawlCertificates
      ? txs.flatMap(t => mapTransactionWithdrawals(t.hash, t.withdrawals ?? []))
      : [];
    if (this.crawlCertificates) this.warnIfCertificatesUnreported(txs);
    // Redeemers come with the block on chain-sync; keyed (tx, purpose, index) like the certificates.
    const redeemerRows = txs.flatMap(t => mapTransactionRedeemers(t.hash, t.redeemers ?? []));
    // Mint/burn is derived from rows already in hand — keyed (unit, txHash), so a re-crawl is
    // idempotent and a reorg removes these rows with their transactions (crawler handleReorg).
    const assetHistoryRows = this.crawlAssetHistory ? this.buildAssetHistoryRows(blockData, txs) : [];

    if (txRows.length) await tx.run(UPSERT.into(Transactions).entries(txRows));
    if (inputRows.length) await tx.run(UPSERT.into(TransactionInputs).entries(inputRows));
    if (inputAssetRows.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows));
    if (outputRows.length) await tx.run(UPSERT.into(TransactionOutputs).entries(outputRows));
    if (outputAssetRows.length) await tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows));
    if (metadataRows.length) await tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows));
    if (certificateRows.length) await tx.run(UPSERT.into(TransactionCertificates).entries(certificateRows));
    if (withdrawalRows.length) await tx.run(UPSERT.into(TransactionWithdrawals).entries(withdrawalRows));
    if (redeemerRows.length) await tx.run(UPSERT.into(TransactionRedeemers).entries(redeemerRows));
    // Same transaction, so the UTxO set can never be a block ahead of or behind the cursor.
    if (ledgerDue) {
      if (priorInvalidation) {
        // Decided in an earlier attempt of this block whose transaction rolled back: re-write
        // the verdict so whichever attempt commits carries it; nothing is applied meanwhile.
        await setUtxoSetState(tx, { status: 'invalid', error: priorInvalidation.slice(0, 500) });
      } else if (ledgerLookup) {
        const ledger = await applyBlockToLedger(tx, blockData, txs, ledgerLookup);
        if (ledger.missing) {
          logger.warn(
            `ledger: block ${blockData.hash} consumed ${ledger.missing} outpoint(s) with no open row — ` +
            'the set is incomplete relative to the crawl (snapshot gap?); balances of those addresses drift'
          );
        }
      }
    }
    if (assetHistoryRows.length) await tx.run(UPSERT.into(AssetHistory).entries(assetHistoryRows));

    // Catalogue last; collecting the units is skipped entirely when the catalogue is off.
    const newAssets = this.crawlAssetCatalogue === 'off'
      ? 0
      : await this.ensureAssetRows(tx, this.collectBlockUnits(txs, assetHistoryRows));

    logger.debug(
      `indexBlockFull: block ${blockData.hash} — ${txs.length} txs, ${outputRows.length} outputs, ` +
      `${assetHistoryRows.length} mint/burn, ${newAssets} new assets`
    );
  }

  /**
   * Drop other Block rows at the crawled block's height that no transaction references: lazily
   * indexed tips that were rolled back, which no crawler reorg covers.
   */
  private async removeSupersededBlocks(tx: CapTransaction, blockData: BlockData): Promise<void> {
    if (blockData.height == null) return;
    const others = await tx.run(
      SELECT.from(Blocks).columns('hash').where({ height: blockData.height, hash: { '!=': blockData.hash } })
    ) as Array<{ hash: string }>;
    if (!others?.length) return;
    const hashes = others.map(r => r.hash);
    const referenced = await tx.run(
      SELECT.distinct.from(Transactions).columns('blockHash').where({ blockHash: { in: hashes } })
    ) as Array<{ blockHash: string }>;
    const keep = new Set((referenced ?? []).map(r => r.blockHash));
    const stale = hashes.filter(h => !keep.has(h));
    if (!stale.length) return;
    await tx.run(DELETE.from(Blocks).where({ hash: { in: stale } }));
    logger.info(`indexBlockFull: removed ${stale.length} superseded block row(s) at height ${blockData.height}`);
  }

  /**
   * Drop transactions of another fork that hold one of this block's txSeq keys (a lazily indexed
   * tx from a rolled-back block at the same slot); their input/output rows would mix with ours.
   */
  private async removeStaleTxSeqs(tx: CapTransaction, txs: ProviderTransaction[]): Promise<void> {
    if (!txs.length) return;
    const seqs = txs.map(t => txSeqOf(t.slot, t.index));
    const rows = await tx.run(
      SELECT.from(Transactions).columns('hash', 'txSeq')
        .where({ txSeq: { between: Math.min(...seqs), and: Math.max(...seqs) } })
    ) as TxKey[];
    const ours = new Set(txs.map(t => t.hash));
    const stale = (rows ?? []).filter(r => !ours.has(r.hash));
    if (!stale.length) return;
    await deleteTransactionRows(tx, stale);
    logger.info(`indexBlockFull: removed ${stale.length} transaction(s) of another fork at slot ${txs[0].slot}`);
  }

  /**
   * Warn once when `crawler.certificates` is on but the source reports none (`certificates`
   * undefined, as with Blockfrost). `[]` means "none" and is not a warning.
   */
  private warnIfCertificatesUnreported(txs: ProviderTransaction[]): void {
    if (this.certificatesUnreportedWarned || !txs.length) return;
    if (txs.some(t => t.certificates !== undefined)) return;
    this.certificatesUnreportedWarned = true;
    logger.warn(
      'crawler.certificates is enabled but the active source reports no certificates/withdrawals ' +
      '(Blockfrost pagination) — TransactionCertificates/TransactionWithdrawals stay empty until ' +
      'the crawl runs on Ogmios chain-sync or Koios'
    );
  }

  /**
   * Backfill address, amount and datum/script fields of bare chain-sync inputs: from this block's
   * own outputs first, then the UTxO set, then earlier-indexed outputs from the DB. Inputs that
   * already carry an address are skipped.
   */
  async resolveInputs(tx: CapTransaction, txs: ProviderTransaction[], ledger?: LedgerLookup): Promise<void> {
    // 1. In-memory index of this block's outputs (txHash#outputIndex -> output)
    const blockOutputs = new Map<string, TxOutputLine>();
    for (const t of txs) {
      for (const o of t.outputs ?? []) blockOutputs.set(`${t.hash}#${o.outputIndex}`, o);
    }

    // 2. Collect inputs still needing resolution after the same-block pass
    const unresolved: { input: TxInputLine; key: string }[] = [];
    for (const t of txs) {
      for (const input of t.inputs ?? []) {
        if (input.address) continue; // already resolved by the backend (Blockfrost/Koios)
        const key = `${input.txHash}#${input.outputIndex}`;
        const local = blockOutputs.get(key);
        if (local) {
          input.address = local.address;
          input.amount = local.amount ?? [];
          copyUtxoData(input, local.dataHash, local.inlineDatum, local.referenceScriptHash);
        } else {
          unresolved.push({ input, key });
        }
      }
    }
    if (!unresolved.length) return;

    // 3. With the ledger due for this block, its UTxO rows answer first; the ledger apply
    //    reuses the same lookup instead of reading these outpoints a second time.
    if (ledger) {
      await readLedgerOutputs(tx, unresolved.map(u => u.input.txHash), ledger);
      for (let i = unresolved.length - 1; i >= 0; i--) {
        const row = ledger.rows.get(unresolved[i].key);
        if (!row) continue;
        unresolved[i].input.address = row.address;
        unresolved[i].input.amount = ledgerRowAmount(row, ledger.assets.get(unresolved[i].key));
        copyUtxoData(unresolved[i].input, row.utxo_dataHash, row.utxo_inlineDatum, row.utxo_referenceScriptHash);
        unresolved.splice(i, 1);
      }
      if (!unresolved.length) return;
    }

    // 4. Batch-read prior-block outputs from the DB, chunked so a dense block's input set
    //    never exceeds a driver's bind-variable cap
    const sourceHashes = [...new Set(unresolved.map(u => u.input.txHash))];
    const hashBySeq = new Map<string, string>();
    for (const k of await readTxKeys(tx, sourceHashes)) {
      if (k.txSeq != null) hashBySeq.set(seqKey(k.txSeq), k.hash);
    }
    const outByKey = new Map<string, StoredOutputRow>();
    const amtByKey = new Map<string, Amount[]>();
    for (const seqChunk of chunk([...hashBySeq.keys()].map(Number), IN_CHUNK)) {
      const [outRows, assetRows] = await Promise.all([
        tx.run(SELECT.from(TransactionOutputs).where({ txSeq: { in: seqChunk } })),
        tx.run(SELECT.from(TransactionOutputAssets).where({ output_txSeq: { in: seqChunk } })),
      ]);
      for (const r of outRows as StoredOutputRow[]) {
        outByKey.set(`${hashBySeq.get(seqKey(r.txSeq))}#${r.outputIndex}`, r);
      }
      for (const r of assetRows as Array<{ output_txSeq: number | string; output_outputIndex: number; unit: string; asset_quantity: unknown }>) {
        const k = `${hashBySeq.get(seqKey(r.output_txSeq))}#${r.output_outputIndex}`;
        const list = amtByKey.get(k) ?? [];
        list.push({ unit: r.unit, quantity: String(r.asset_quantity) });
        amtByKey.set(k, list);
      }
    }

    for (const { input, key } of unresolved) {
      const out = outByKey.get(key);
      if (out?.address_address != null) input.address = out.address_address;
      if (out) copyUtxoData(input, out.utxo_dataHash, out.utxo_inlineDatum, out.utxo_referenceScriptHash);
      const amt = amtByKey.get(key);
      if (amt) input.amount = amt;
    }
  }

  /**
   * Settle the fee of phase-2-invalid transactions (collateral inputs minus collateral return)
   * and the block total. The declared fee is kept when the mapper already set it via
   * `total_collateral` or a collateral input is not indexed locally (the sum would be short).
   */
  private applyCollateralFees(blockData: BlockData, txs: ProviderTransaction[]): void {
    const lovelaceOf = (amount: Amount[] | undefined): bigint =>
      BigInt(amount?.find(a => a.unit === 'lovelace')?.quantity ?? '0');

    let corrected = false;
    for (const t of txs) {
      // totalCollateral set = the mapper already put the charged amount in `fee`
      if (!t.spendsCollaterals || t.totalCollateral != null) continue;

      const collateral = (t.inputs ?? []).filter(i => i.isCollateral);
      if (!collateral.length) continue; // nothing to derive from — leave the declared fee

      const unresolved = collateral.find(i => !i.address);
      if (unresolved) {
        logger.warn(
          `collateral fee for ${t.hash}: input ${unresolved.txHash}#${unresolved.outputIndex} is not indexed ` +
          `— keeping the declared fee ${t.fee}, which understates what the ledger charged`
        );
        continue;
      }

      const consumed = collateral.reduce((sum, i) => sum + lovelaceOf(i.amount), 0n);
      const returned = (t.outputs ?? [])
        .filter(o => o.isCollateral)
        .reduce((sum, o) => sum + lovelaceOf(o.amount), 0n);
      const charged = consumed - returned;
      if (charged < 0n) {
        logger.warn(
          `collateral fee for ${t.hash}: return ${returned} exceeds collateral ${consumed} ` +
          `— keeping the declared fee ${t.fee}`
        );
        continue;
      }

      t.fee = charged.toString();
      corrected = true;
    }

    if (corrected) {
      blockData.fees = txs.reduce((sum, t) => sum + BigInt(t.fee || 0), 0n).toString();
    }
  }

  /**
   * Mint/burn rows for a block from data in hand: the ledger's mint field when the source
   * reports it (Ogmios, Koios), else Σ outputs − Σ inputs per unit, excluding reference and
   * collateral inputs. A tx with an unresolvable consumed input is skipped and logged.
   */
  private buildAssetHistoryRows(blockData: BlockData, txs: ProviderTransaction[]): AssetHistory[] {
    const entries: AssetHistoryEntryProviderData[] = [];
    let skipped = 0;

    for (const t of txs) {
      let net: Map<string, bigint>;

      if (t.mint) {
        // A phase-2 failure never reaches here with a mint: the Ogmios mapper reports none.
        net = new Map();
        for (const m of t.mint) {
          if (m.unit === 'lovelace') continue;
          net.set(m.unit, (net.get(m.unit) ?? 0n) + BigInt(m.quantity));
        }
      } else {
        if (t.spendsCollaterals) continue; // no mint is applied when the script phase failed

        const consumed = (t.inputs ?? []).filter(i => !i.isReference && !i.isCollateral);
        const unresolved = consumed.find(i => !i.address);
        if (unresolved) {
          logger.warn(
            `mint delta for ${t.hash}: input ${unresolved.txHash}#${unresolved.outputIndex} is not indexed ` +
            `— skipping, mint/burn of this transaction is not recorded`
          );
          skipped++;
          continue;
        }

        net = new Map();
        const add = (amount: Amount[] | undefined, sign: bigint): void => {
          for (const a of amount ?? []) {
            if (a.unit === 'lovelace') continue;
            net.set(a.unit, (net.get(a.unit) ?? 0n) + sign * BigInt(a.quantity));
          }
        };
        for (const o of (t.outputs ?? []).filter(o => !o.isCollateral)) add(o.amount, 1n);
        for (const i of consumed) add(i.amount, -1n);
      }

      for (const [unit, quantity] of net) {
        if (quantity === 0n) continue;
        entries.push({
          unit,
          txHash: t.hash,
          action: quantity > 0n ? 'mint' : 'burn',
          quantity: (quantity < 0n ? -quantity : quantity).toString(),
          blockTime: blockData.time ?? null,
          blockHeight: blockData.height ?? null,
        });
      }
    }

    if (skipped) {
      logger.warn(`block ${blockData.hash}: mint/burn not recorded for ${skipped} transaction(s) with unresolved inputs`);
    }
    return mapAssetHistory(entries) as AssetHistory[];
  }

  /**
   * Keep the `Assets` catalogue complete for every unit the crawl meets, without provider calls.
   * `Assets` is temporal, key `(validFrom, unit)`: the bare row's fixed epoch-zero stamp never
   * aliases an enriched slice, so the UPSERT is safe inside the block transaction. The existence
   * check uses the DB-level entity: the service projection's temporal filter hides such rows.
   */
  private async ensureAssetRows(tx: CapTransaction, units: Set<string>): Promise<number> {
    if (this.crawlAssetCatalogue === 'off' || !units.size) return 0;

    const unknown = [...units].filter(u => !this.assetMemo.has(u));
    if (!unknown.length) return 0;

    const missing: string[] = [];
    for (const unitChunk of chunk(unknown, IN_CHUNK)) {
      const rows = await tx.run(
        SELECT.from(AssetsTable).columns('unit').where({ unit: { in: unitChunk } })
      ) as Array<{ unit: string }>;
      const known = new Set(rows.map(r => r.unit));
      for (const unit of unitChunk) {
        if (known.has(unit)) this.noteAssetSeen(unit);
        else missing.push(unit);
      }
    }
    if (!missing.length) return 0;

    const rows = missing.map(mapBareAsset).filter((r): r is NonNullable<typeof r> => r !== null);
    // Chunked like the lookup: a mint-storm block can carry thousands of fresh units.
    for (const rowChunk of chunk(rows, IN_CHUNK)) {
      await tx.run(UPSERT.into(AssetsTable).entries(rowChunk));
    }
    // Memoize also the units mapBareAsset rejected, so they cost no SELECT per block. Only after
    // the commit: a rolled-back block must write its bare rows again.
    this.pendingCommit.push(() => { for (const unit of missing) this.noteAssetSeen(unit); });

    if (this.crawlAssetCatalogue === 'enrich' && rows.length) {
      for (const row of rows) {
        if (this.enrichQueue.length >= CardanoIndexer.ENRICH_QUEUE_CAP) this.enrichQueue.shift();
        this.enrichQueue.push(row.unit!);
      }
      this.startAssetEnrichment();
    }
    return rows.length;
  }

  /**
   * Remember a unit as present in the catalogue. Insertion-ordered eviction keeps a long
   * backfill's memory flat; losing an entry costs one SELECT, never a wrong write.
   */
  private noteAssetSeen(unit: string): void {
    if (this.assetMemo.has(unit)) return;
    if (this.assetMemo.size >= CardanoIndexer.ASSET_MEMO_CAP) {
      const oldest = this.assetMemo.values().next();
      if (!oldest.done) this.assetMemo.delete(oldest.value);
    }
    this.assetMemo.add(unit);
  }

  /**
   * Snapshot every pool and DRep for an epoch in its OWN transaction (after the block commit), plus
   * one EpochLedgerSnapshots row that marks the epoch as observed. With a block hash and an Ogmios
   * backend the node's ledger state AT that block is read; otherwise Koios reports current state
   * (and the live `Pools` / `Dreps` rows are refreshed). Neither available: no-op.
   * @returns counts written and the source used (null = skipped)
   */
  async snapshotEpoch(
    epoch: number,
    at: { slot: number; time: number; hash?: string | null },
  ): Promise<{ pools: number; dreps: number; source: 'ogmios' | 'koios' | null }> {
    const epochState = at.hash ? this.client.getEpochStateBackend() : null;
    if (epochState && at.hash) return this.snapshotEpochFromLedger(epochState, epoch, { ...at, hash: at.hash });

    const backend = this.client.getEnumeratingBackend();
    if (!backend) {
      logger.warn(`epoch ${epoch} snapshot skipped: no backend can read pools/DReps (Ogmios or Koios required)`);
      return { pools: 0, dreps: 0, source: null };
    }

    // Network first, DB second — the provider round-trips must not run with a write lock held.
    const [poolData, drepData] = await Promise.all([
      backend.getPoolIds().then(ids => backend.getPools(ids)),
      backend.getDrepIds().then(ids => backend.getDreps(ids)),
    ]);

    const poolSnapshots = poolData.map(p => mapPoolSnapshot(p, epoch, at));
    const drepSnapshots = drepData.map(d => mapDrepSnapshot(d, epoch, at));
    const poolRows = poolData.map(p => mapPool(p, this.client.max_age_ms));
    const drepRows = drepData.map(d => mapDrep(d, this.client.max_age_ms));
    const ledgerRow = {
      epoch, snapshotSlot: at.slot, snapshotTime: at.time, snapshotHash: null, source: 'koios',
      liveStake: poolData.reduce((sum, p) => sum + BigInt(p.liveStake || '0'), 0n).toString(),
      poolCount: poolData.length, drepCount: drepData.length,
    };

    await cds.tx(async (tx) => {
      // Chunked so a mainnet-sized set cannot exceed a driver's bind-variable cap.
      for (const rows of chunk(poolSnapshots, IN_CHUNK)) await tx.run(UPSERT.into(PoolEpochSnapshots).entries(rows));
      for (const rows of chunk(drepSnapshots, IN_CHUNK)) await tx.run(UPSERT.into(DrepEpochSnapshots).entries(rows));
      for (const rows of chunk(poolRows, IN_CHUNK)) await tx.run(UPSERT.into(Pools).entries(rows));
      for (const rows of chunk(drepRows, IN_CHUNK)) await tx.run(UPSERT.into(Dreps).entries(rows));
      await tx.run(UPSERT.into(EpochLedgerSnapshots).entries(ledgerRow));
    });

    logger.info(`epoch ${epoch} snapshot (koios): ${poolSnapshots.length} pools, ${drepSnapshots.length} DReps`);
    return { pools: poolSnapshots.length, dreps: drepSnapshots.length, source: 'koios' };
  }

  /**
   * Epoch snapshot from the node's ledger state at block `at`. The live `Pools` / `Dreps` rows are
   * NOT refreshed: the acquired state may be hours old. `blocksMinted` counts crawled blocks up to
   * `at`, only when the crawl covers the chain since Shelley.
   */
  private async snapshotEpochFromLedger(
    backend: EpochStateBackend,
    epoch: number,
    at: { slot: number; time: number; hash: string },
  ): Promise<{ pools: number; dreps: number; source: 'ogmios' }> {
    const state = await backend.epochStateAt({ slot: at.slot, hash: at.hash });
    if (state.epoch !== epoch) {
      logger.warn(`epoch snapshot: ledger at slot ${at.slot} reports epoch ${state.epoch}, crawler dated it ${epoch} — stored as ${epoch}`);
    }
    const minted = await this.crawledBlocksByPool(at.slot);
    const previous = await this.previousLiveStake(epoch);
    const activeTotal = previous ? [...previous.values()].reduce((a, b) => a + b, 0n) : 0n;
    const origin = { source: 'ogmios' as const, hash: at.hash };
    const poolSnapshots = state.pools.map(p => {
      const active = previous?.get(p.poolId);
      return {
        ...mapPoolSnapshot(p, epoch, at, origin),
        blocksMinted: minted ? (minted.get(p.poolId) ?? 0) : null,
        activeStake: active == null ? null : active.toString(),
        activeSize: active == null || activeTotal === 0n ? null : Number((active * 1_000_000n) / activeTotal) / 1_000_000,
      };
    });
    const drepSnapshots = state.dreps.map(d => mapDrepSnapshot(d, epoch, at, origin));
    const reserves = state.reserves == null ? null : BigInt(state.reserves);
    const ledgerRow = {
      epoch, snapshotSlot: at.slot, snapshotTime: at.time, snapshotHash: at.hash, source: 'ogmios',
      treasury: state.treasury,
      reserves: state.reserves,
      totalSupply: reserves == null ? null : (BigInt(CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY) - reserves).toString(),
      liveStake: state.pools.reduce((sum, p) => sum + BigInt(p.liveStake || '0'), 0n).toString(),
      activeStake: previous ? activeTotal.toString() : null,
      poolCount: state.pools.length,
      drepCount: state.dreps.length,
      drepAbstainStake: state.drepAbstainStake,
      drepNoConfidenceStake: state.drepNoConfidenceStake,
    };

    await cds.tx(async (tx) => {
      for (const rows of chunk(poolSnapshots, IN_CHUNK)) await tx.run(UPSERT.into(PoolEpochSnapshots).entries(rows));
      for (const rows of chunk(drepSnapshots, IN_CHUNK)) await tx.run(UPSERT.into(DrepEpochSnapshots).entries(rows));
      await tx.run(UPSERT.into(EpochLedgerSnapshots).entries(ledgerRow));
    });

    logger.info(`epoch ${epoch} snapshot (ogmios @ slot ${at.slot}): ${poolSnapshots.length} pools, ${drepSnapshots.length} DReps`);
    return { pools: poolSnapshots.length, dreps: drepSnapshots.length, source: 'ogmios' };
  }

  /**
   * Active stake of epoch E = the stake distribution taken at the E-1 boundary, which is the live
   * stake the Ogmios snapshot of E-1 recorded at its first block. null without that snapshot.
   */
  private async previousLiveStake(epoch: number): Promise<Map<string, bigint> | null> {
    const rows = await (cds.db as unknown as CapTransaction).run(
      SELECT.from(PoolEpochSnapshots).columns('poolId', 'liveStake').where({ epoch: epoch - 1, source: 'ogmios' })
    ) as Array<{ poolId: string; liveStake: unknown }>;
    if (!rows?.length) return null;
    return new Map(rows.map(r => [r.poolId, BigInt(lovelaceSum(r.liveStake))]));
  }

  /** Crawled blocks per pool up to `slot`; null unless the crawl started at or before Shelley. */
  private async crawledBlocksByPool(slot: number): Promise<Map<string, number> | null> {
    const db = cds.db as unknown as CapTransaction;
    const cursor = await readCursor(db);
    const shelley = EPOCH_CONFIG_BY_NETWORK[this.client.network].shelleyStartSlot;
    if (cursor?.startSlot == null || cursor.startSlot > shelley) return null;
    const rows = await db.run(
      SELECT.from(Blocks).columns('slotLeader', 'count(*) as n').where({ slot: { '<=': slot } }).groupBy('slotLeader')
    ) as Array<{ slotLeader: string | null; n: number | string }>;
    const out = new Map<string, number>();
    for (const r of rows ?? []) if (r.slotLeader) out.set(r.slotLeader, Number(r.n));
    return out;
  }

  /** Every native-asset unit a block touches: outputs, consumed inputs and mint/burn rows. */
  private collectBlockUnits(txs: ProviderTransaction[], assetHistoryRows: AssetHistory[]): Set<string> {
    const units = new Set<string>();
    for (const t of txs) {
      for (const o of t.outputs ?? []) {
        for (const a of o.amount ?? []) if (a.unit !== 'lovelace') units.add(a.unit);
      }
      for (const i of t.inputs ?? []) {
        for (const a of i.amount ?? []) if (a.unit !== 'lovelace') units.add(a.unit);
      }
    }
    for (const row of assetHistoryRows) if (row.unit) units.add(row.unit);
    return units;
  }

  /** Index an epoch by number. */
  async indexEpoch(tx: CapTransaction, epochNumber: number): Promise<Epoch> {
    const epochInfo = await this.client.getEpoch(epochNumber);
    const epochEntity = mapEpoch(epochInfo);

    await tx.run(UPSERT.into(Epoch).entries([epochEntity]))
    return epochEntity;
  }

  /** Index an account by stake address, plus its addresses when it has any. */
  async indexAccount(tx: CapTransaction, stakeAddress: string): Promise<Account> {
    const accountInfo = await this.resolveAccount(tx, stakeAddress);
    const accountEntity = mapAccount(accountInfo, this.client.max_age_ms);

    await tx.run(UPSERT.into(Accounts).entries(accountEntity))

    if (accountEntity.hasAddresses) {
      await this._ensureAddresses(tx, accountInfo.addresses);
    }

    return accountEntity;
  }

  /** Account from the backend with the crawled overlays (controlled amount, withdrawals). */
  async resolveAccount(tx: CapTransaction, stakeAddress: string): Promise<AccountData> {
    const accountInfo = { ...(await this.client.getAccount(stakeAddress)) };
    // controlled amount = UTxOs under the stake key (crawled set, when current) + reward balance;
    // the addresses come from the set too (the node has no stake-key -> address index)
    if ((await this.localCoverage(tx))?.ledger) {
      const ledger = await tx.run(
        SELECT.one.from(LedgerAccounts).columns('controlledAmount').where({ stakeAddress })
      ) as { controlledAmount?: unknown } | undefined;
      accountInfo.controlledAmount = (BigInt(lovelaceSum(ledger?.controlledAmount)) + BigInt(accountInfo.withdrawableAmount || '0')).toString();
      accountInfo.addresses = await this.localAccountAddresses(tx, stakeAddress);
    }
    if (accountInfo.withdrawalsSum === '0') {
      const local = await this.localWithdrawalsSum(tx, stakeAddress);
      if (local != null) accountInfo.withdrawalsSum = local;
    }
    return accountInfo;
  }

  /** Index a DRep by bech32 id. */
  async indexDrep(tx: CapTransaction, drepId: string): Promise<Drep> {
    const drepInfo = await this.client.getDrep(drepId);
    const drepEntity = mapDrep(drepInfo, this.client.max_age_ms);
    await tx.run(UPSERT.into(Dreps).entries(drepEntity));
    return drepEntity;
  }

  /** Index a pool by id. */
  async indexPool(tx: CapTransaction, poolId: string): Promise<Pool> {
    const poolEntity = mapPool(await this.resolvePool(tx, poolId), this.client.max_age_ms);

    await tx.run(UPSERT.into(Pools).entries(poolEntity))

    return poolEntity;
  }

  /** Pool from the backend with crawled block counts and the snapshot's active stake. */
  async resolvePool(tx: CapTransaction, poolId: string): Promise<PoolData> {
    const poolInfo = { ...(await this.client.getPool(poolId)), ...(await this.localPoolBlocks(tx, poolId)) };
    // The node's live pool view has no active stake; the epoch snapshot of the current epoch does.
    if (poolInfo.activeStake === '0') Object.assign(poolInfo, await this.snapshotActiveStake(tx, poolId));
    return poolInfo;
  }

  /** Index an asset by unit (policyId + assetNameHex). */
  async indexAsset(tx: CapTransaction, unit: string): Promise<Asset> {
    const assetInfo = await this.resolveAssetInfo(tx, unit);
    const assetEntity = mapAsset(assetInfo, this.client.max_age_ms);

    await tx.run(UPSERT.into(Assets).entries(assetEntity));

    return assetEntity;
  }

  /**
   * Index mint/burn history for an asset, always fresh. Rows are keyed (unit, txHash), so a
   * refetch refreshes the recent cap and older cached entries persist.
   */
  async indexAssetHistory(tx: CapTransaction, unit: string, limit: number = 100): Promise<AssetHistory[]> {
    if (this.crawlAssetHistory && await this.crawlAnswers(tx, 'getAssetHistory')) {
      return await tx.run(
        SELECT.from(AssetHistory).where({ unit }).orderBy('blockHeight desc').limit(limit)
      ) as AssetHistory[];
    }
    const events = await this.client.getAssetHistory(unit, limit);
    if (events.length === 0) return [];

    const rows = mapAssetHistory(events);
    await tx.run(UPSERT.into(AssetHistory).entries(rows));
    return rows as AssetHistory[];
  }

  /** Build a transaction and persist the build result with inputs/outputs/address association. */
  private async _indexBuildResult<R extends Pick<TxBuildRequest, 'senderAddress' | 'changeAddress'>>(
    tx: CapTransaction,
    buildreq: R,
    buildFn: (req: R, params: LedgerProtocolParameter) => Promise<TxBuildResult>
  ): Promise<TransactionBuild> {
    const protocolParams = await this.indexProtocolParameters(tx);
    const txbuildResult = await buildFn(buildreq, protocolParams);
    const buildResult = mapBuildResult(txbuildResult, this.client.max_age_ms);

    await tx.run(UPSERT.into(TransactionBuild).entries(buildResult));

    if (buildResult.id && txbuildResult.inputs && txbuildResult.inputs.length > 0) {
      const inputRows = mapBuildInputs(buildResult.id, txbuildResult.inputs);
      await tx.run(UPSERT.into(TransactionBuildInputs).entries(inputRows));
    }

    if (buildResult.id && txbuildResult.outputs && txbuildResult.outputs.length > 0) {
      const outputRows = mapBuildOutputs(buildResult.id, txbuildResult.outputs, buildreq.changeAddress || buildreq.senderAddress);
      await tx.run(UPSERT.into(TransactionBuildOutputs).entries(outputRows));
    }

    if (buildResult.id && txbuildResult.redeemers && txbuildResult.redeemers.length > 0) {
      const buildId = buildResult.id;
      await tx.run(UPSERT.into(TransactionBuildRedeemers).entries(
        txbuildResult.redeemers.map(r => ({ build_id: buildId, tag: r.tag, redeemerIndex: r.index, mem: Number(r.mem), steps: Number(r.steps) }))
      ));
    }

    if (buildResult.id && buildreq.senderAddress) {
      await this.indexAddressTransactionBuilds(tx, buildreq.senderAddress, buildResult.id);
    }

    return buildResult;
  }

  async indexSimpleBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildSimpleAdaTransaction(req, params));
  }

  async indexMetadataBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildTransactionWithMetadata(req, params));
  }

  async indexMultiAssetBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildMultiAssetTransaction(req, params));
  }

  async indexMintBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildMintTransaction(req, params));
  }

  async indexPlutusSpendBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildPlutusSpendTransaction(req, params));
  }

  /** BuildPlutusTransaction: several script inputs; the redeemers are stored with the build. */
  async indexPlutusBuildResult(tx: CapTransaction, buildreq: TxBuildPlutusRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildPlutusTransaction(req, params));
  }

  /** Protocol parameters, served from the DB row within a 5-minute TTL. */
  async indexProtocolParameters(tx: CapTransaction): Promise<LedgerProtocolParameter> {
    const network = this.client.network;
    const now = Date.now();

    const PROTOCOL_PARAMS_TTL_MS = 5 * 60 * 1000; // matches the client cache TTL
    if (now - this.lastParamsFetchTime < PROTOCOL_PARAMS_TTL_MS) {
      // (network, epoch) is the key; order by epoch desc to get the latest row
      const existing = await tx.run(
        SELECT.one.from(LedgerProtocolParameter).where({ network }).orderBy('epoch desc')
      );
      if (existing) return existing;
    }

    const protocolParamsInfo = await this.client.getProtocolParameters();
    const protocolParams = mapProtocolParameters(protocolParamsInfo);
    await tx.run(UPSERT.into(LedgerProtocolParameter).entries(protocolParams));
    this.lastParamsFetchTime = now;

    return protocolParams;
  }

  /** Persist a transaction submission and flag the build as submitted when linked. */
  async persistTransactionSubmission(
    tx: CapTransaction,
    params: {
      signedTxCbor: string;
      txHash: string;
      buildId?: string | null;
    }
  ): Promise<TransactionSubmission> {
    const { signedTxCbor, txHash, buildId } = params;

    const indexSubmission = mapTransactionSubmission(signedTxCbor, txHash);

    // status 'pending' until the second phase of the submit flow confirms
    const submissionRecord = {
      ...indexSubmission,
      build_id: buildId || null,
      backendResponse: 'Submitted successfully',
      status: 'pending' as const,
    };

    await tx.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
    logger.debug({ submissionId: submissionRecord.id, txHash }, 'Persisted submission record');

    if (buildId) {
      await tx.run(
        UPDATE.entity(TransactionBuilds)
          .set({ wasSubmitted: true })
          .where({ id: buildId })
      );
      logger.debug({ buildId }, 'Updated build wasSubmitted flag');
    }

    return submissionRecord;
  }

  /** Update a submission's status (two-phase submit: pending → submitted or failed). */
  async updateSubmissionStatus(
    tx: CapTransaction,
    submissionId: string,
    status: string,
    errorMessage?: string
  ): Promise<void> {
    const updateData: Record<string, any> = { status };
    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }
    await tx.run(
      UPDATE.entity(TransactionSubmissions)
        .set(updateData)
        .where({ id: submissionId })
    );
    logger.debug({ submissionId, status }, 'Updated submission status');
  }

  /** Persist a new signing request and link it to the build's sender address. */
  async persistSigningRequest(
    tx: CapTransaction,
    params: {
      buildId: string;
      signingPayload: {
        signingRequestId: string;
        txBodyHash: string;
        unsignedTxCbor: string;
        network: string;
        createdAt: string;
        expiresAt: string;
        signingInstructions: {
          cardanoCliCommand?: string;
          cip30SigningRequest?: { txCbor: string };
        };
      };
    }
  ) {
    const { buildId, signingPayload } = params;

    const signingRequestRecord = {
      id: signingPayload.signingRequestId,
      build_id: buildId,
      txBodyHash: signingPayload.txBodyHash,
      unsignedTxCbor: signingPayload.unsignedTxCbor,
      network: signingPayload.network,
      status: 'pending' as const,
      createdAt: signingPayload.createdAt,
      expiresAt: signingPayload.expiresAt,
      cardanoCliCommand: signingPayload.signingInstructions.cardanoCliCommand,
      cip30TxCbor: signingPayload.signingInstructions.cip30SigningRequest?.txCbor,
    };

    await tx.run(INSERT.into(SigningRequests).entries(signingRequestRecord));
    logger.debug({ signingRequestId: signingRequestRecord.id, buildId }, 'Persisted signing request');

    const build = await tx.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
    if (build?.senderAddress) {
      await this.indexAddressSigningRequests(tx, build.senderAddress, signingRequestRecord.id);
    }

    return signingRequestRecord;
  }

  /** Persist a signature verification and update the signing request status. */
  async persistSignatureVerification(
    tx: CapTransaction,
    params: {
      signingRequestId: string;
      signedTxCbor: string;
      verificationResult: {
        isValid: boolean;
        txBodyHash: string;
        witnessCount: number;
        signerKeyHashes: string[];
        errorMessage?: string | null;
        warnings: string[];
      };
      signerType?: string;
      signerInfo?: string;
    }
  ) {
    const { signingRequestId, signedTxCbor, verificationResult, signerType, signerInfo } = params;

    const verificationRecord = {
      id: cds.utils.uuid(),
      signingRequest_id: signingRequestId,
      signedTxCbor: signedTxCbor,
      isValid: verificationResult.isValid,
      txBodyHash: verificationResult.txBodyHash,
      witnessCount: verificationResult.witnessCount,
      signerKeyHashes: JSON.stringify(verificationResult.signerKeyHashes),
      errorMessage: verificationResult.errorMessage || null,
      warnings: JSON.stringify(verificationResult.warnings),
      verifiedAt: new Date().toISOString(),
    };

    await tx.run(INSERT.into(SignatureVerifications).entries(verificationRecord));
    logger.debug({ verificationId: verificationRecord.id }, 'Persisted signature verification record');

    const newStatus = verificationResult.isValid ? 'verified' : 'failed';
    await tx.run(
      UPDATE.entity(SigningRequests)
        .set({
          status: newStatus,
          signerType: signerType || 'custom',
          signerInfo: signerInfo || null,
          signedAt: verificationResult.isValid ? new Date().toISOString() : null,
          errorMessage: verificationResult.isValid ? null : verificationResult.errorMessage,
        })
        .where({ id: signingRequestId })
    );
    logger.debug({ signingRequestId, newStatus }, 'Updated signing request status');

    return verificationRecord;
  }

  /** Persist a verified submission: verification, submission, signing request and build updates. */
  async indexVerifiedTransactionSubmission(
    tx: CapTransaction,
    params: {
      signingRequestId: string;
      buildId: string;
      fullSignedTxCbor: string;
      txHash: string;
      verificationResult: {
        txBodyHash: string;
        witnessCount: number;
        signerKeyHashes: string[];
        warnings: string[];
      };
      signerType?: string;
      signerInfo?: string;
    }
  ): Promise<TransactionSubmission> {
    const { signingRequestId, buildId, fullSignedTxCbor, txHash, verificationResult, signerType, signerInfo } = params;

    const verificationRecord = {
      id: cds.utils.uuid(),
      signingRequest_id: signingRequestId,
      signedTxCbor: fullSignedTxCbor,
      isValid: true,
      txBodyHash: verificationResult.txBodyHash,
      witnessCount: verificationResult.witnessCount,
      signerKeyHashes: JSON.stringify(verificationResult.signerKeyHashes),
      errorMessage: null,
      warnings: JSON.stringify(verificationResult.warnings),
      verifiedAt: new Date().toISOString(),
    };
    await tx.run(INSERT.into(SignatureVerifications).entries(verificationRecord));
    logger.debug({ verificationId: verificationRecord.id }, 'Persisted signature verification record');

    const indexSubmission = mapTransactionSubmission(fullSignedTxCbor, txHash);
    const submissionRecord = {
      ...indexSubmission,
      build_id: buildId,
      backendResponse: `Submitted successfully (verified: ${verificationResult.witnessCount} witness(es))`,
      status: 'submitted' as const,
    };
    await tx.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
    logger.debug({ submissionId: submissionRecord.id }, 'Persisted submission record');

    const now = new Date().toISOString();
    await tx.run(
      UPDATE.entity(SigningRequests)
        .set({
          status: 'submitted',
          signerType: signerType || 'custom',
          signerInfo: signerInfo || null,
          signedAt: now,
          submittedAt: now,
          submission_id: submissionRecord.id,
        })
        .where({ id: signingRequestId })
    );
    logger.debug({ signingRequestId }, 'Updated signing request status to submitted');

    await tx.run(
      UPDATE.entity(TransactionBuilds)
        .set({ wasSubmitted: true })
        .where({ id: buildId })
    );
    logger.debug({ buildId }, 'Updated build wasSubmitted flag');

    return submissionRecord;
  }

  /** Index the latest epoch. */
  async indexLatestEpoch(tx: CapTransaction): Promise<Epoch> {
    const epochInfo = await this.client.getLatestEpoch();

    const epochEntity = mapEpoch(epochInfo);


    await tx.run(UPSERT.into(Epoch).entries([epochEntity]))
    return epochEntity;
  }

  /** Index the latest block, with best-effort epoch enrichment. */
  async indexLatestBlock(tx: CapTransaction): Promise<Block> {

    const blockInfo = await this.client.getLatestBlock();
    let epoch: Epoch | undefined;
    try {
      epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    } catch {
      // Epoch data may not be available (e.g., Koios drops old/in-progress epochs)
    }
    const blockEntity = mapBlock(blockInfo, epoch);

    // A header-only tip is never persisted: its zeros would read as an empty block, overwrite a
    // crawled row of the same hash, or outlive the block when the tip is rolled back.
    if (blockInfo.headerOnly) {
      const stored = await tx.run(SELECT.one.from(Block).where({ hash: blockInfo.hash })) as Block | undefined;
      return stored ?? blockEntity;
    }

    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /** Max addresses to index concurrently (avoid overloading backends) */
  private static readonly ADDR_CONCURRENCY = 5;

  /** Block position of a transaction already in the local index (crawled or cached), or null. */
  async findIndexedTransaction(
    tx: CapTransaction,
    txHash: string
  ): Promise<{ slot: number | null; blockHeight: number | null } | null> {
    const row = await tx.run(
      SELECT.one.from(Transactions).columns('slot', 'blockHeight').where({ hash: txHash })
    ) as { slot: number | null; blockHeight: number | null } | undefined;
    return row ?? null;
  }

  /**
   * Ensure a set of transactions is indexed: DB check, batch fetch of the missing ones, UPSERT.
   * @returns provider transactions for the hashes that had to be fetched
   */
  async ensureTransactionsIndexed(
    tx: CapTransaction,
    txHashes: string[]
  ): Promise<Map<string, ProviderTransaction>> {
    const unique = [...new Set(txHashes)];
    if (unique.length === 0) return new Map();

    const existingRows = await tx.run(
      SELECT.from(Transactions).columns('hash').where({ hash: { in: unique } })
    );
    const existingSet = new Set((existingRows as Array<{ hash: string }>).map((r) => r.hash));
    const missing = unique.filter(h => !existingSet.has(h));

    logger.debug(`ensureTransactionsIndexed: ${unique.length} unique, ${existingSet.size} cached, ${missing.length} to fetch`);

    let fetched = new Map<string, ProviderTransaction>();
    if (missing.length > 0) {
      fetched = await this.client.getTransactionsBatch(missing);

      for (const [, providerTx] of fetched) {
        const txRow = mapTransaction(providerTx);
        await tx.run(UPSERT.into(Transactions).entries(txRow));
        await this.writeTransactionChildren(tx, providerTx, txRow.txSeq as number);
      }
    }

    return fetched;
  }

  //-----------------------------------------------------------------------------
  // Private Helpers
  //-----------------------------------------------------------------------------

  /**
   * Index the addresses of an account with bounded concurrency. The address data the account
   * carries (from the backend, or from the crawled set) is used as is, so an account costs no
   * request per address; an entry without UTxOs is fetched.
   */
  private async _ensureAddresses(
    tx: CapTransaction,
    accountAddresses: ProviderAddress[]
  ): Promise<void> {
    const concurrency = CardanoIndexer.ADDR_CONCURRENCY;
    for (let i = 0; i < accountAddresses.length; i += concurrency) {
      const chunk = accountAddresses.slice(i, i + concurrency);
      await Promise.all(chunk.map(a => this.indexAddress(tx, a.address, Array.isArray(a.utxos) ? a : undefined)));
    }
  }
}
