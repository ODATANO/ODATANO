import cds from '@sap/cds';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { Amount } from '../../utils/types';
import { buildLedgerUtxoRows, type LedgerAnchor, type LedgerUtxoAssetRow, type LedgerUtxoRow } from '../ledger-state';
import {
  readCursor,
  isCrawlerLeaseActive,
  setUtxoSetState,
  tryAcquireImportLease,
  renewImportLease,
  releaseImportLease,
  CRAWLER_LEASE_TTL_MS,
} from './sync-state';
import {
  LedgerUTxOs,
  LedgerUTxOAssets,
  LedgerAddresses,
  LedgerAddressAssets,
  LedgerAccounts,
} from '#cds-models/odatano/cardano';
import { chunk, IN_CHUNK } from '../../utils/collections';

const { UPSERT, DELETE } = cds.ql;
const logger = cds.log('LedgerState');

/**
 * One-off import of the UTxO set at the anchor point that `crawler.utxoSet` builds on.
 * Two sources:
 *
 *  - `ogmios`: `queryLedgerState/utxo` for the whole set, acquired at the crawler's
 *    cursor point (which must lie inside the node's volatile window, i.e. the crawl is at
 *    the tip). Fine on preview/preprod; on mainnet the whole-set query is memory-heavy on
 *    the node, use a file.
 *  - `file`: a `cardano-cli query utxo --whole-utxo --out-file` dump. `.json` is parsed
 *    whole (small networks); `.ndjson` / `.jsonl` is streamed line by line, one entry per
 *    line as `jq -c 'to_entries[]'` emits it (`{"key":"tx#ix","value":{…}}`) or as a
 *    one-key object. The anchor is the tip at dump time (`cardano-cli query tip` before
 *    and after; same hash = valid anchor).
 *
 * Preconditions: the crawler is paused (no active lease) and its cursor is not past the
 * anchor — blocks between cursor and anchor are crawled but not applied, blocks after it
 * are. The tables are truncated first, so a re-import is always a full one.
 */

export class UtxoSetImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UtxoSetImportError';
  }
}

/** The cursor lease went to someone else: nothing more may be written, not even `invalid`. */
export class UtxoSetLeaseLostError extends UtxoSetImportError {
  constructor(message = 'Lost the cursor lease during the import — aborted without further writes.') {
    super(message);
    this.name = 'UtxoSetLeaseLostError';
  }
}

export interface UtxoSetEntry {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: Amount[];
  dataHash?: string | null;
  inlineDatum?: string | null;
  referenceScriptHash?: string | null;
}

export interface UtxoSetImportOptions {
  source: 'ogmios' | 'file';
  filePath?: string;
  anchor: LedgerAnchor;
  client: CardanoClient;
  indexer: CardanoIndexer;
  /** Rows per write transaction. */
  batchSize?: number;
  onProgress?: (imported: number) => void;
}

export interface UtxoSetImportResult {
  utxos: number;
  anchor: LedgerAnchor;
}

/** `cardano-cli query utxo` value: `{ lovelace: n, [policyId]: { [assetNameHex]: qty } }`. */
export interface CliUtxoValue {
  address: string;
  value: Record<string, number | string | Record<string, number | string>>;
  datumhash?: string | null;
  datumHash?: string | null;
  inlineDatumRaw?: string | null;
  referenceScript?: unknown;
}

/**
 * `JSON.parse` for a cardano-cli dump that keeps every integer exact. The cli prints
 * quantities as JSON numbers; a token supply above 2^53 would otherwise be rounded before
 * it ever reaches `String()`. A small scanner quotes every integer literal that sits
 * OUTSIDE a string (string contents, escapes included, pass through untouched), so the
 * value arrives as a string — the entry parser stringifies anyway. Floats keep their JSON
 * meaning; a cli dump has none in value position.
 */
export function parseJsonLossless<T = unknown>(text: string): T {
  // One native pass: a string literal is copied as is, an integer literal outside a string is
  // quoted, floats keep their JSON meaning (a cli dump has none in value position).
  const rewritten = text.replace(
    /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m) => (m[0] === '"' || !/^-?\d+$/.test(m) ? m : `"${m}"`),
  );
  return JSON.parse(rewritten) as T;
}

/** Parse one `"txHash#index": {…}` entry of a cardano-cli dump; null when malformed. */
export function parseCliUtxoEntry(key: string, value: CliUtxoValue | null | undefined): UtxoSetEntry | null {
  const m = /^([0-9a-fA-F]{64})#(\d+)$/.exec(key ?? '');
  if (!m || !value || typeof value.address !== 'string') return null;
  const amount: Amount[] = [];
  const v = value.value ?? {};
  for (const [k, q] of Object.entries(v)) {
    if (k === 'lovelace') {
      amount.push({ unit: 'lovelace', quantity: String(q) });
    } else if (q && typeof q === 'object') {
      for (const [nameHex, qty] of Object.entries(q)) {
        amount.push({ unit: `${k}${nameHex}`, quantity: String(qty) });
      }
    }
  }
  if (!amount.some(a => a.unit === 'lovelace')) amount.unshift({ unit: 'lovelace', quantity: '0' });
  return {
    txHash: m[1].toLowerCase(),
    outputIndex: Number(m[2]),
    address: value.address,
    amount,
    dataHash: value.datumhash ?? value.datumHash ?? null,
    inlineDatum: typeof value.inlineDatumRaw === 'string' ? value.inlineDatumRaw : null,
    // the cli prints the script itself, not its hash — resolved lazily, like every other path
    referenceScriptHash: null,
  };
}

