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
  resetCursorTo,
  CRAWLER_LEASE_TTL_MS,
} from './sync-state';
import {
  LedgerUTxOs,
  LedgerUTxOAssets,
  LedgerAddresses,
  LedgerAddressAssets,
  LedgerAccounts,
  Blocks,
} from '#cds-models/odatano/cardano';
import { chunk, IN_CHUNK } from '../../utils/collections';

const { UPSERT, DELETE, SELECT } = cds.ql;
const logger = cds.log('LedgerState');

/**
 * One-off import of the UTxO set at the anchor `crawler.utxoSet` builds on: from Ogmios
 * (`queryLedgerState/utxo` at the cursor point) or a `cardano-cli query utxo --whole-utxo`
 * dump (`.json` parsed whole; `.ndjson`/`.jsonl` streamed, one entry or `{key,value}` per line).
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
 * `JSON.parse` for a cardano-cli dump that keeps every integer exact: integer literals outside
 * strings are quoted before parsing, so a quantity above 2^53 is never rounded.
 */
export function parseJsonLossless<T = unknown>(text: string): T {
  // string literals pass through untouched; floats keep their JSON meaning
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
    `SUM(lovelace), COUNT(*), NULL, NULL FROM ${T.utxos} WHERE spentTxHash IS NULL GROUP BY address`,
    `INSERT INTO ${T.addressAssets} (address_address, unit, asset_quantity, asset_policyId, asset_assetNameHex, asset_assetName) ` +
    `SELECT u.address, a.unit, SUM(a.asset_quantity), MIN(a.asset_policyId), MIN(a.asset_assetNameHex), MIN(a.asset_assetName) ` +
    `FROM ${T.utxoAssets} a JOIN ${T.utxos} u ON a.utxo_txHash = u.txHash AND a.utxo_outputIndex = u.outputIndex ` +
    `WHERE u.spentTxHash IS NULL GROUP BY u.address, a.unit`,
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

  return withImportLease(async (lease) => {
    const { writeTx } = lease;
      opts.indexer.setUtxoAnchor(null);
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

    await activateWithAggregates(lease, opts.indexer, anchor);
    logger.info(`UTxO set imported: ${imported} entries at anchor ${anchor.slot}/${anchor.hash} (source=${source})`);
    return { utxos: imported, anchor };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`UTxO set import failed after ${imported} entries: ${message}`);
    // Only the lease holder may write the failure state; after a takeover the row is the
    // successor's and the truncated tables are its problem to fill.
    if (!(err instanceof UtxoSetLeaseLostError)) await lease.markInvalid(message);
    throw err;
  }
  });
}

type WriteTx = <T>(fn: (tx: CapTransaction) => Promise<T>) => Promise<T>;

interface ImportLease {
  /** Short write: the lease is re-taken first, so a successor that took it in between fails here. */
  writeTx: WriteTx;
  /**
   * Long write: the lease is re-taken as the LAST statement. The cursor row is locked only for the
   * moment before commit, so heartbeats and readers never queue behind the long work.
   */
  writeTxLeaseLast: WriteTx;
  /** Write the failure state if the lease is still ours; ignores a lost heartbeat, never throws. */
  markInvalid: (message: string) => Promise<void>;
}

/**
 * Hold the cursor lease for the whole run: a crawler start on any instance and a second import
 * are refused while it is held; renewed on a heartbeat (one at a time), released at the end.
 */
async function withImportLease<R>(run: (lease: ImportLease) => Promise<R>): Promise<R> {
  const leaseOwner = `import:${process.pid}:${Date.now().toString(36)}`;
  const acquired = await cds.tx((tx) => tryAcquireImportLease(tx, leaseOwner));
  if (!acquired) throw new UtxoSetImportError('Could not take the cursor lease — a crawler or another import holds it.');
  let leaseLost = false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    // A renewal still waiting keeps its connection; a second one would only take another from the pool
    if (renewing) return;
    renewing = true;
    cds.tx(async (tx) => { if (!(await renewImportLease(tx, leaseOwner))) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { renewing = false; });
  }, Math.max(1000, Math.floor(CRAWLER_LEASE_TTL_MS / 3)));
  heartbeat.unref();
  const lease: ImportLease = {
    writeTx: <T>(fn: (tx: CapTransaction) => Promise<T>): Promise<T> =>
      cds.tx(async (tx: CapTransaction) => {
        if (leaseLost || !(await renewImportLease(tx, leaseOwner))) throw new UtxoSetLeaseLostError();
        return fn(tx);
      }) as unknown as Promise<T>,
    writeTxLeaseLast: <T>(fn: (tx: CapTransaction) => Promise<T>): Promise<T> =>
      cds.tx(async (tx: CapTransaction) => {
        const result = await fn(tx);
        if (!(await renewImportLease(tx, leaseOwner))) throw new UtxoSetLeaseLostError();
        return result;
      }) as unknown as Promise<T>,
    markInvalid: (message: string) =>
      cds.tx(async (tx) => {
        if (await renewImportLease(tx, leaseOwner)) await setUtxoSetState(tx, { status: 'invalid', error: message.slice(0, 500) });
      }).then(() => undefined, () => undefined),
  };
  try {
    return await run(lease);
  } finally {
    clearInterval(heartbeat);
    await cds.tx((tx) => releaseImportLease(tx, leaseOwner)).catch(() => undefined);
  }
}