/** Stream a cardano-cli dump. See the module doc for the accepted layouts. */
export async function* readUtxoSetFile(filePath: string): AsyncGenerator<UtxoSetEntry> {
  if (/\.json$/i.test(filePath)) {
    const parsed = parseJsonLossless<Record<string, CliUtxoValue>>(await readFile(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      const entry = parseCliUtxoEntry(key, value);
      if (entry) yield entry;
    }
    return;
  }
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = parseJsonLossless<Record<string, unknown>>(trimmed);
    if (typeof obj.key === 'string' && obj.value && typeof obj.value === 'object') {
      const entry = parseCliUtxoEntry(obj.key, obj.value as CliUtxoValue);
      if (entry) yield entry;
      continue;
    }
    for (const [key, value] of Object.entries(obj)) {
      const entry = parseCliUtxoEntry(key, value as CliUtxoValue);
      if (entry) yield entry;
    }
  }
}

async function* readFromOgmios(client: CardanoClient, anchor: LedgerAnchor): AsyncGenerator<UtxoSetEntry> {
  const backend = client.getLedgerStateBackend();
  if (!backend) {
    throw new UtxoSetImportError('No Ogmios backend available for source "ogmios" — configure one or import a cardano-cli file.');
  }
  const utxos = await backend.queryUtxoSetAt({ slot: anchor.slot, hash: anchor.hash });
  for (const u of utxos) {
    yield {
      txHash: u.txHash,
      outputIndex: u.outputIndex,
      address: u.address,
      amount: u.amount,
      dataHash: u.datumHash ?? null,
      inlineDatum: u.inlineDatum ?? null,
      referenceScriptHash: u.scriptRef ?? null,
    };
  }
}

/** Table names as CAP creates them (dots → underscores), for the aggregate statements. */
const T = {
  utxos: 'odatano_cardano_LedgerUTxOs',
  utxoAssets: 'odatano_cardano_LedgerUTxOAssets',
  addresses: 'odatano_cardano_LedgerAddresses',
  addressAssets: 'odatano_cardano_LedgerAddressAssets',
  accounts: 'odatano_cardano_LedgerAccounts',
};

/**
 * The three aggregate statements that derive the running sums from the imported rows.
 * Plain SQL because millions of addresses do not fit an in-memory map and a per-row
 * UPSERT would take hours; the syntax is the portable subset (sqlite, PostgreSQL, HANA).
 */
export function aggregateStatements(): string[] {
  return [
    `INSERT INTO ${T.addresses} (address, stakeAddress, addressType, isScript, totalLovelace, utxoCount, firstSeenSlot, lastActiveSlot) ` +
    `SELECT address, MIN(stakeAddress), MIN(addressType), ` +
    `CASE WHEN MAX(CASE WHEN isScript THEN 1 ELSE 0 END) = 1 THEN TRUE ELSE FALSE END, ` +
    `SUM(lovelace), COUNT(*), NULL, NULL FROM ${T.utxos} GROUP BY address`,
    `INSERT INTO ${T.addressAssets} (address_address, unit, asset_quantity, asset_policyId, asset_assetNameHex, asset_assetName) ` +
    `SELECT u.address, a.unit, SUM(a.asset_quantity), MIN(a.asset_policyId), MIN(a.asset_assetNameHex), MIN(a.asset_assetName) ` +
    `FROM ${T.utxoAssets} a JOIN ${T.utxos} u ON a.utxo_txHash = u.txHash AND a.utxo_outputIndex = u.outputIndex ` +
    `GROUP BY u.address, a.unit`,
    `INSERT INTO ${T.accounts} (stakeAddress, controlledAmount, addressCount, utxoCount, lastActiveSlot) ` +
    `SELECT stakeAddress, SUM(totalLovelace), COUNT(*), SUM(utxoCount), NULL FROM ${T.addresses} ` +
    `WHERE stakeAddress IS NOT NULL GROUP BY stakeAddress`,
  ];
}

/**
 * Run the import. Throws `UtxoSetImportError` on a precondition failure before anything is
 * written; a failure mid-way leaves the set marked `invalid` (never half-`active`).
 */
export async function importUtxoSet(opts: UtxoSetImportOptions): Promise<UtxoSetImportResult> {
  const { anchor, source } = opts;
  const batchSize = opts.batchSize ?? 2000;

  const cursor = await cds.tx((tx) => readCursor(tx));
  if (!cursor) throw new UtxoSetImportError('No crawler cursor yet — start the crawler once before importing.');
  if (isCrawlerLeaseActive(cursor)) throw new UtxoSetImportError('Crawler is running — pause it first (pauseCrawler).');
  if (cursor.lastSlot > anchor.slot) {
    throw new UtxoSetImportError(
      `Crawler cursor (slot ${cursor.lastSlot}) is past the anchor (slot ${anchor.slot}) — blocks after the anchor were ` +
      'already crawled without a set to apply them to. Dump the set at or after the cursor.'
    );
  }
  if (source === 'file' && !opts.filePath) throw new UtxoSetImportError('source "file" needs filePath.');

  // Cluster-wide exclusion: hold the cursor lease for the whole import. A crawler start on
  // any instance (resumeCrawler, standby) and a second import are refused while it is held;
  // renewed on a heartbeat, released in `finally`.
  const leaseOwner = `import:${process.pid}:${Date.now().toString(36)}`;
  const acquired = await cds.tx((tx) => tryAcquireImportLease(tx, leaseOwner));
  if (!acquired) throw new UtxoSetImportError('Could not take the cursor lease — a crawler or another import holds it.');
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    cds.tx((tx) => renewImportLease(tx, leaseOwner))
      .then((ok) => { if (!ok) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, Math.max(1000, Math.floor(CRAWLER_LEASE_TTL_MS / 3)));
  heartbeat.unref();
  /**
   * Every write runs through here: the lease is re-taken INSIDE the transaction (an UPDATE
   * conditioned on `leaseOwner = us`, verified by read-back), so a successor that took the
   * lease between two batches makes this transaction fail before its writes commit. The
   * heartbeat flag alone only knows what was true at the last tick.
   */
  const writeTx = <T>(fn: (tx: CapTransaction) => Promise<T>): Promise<T> =>
    cds.tx(async (tx: CapTransaction) => {
      if (leaseLost || !(await renewImportLease(tx, leaseOwner))) throw new UtxoSetLeaseLostError();
      return fn(tx);
    }) as unknown as Promise<T>;

  opts.indexer.setUtxoAnchor(null);
  try {
  await writeTx(async (tx) => {
    await setUtxoSetState(tx, { status: 'importing', anchorSlot: anchor.slot, anchorHash: anchor.hash, error: null, importedAt: null, appliedSlot: null });
    await tx.run(DELETE.from(LedgerUTxOAssets));
    await tx.run(DELETE.from(LedgerUTxOs));
    await tx.run(DELETE.from(LedgerAddressAssets));
    await tx.run(DELETE.from(LedgerAddresses));
    await tx.run(DELETE.from(LedgerAccounts));
  });

  let imported = 0;
  try {
    const entries = source === 'ogmios' ? readFromOgmios(opts.client, anchor) : readUtxoSetFile(opts.filePath!);
    let rows: LedgerUtxoRow[] = [];
    let assets: LedgerUtxoAssetRow[] = [];
    const flush = async (): Promise<void> => {
      if (!rows.length) return;
      const r = rows; const a = assets;
      rows = []; assets = [];
      await writeTx(async (tx) => {
        for (const c of chunk(r, IN_CHUNK)) await tx.run(UPSERT.into(LedgerUTxOs).entries(c));
        for (const c of chunk(a, IN_CHUNK)) await tx.run(UPSERT.into(LedgerUTxOAssets).entries(c));
      });
      imported += r.length;
      opts.onProgress?.(imported);
    };
    for await (const e of entries) {
      const built = buildLedgerUtxoRows(e, null);
      rows.push(built.row);
      assets.push(...built.assets);
      if (rows.length >= batchSize) await flush();
    }
    await flush();

    // Aggregates + activation in ONE lease-checked transaction: the set can never be
    // `active` with sums a successor's import has meanwhile truncated.
    const importedAt = new Date().toISOString();
    await writeTx(async (tx) => {
      for (const sql of aggregateStatements()) await (tx as unknown as { run: (sql: string) => Promise<unknown> }).run(sql);
      await setUtxoSetState(tx, { status: 'active', anchorSlot: anchor.slot, anchorHash: anchor.hash, importedAt, error: null });
    });
    opts.indexer.setUtxoAnchor(anchor);
    logger.info(`UTxO set imported: ${imported} entries at anchor ${anchor.slot}/${anchor.hash} (source=${source})`);
    return { utxos: imported, anchor };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`UTxO set import failed after ${imported} entries: ${message}`);
    // Only the lease holder may write the failure state; after a takeover the row is the
    // successor's and the truncated tables are its problem to fill.
    if (!(err instanceof UtxoSetLeaseLostError)) {
      await cds.tx(async (tx) => {
        if (await renewImportLease(tx, leaseOwner)) await setUtxoSetState(tx, { status: 'invalid', error: message.slice(0, 500) });
      }).catch(() => undefined);
    }
    throw err;
  }
  } finally {
    clearInterval(heartbeat);
    await cds.tx((tx) => releaseImportLease(tx, leaseOwner)).catch(() => undefined);
  }
}