/** A bigger sort/hash budget for the GROUP BY over millions of rows (PostgreSQL only). */
const AGGREGATE_WORK_MEM = '256MB';

/**
 * Aggregates + activation in ONE transaction, so the set is never `active` with sums a successor's
 * import has meanwhile truncated. `prepare` runs first; `finish` and the activation run last,
 * together with the lease check, so the cursor row is not locked during the aggregation.
 */
async function activateWithAggregates(
  lease: ImportLease,
  indexer: CardanoIndexer,
  anchor: LedgerAnchor,
  hooks: { prepare?: (tx: CapTransaction) => Promise<void>; finish?: (tx: CapTransaction) => Promise<void> } = {},
): Promise<void> {
  const importedAt = new Date().toISOString();
  await lease.writeTxLeaseLast(async (tx) => {
    const raw = tx as unknown as { run: (sql: string) => Promise<unknown> };
    if ((cds.db as { kind?: string } | undefined)?.kind === 'postgres') {
      await raw.run(`SET LOCAL work_mem = '${AGGREGATE_WORK_MEM}'`);
      // The planner overestimates the join and walks the address index row by row; hash join + hash aggregate read each table once.
      await raw.run('SET LOCAL enable_nestloop = off');
    }
    await hooks.prepare?.(tx);
    for (const sql of aggregateStatements()) await raw.run(sql);
    await hooks.finish?.(tx);
    await setUtxoSetState(tx, { status: 'active', anchorSlot: anchor.slot, anchorHash: anchor.hash, importedAt, error: null });
  });
  indexer.setUtxoAnchor(anchor);
  // The aggregation leaves paymentCredential empty; filled in the background.
  indexer.resetPaymentCredentials();
  void indexer.paymentCredentialsReady();
}

/**
 * Rebuild only the sums (LedgerAddresses, LedgerAddressAssets, LedgerAccounts) from the rows an
 * earlier import left at the stored anchor, e.g. after the aggregate phase failed. Nothing may have
 * been applied since the anchor; a cursor past it is set back to the anchor, and the blocks after
 * it are crawled again (idempotent writes) so the set follows them.
 */
export async function rebuildUtxoSetAggregates(opts: { indexer: CardanoIndexer }): Promise<UtxoSetImportResult> {
  const cursor = await cds.tx((tx) => readCursor(tx));
  if (!cursor) throw new UtxoSetImportError('No crawler cursor yet.');
  if (isCrawlerLeaseActive(cursor)) throw new UtxoSetImportError('Crawler is running — pause it first (pauseCrawler).');
  const { anchorSlot, anchorHash, appliedSlot, status } = cursor.utxoSet;
  if (anchorSlot == null || !anchorHash) throw new UtxoSetImportError('No imported UTxO set to rebuild the sums from — run importUtxoSet first.');
  if (status === 'importing') throw new UtxoSetImportError('The import is still loading rows (status "importing").');
  if (appliedSlot != null) {
    throw new UtxoSetImportError(`Blocks up to slot ${appliedSlot} were already applied to the set — its rows are past the anchor; import again.`);
  }
  const anchor: LedgerAnchor = { slot: anchorSlot, hash: anchorHash };
  const rows = await cds.tx((tx) => tx.run(SELECT.one.from(LedgerUTxOs).columns('count(*) as n'))) as { n?: number | string } | undefined;
  const utxos = Number(rows?.n ?? 0);
  if (utxos === 0) throw new UtxoSetImportError('LedgerUTxOs is empty — run importUtxoSet first.');

  let rewindTo: { slot: number; hash: string; height: number } | null = null;
  if (cursor.lastSlot > anchor.slot) {
    const block = await cds.tx((tx) => tx.run(SELECT.one.from(Blocks).columns('height').where({ hash: anchor.hash }))) as { height?: number | string } | undefined;
    if (!block) throw new UtxoSetImportError(`Cursor is past the anchor and the anchor block ${anchor.hash} is not stored — cannot set the cursor back.`);
    rewindTo = { slot: anchor.slot, hash: anchor.hash, height: Number(block.height ?? 0) };
  }

  return withImportLease(async (lease) => {
    opts.indexer.setUtxoAnchor(null);
    // The previous failure no longer describes the set; a new one replaces it below
    await lease.writeTx((tx) => setUtxoSetState(tx, { error: null }));
    try {
      await activateWithAggregates(lease, opts.indexer, anchor, {
        prepare: async (tx) => {
          await tx.run(DELETE.from(LedgerAddressAssets));
          await tx.run(DELETE.from(LedgerAddresses));
          await tx.run(DELETE.from(LedgerAccounts));
        },
        finish: rewindTo ? (tx) => resetCursorTo(tx, rewindTo!) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`UTxO set aggregate rebuild failed: ${message}`);
      if (!(err instanceof UtxoSetLeaseLostError)) await lease.markInvalid(message);
      throw err;
    }
    logger.info(`UTxO set sums rebuilt from ${utxos} rows at anchor ${anchor.slot}/${anchor.hash}` +
      (rewindTo ? ` (cursor set back from slot ${cursor.lastSlot})` : ''));
    return { utxos, anchor };
  });
}
