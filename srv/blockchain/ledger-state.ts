import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import {
  LedgerUTxOs,
  LedgerUTxOAssets,
  LedgerAddresses,
  LedgerAddressAssets,
  LedgerAccounts,
} from '#cds-models/odatano/cardano';
import type { Amount, BlockData, Transaction as ProviderTransaction, TxOutputLine } from '../utils/types';
import { decodeShelleyAddress } from '../utils/mappers';
import { chunk, IN_CHUNK } from '../utils/collections';

const { SELECT, UPSERT, UPDATE, DELETE } = cds.ql;
const logger = cds.log('LedgerState');

/**
 * Crawler-fed ledger state (`crawler.utxoSet`): UTxO set + per-address/per-stake-key running
 * sums in non-temporal tables. Only blocks AFTER the imported anchor are applied; a reorg past
 * the anchor invalidates the set, one after it is undone by a recount of the open rows.
 */

/** The point the imported UTxO set describes; blocks with slot > anchor.slot are applied. */
export interface LedgerAnchor {
  slot: number;
  hash: string;
}

export interface LedgerApplyResult {
  created: number;
  spent: number;
  /** Consumed outpoints with no open row — a gap between snapshot and crawl, never expected. */
  missing: number;
  addresses: number;
}

/** DB row of `LedgerUTxOs` (flattened struct columns as CAP names them). */
export interface LedgerUtxoRow {
  txHash: string;
  outputIndex: number;
  address: string;
  stakeAddress: string | null;
  addressType: string;
  isScript: boolean;
  lovelace: string;
  createdSlot: number | null;
  spentTxHash: string | null;
  spentSlot: number | null;
  utxo_dataHash: string | null;
  utxo_inlineDatum: string | null;
  utxo_referenceScriptHash: string | null;
  hasAssets: boolean;
}

export interface LedgerUtxoAssetRow {
  utxo_txHash: string;
  utxo_outputIndex: number;
  unit: string;
  asset_quantity: string;
  asset_policyId: string | null;
  asset_assetNameHex: string | null;
  asset_assetName: string | null;
}

/** Minimal output shape the row builder needs — shared by the block path and the import. */
export interface LedgerOutputLike {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: Amount[];
  dataHash?: string | null;
  inlineDatum?: string | null;
  referenceScriptHash?: string | null;
}

const outpoint = (txHash: string, outputIndex: number): string => `${txHash}#${outputIndex}`;
const lovelaceOf = (amount: Amount[] | undefined): bigint =>
  BigInt(amount?.find(a => a.unit === 'lovelace')?.quantity ?? '0');
const nativeAssets = (amount: Amount[] | undefined): Amount[] =>
  (amount ?? []).filter(a => a.unit !== 'lovelace' && a.quantity !== '0');
const big = (v: unknown): bigint => (v == null || v === '' ? 0n : BigInt(String(v)));
const num = (v: unknown): number => Number(v ?? 0);

function decodeAssetName(hex: string): string | null {
  if (!hex) return null;
  try {
    const text = Buffer.from(hex, 'hex').toString('utf8');
    // printable only — a binary asset name has no useful decoded form
    return /^[\x20-\x7e]*$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Build the `LedgerUTxOs` row (+ asset rows) for one output. */
export function buildLedgerUtxoRows(
  o: LedgerOutputLike,
  createdSlot: number | null,
): { row: LedgerUtxoRow; assets: LedgerUtxoAssetRow[] } {
  const decoded = decodeShelleyAddress(o.address);
  const assets = nativeAssets(o.amount).map((a) => ({
    utxo_txHash: o.txHash,
    utxo_outputIndex: o.outputIndex,
    unit: a.unit,
    asset_quantity: String(a.quantity),
    asset_policyId: a.unit.length >= 56 ? a.unit.slice(0, 56) : null,
    asset_assetNameHex: a.unit.length > 56 ? a.unit.slice(56) : '',
    asset_assetName: a.unit.length > 56 ? decodeAssetName(a.unit.slice(56)) : null,
  }));
  return {
    row: {
      txHash: o.txHash,
      outputIndex: o.outputIndex,
      address: o.address,
      stakeAddress: decoded.stakeAddress,
      addressType: decoded.type,
      isScript: decoded.isScript,
      lovelace: lovelaceOf(o.amount).toString(),
      createdSlot,
      spentTxHash: null,
      spentSlot: null,
      utxo_dataHash: o.dataHash || null,
      utxo_inlineDatum: o.inlineDatum || null,
      utxo_referenceScriptHash: o.referenceScriptHash || null,
      hasAssets: assets.length > 0,
    },
    assets,
  };
}

/** Outputs the ledger actually produced: collateral return on a phase-2 failure, else the regular ones. */
function producedOutputs(t: ProviderTransaction): TxOutputLine[] {
  return (t.outputs ?? []).filter(o => (t.spendsCollaterals ? o.isCollateral : !o.isCollateral));
}

/** Inputs the ledger actually consumed: collateral on a phase-2 failure, else the regular (non-reference) ones. */
function consumedInputs(t: ProviderTransaction): { txHash: string; outputIndex: number }[] {
  return (t.inputs ?? [])
    .filter(i => (t.spendsCollaterals ? i.isCollateral : !i.isReference && !i.isCollateral))
    .map(i => ({ txHash: i.txHash, outputIndex: i.outputIndex }));
}

interface AddressDelta {
  lovelace: bigint;
  utxos: number;
  assets: Map<string, bigint>;
  stakeAddress: string | null;
  addressType: string;
  isScript: boolean;
}

function deltaFor(map: Map<string, AddressDelta>, row: LedgerUtxoRow): AddressDelta {
  let d = map.get(row.address);
  if (!d) {
    d = { lovelace: 0n, utxos: 0, assets: new Map(), stakeAddress: row.stakeAddress, addressType: row.addressType, isScript: row.isScript };
    map.set(row.address, d);
  }
  return d;
}

function applyDelta(d: AddressDelta, row: LedgerUtxoRow, assets: LedgerUtxoAssetRow[] | Amount[] | undefined, sign: 1n | -1n): void {
  d.lovelace += sign * BigInt(row.lovelace);
  d.utxos += Number(sign);
  for (const a of assets ?? []) {
    const unit = 'unit' in a ? a.unit : '';
    const qty = 'asset_quantity' in a ? a.asset_quantity : (a as Amount).quantity;
    if (!unit) continue;
    d.assets.set(unit, (d.assets.get(unit) ?? 0n) + sign * BigInt(qty));
  }
}

/**
 * Apply one block to the ledger tables. Caller guarantees `block.slot > anchor.slot`.
 * Never throws for a missing outpoint (it is counted and logged); DB errors propagate so the
 * block transaction rolls back as a whole.
 */
export async function applyBlockToLedger(
  tx: CapTransaction,
  block: BlockData,
  txs: ProviderTransaction[],
): Promise<LedgerApplyResult> {
  const slot = block.slot ?? 0;

  // 1) everything this block produces
  const created = new Map<string, { row: LedgerUtxoRow; assets: LedgerUtxoAssetRow[] }>();
  for (const t of txs) {
    for (const o of producedOutputs(t)) {
      const built = buildLedgerUtxoRows({ ...o, txHash: t.hash }, slot);
      created.set(outpoint(t.hash, o.outputIndex), built);
    }
  }

  // 2) everything this block consumes — same-block outputs first, the rest from the DB
  const lookups: { key: string; txHash: string; outputIndex: number; spender: string }[] = [];
  const spentInBlock = new Set<string>();
  for (const t of txs) {
    for (const i of consumedInputs(t)) {
      const key = outpoint(i.txHash, i.outputIndex);
      const own = created.get(key);
      if (own) {
        own.row.spentTxHash = t.hash;
        own.row.spentSlot = slot;
        spentInBlock.add(key);
      } else {
        lookups.push({ key, txHash: i.txHash, outputIndex: i.outputIndex, spender: t.hash });
      }
    }
  }
  const dbRows = new Map<string, LedgerUtxoRow>();
  const dbAssets = new Map<string, LedgerUtxoAssetRow[]>();
  const sourceHashes = [...new Set(lookups.map(l => l.txHash))];
  for (const hashChunk of chunk(sourceHashes, IN_CHUNK)) {
    const [rows, assets] = await Promise.all([
      tx.run(SELECT.from(LedgerUTxOs).where({ txHash: { in: hashChunk } })) as Promise<LedgerUtxoRow[]>,
      tx.run(SELECT.from(LedgerUTxOAssets).where({ utxo_txHash: { in: hashChunk } })) as Promise<LedgerUtxoAssetRow[]>,
    ]);
    for (const r of rows ?? []) dbRows.set(outpoint(r.txHash, num(r.outputIndex)), r);
    for (const a of assets ?? []) {
      const k = outpoint(a.utxo_txHash, num(a.utxo_outputIndex));
      const list = dbAssets.get(k) ?? [];
      list.push(a);
      dbAssets.set(k, list);
    }
  }
  const spentRows: LedgerUtxoRow[] = [];
  let missing = 0;
  for (const l of lookups) {
    const row = dbRows.get(l.key);
    if (!row || row.spentTxHash) {
      missing++;
      if (missing <= 3) {
        logger.warn(`ledger: ${l.spender} consumes ${l.key} which has no open row (${row ? 'already spent' : 'unknown'}) — snapshot gap?`);
      }
      continue;
    }
    spentRows.push({
      ...row,
      outputIndex: num(row.outputIndex),
      lovelace: String(row.lovelace),
      createdSlot: row.createdSlot == null ? null : num(row.createdSlot),
      isScript: Boolean(row.isScript),
      hasAssets: Boolean(row.hasAssets),
      spentTxHash: l.spender,
      spentSlot: slot,
    });
  }

  // 3) per-address deltas
  const deltas = new Map<string, AddressDelta>();
  for (const [key, { row, assets }] of created) {
    const d = deltaFor(deltas, row);
    applyDelta(d, row, assets, 1n);
    if (spentInBlock.has(key)) applyDelta(d, row, assets, -1n);
  }
  for (const row of spentRows) {
    applyDelta(deltaFor(deltas, row), row, dbAssets.get(outpoint(row.txHash, row.outputIndex)), -1n);
  }

  // 4) UTxO rows
  const createdRows = [...created.values()];
  for (const rows of chunk(createdRows.map(c => c.row), IN_CHUNK)) {
    await tx.run(UPSERT.into(LedgerUTxOs).entries(rows));
  }
  for (const rows of chunk(createdRows.flatMap(c => c.assets), IN_CHUNK)) {
    await tx.run(UPSERT.into(LedgerUTxOAssets).entries(rows));
  }
  for (const rows of chunk(spentRows, IN_CHUNK)) {
    await tx.run(UPSERT.into(LedgerUTxOs).entries(rows));
  }

  // 5) addresses, address assets, accounts
  const touched = [...deltas.keys()];
  const stakeDeltas = new Map<string, { lovelace: bigint; utxos: number; newAddresses: number }>();
  for (const addrChunk of chunk(touched, IN_CHUNK)) {
    const [existing, existingAssets] = await Promise.all([
      tx.run(SELECT.from(LedgerAddresses).where({ address: { in: addrChunk } })) as Promise<Array<Record<string, unknown>>>,
      tx.run(SELECT.from(LedgerAddressAssets).where({ address_address: { in: addrChunk } })) as Promise<Array<Record<string, unknown>>>,
    ]);
    const byAddress = new Map((existing ?? []).map(e => [String(e.address), e]));
    const assetQty = new Map<string, bigint>();
    for (const a of existingAssets ?? []) assetQty.set(`${a.address_address}|${a.unit}`, big(a.asset_quantity));

    const addressRows: Array<Record<string, unknown>> = [];
    const assetRows: Array<Record<string, unknown>> = [];
    const assetDeletes: Array<{ address_address: string; unit: string }> = [];
    for (const address of addrChunk) {
      const d = deltas.get(address)!;
      const prev = byAddress.get(address);
      const total = big(prev?.totalLovelace) + d.lovelace;
      const count = num(prev?.utxoCount) + d.utxos;
      addressRows.push({
        address,
        stakeAddress: (prev?.stakeAddress as string | null) ?? d.stakeAddress,
        addressType: (prev?.addressType as string | null) ?? d.addressType,
        isScript: prev ? Boolean(prev.isScript) : d.isScript,
        totalLovelace: total.toString(),
        utxoCount: count,
        // null stays null: an address that came with the snapshot has no known first slot
        firstSeenSlot: prev ? (prev.firstSeenSlot == null ? null : num(prev.firstSeenSlot)) : slot,
        lastActiveSlot: slot,
      });
      for (const [unit, delta] of d.assets) {
        if (delta === 0n) continue;
        const k = `${address}|${unit}`;
        const next = (assetQty.get(k) ?? 0n) + delta;
        if (next === 0n) {
          if (assetQty.has(k)) assetDeletes.push({ address_address: address, unit });
        } else {
          assetRows.push({
            address_address: address,
            unit,
            asset_quantity: next.toString(),
            asset_policyId: unit.length >= 56 ? unit.slice(0, 56) : null,
            asset_assetNameHex: unit.length > 56 ? unit.slice(56) : '',
            asset_assetName: unit.length > 56 ? decodeAssetName(unit.slice(56)) : null,
          });
        }
      }
      const stake = (prev?.stakeAddress as string | null) ?? d.stakeAddress;
      if (stake) {
        const s = stakeDeltas.get(stake) ?? { lovelace: 0n, utxos: 0, newAddresses: 0 };
        s.lovelace += d.lovelace;
        s.utxos += d.utxos;
        if (!prev) s.newAddresses++;
        stakeDeltas.set(stake, s);
      }
    }
    for (const rows of chunk(addressRows, IN_CHUNK)) await tx.run(UPSERT.into(LedgerAddresses).entries(rows));
    for (const rows of chunk(assetRows, IN_CHUNK)) await tx.run(UPSERT.into(LedgerAddressAssets).entries(rows));
    for (const del of assetDeletes) await tx.run(DELETE.from(LedgerAddressAssets).where(del));
  }

  const stakes = [...stakeDeltas.keys()];
  for (const stakeChunk of chunk(stakes, IN_CHUNK)) {
    const existing = await tx.run(
      SELECT.from(LedgerAccounts).where({ stakeAddress: { in: stakeChunk } })
    ) as Array<Record<string, unknown>>;
    const byStake = new Map((existing ?? []).map(e => [String(e.stakeAddress), e]));
    const rows = stakeChunk.map((stakeAddress) => {
      const d = stakeDeltas.get(stakeAddress)!;
      const prev = byStake.get(stakeAddress);
      return {
        stakeAddress,
        controlledAmount: (big(prev?.controlledAmount) + d.lovelace).toString(),
        addressCount: num(prev?.addressCount) + d.newAddresses,
        utxoCount: num(prev?.utxoCount) + d.utxos,
        lastActiveSlot: slot,
      };
    });
    await tx.run(UPSERT.into(LedgerAccounts).entries(rows));
  }

  return { created: created.size, spent: spentInBlock.size + spentRows.length, missing, addresses: touched.length };
}

/**
 * Reorg undo for a set of rolled-back transactions: drop what they created, reopen what
 * they spent, then recount every address either side touched from the open rows.
 * @returns the recounted addresses
 */
export async function undoLedgerForTransactions(tx: CapTransaction, txHashes: string[]): Promise<string[]> {
  if (!txHashes.length) return [];
  const touched = new Set<string>();
  for (const hashChunk of chunk(txHashes, IN_CHUNK)) {
    const [createdRows, spentRows] = await Promise.all([
      tx.run(SELECT.from(LedgerUTxOs).columns('address').where({ txHash: { in: hashChunk } })) as Promise<Array<{ address: string }>>,
      tx.run(SELECT.from(LedgerUTxOs).columns('address').where({ spentTxHash: { in: hashChunk } })) as Promise<Array<{ address: string }>>,
    ]);
    for (const r of [...(createdRows ?? []), ...(spentRows ?? [])]) touched.add(r.address);
    await tx.run(DELETE.from(LedgerUTxOAssets).where({ utxo_txHash: { in: hashChunk } }));
    await tx.run(DELETE.from(LedgerUTxOs).where({ txHash: { in: hashChunk } }));
    await tx.run(UPDATE.entity(LedgerUTxOs).set({ spentTxHash: null, spentSlot: null }).where({ spentTxHash: { in: hashChunk } }));
  }
  const addresses = [...touched];
  await recountLedgerAddresses(tx, addresses);
  return addresses;
}

/**
 * Recount running sums for the given addresses from their open UTxO rows, then the
 * stake keys those addresses belong to. Also the repair path for a drifted sum.
 */
export async function recountLedgerAddresses(tx: CapTransaction, addresses: string[]): Promise<void> {
  const stakes = new Set<string>();
  for (const address of addresses) {
    const open = await tx.run(
      SELECT.from(LedgerUTxOs).columns('txHash', 'outputIndex', 'lovelace', 'hasAssets', 'stakeAddress')
        .where({ address, spentTxHash: null })
    ) as Array<{ txHash: string; outputIndex: number | string; lovelace: unknown; hasAssets: unknown; stakeAddress: string | null }>;
    const openKeys = new Set((open ?? []).map(r => outpoint(r.txHash, num(r.outputIndex))));
    let total = 0n;
    for (const r of open ?? []) total += big(r.lovelace);
    const assetSums = new Map<string, bigint>();
    const withAssets = [...new Set((open ?? []).filter(r => Boolean(r.hasAssets)).map(r => r.txHash))];
    for (const hashChunk of chunk(withAssets, IN_CHUNK)) {
      const rows = await tx.run(
        SELECT.from(LedgerUTxOAssets).where({ utxo_txHash: { in: hashChunk } })
      ) as LedgerUtxoAssetRow[];
      for (const a of rows ?? []) {
        if (!openKeys.has(outpoint(a.utxo_txHash, num(a.utxo_outputIndex)))) continue;
        assetSums.set(a.unit, (assetSums.get(a.unit) ?? 0n) + big(a.asset_quantity));
      }
    }
    const prev = await tx.run(SELECT.one.from(LedgerAddresses).where({ address })) as Record<string, unknown> | undefined;
    const decoded = decodeShelleyAddress(address);
    const stakeAddress = (prev?.stakeAddress as string | null) ?? open?.[0]?.stakeAddress ?? decoded.stakeAddress;
    await tx.run(UPSERT.into(LedgerAddresses).entries({
      address,
      stakeAddress,
      addressType: (prev?.addressType as string | null) ?? decoded.type,
      isScript: prev ? Boolean(prev.isScript) : decoded.isScript,
      totalLovelace: total.toString(),
      utxoCount: (open ?? []).length,
      firstSeenSlot: prev?.firstSeenSlot == null ? null : num(prev.firstSeenSlot),
      lastActiveSlot: prev?.lastActiveSlot == null ? null : num(prev.lastActiveSlot),
    }));
    await tx.run(DELETE.from(LedgerAddressAssets).where({ address_address: address }));
    const assetRows = [...assetSums].filter(([, q]) => q !== 0n).map(([unit, q]) => ({
      address_address: address,
      unit,
      asset_quantity: q.toString(),
      asset_policyId: unit.length >= 56 ? unit.slice(0, 56) : null,
      asset_assetNameHex: unit.length > 56 ? unit.slice(56) : '',
      asset_assetName: unit.length > 56 ? decodeAssetName(unit.slice(56)) : null,
    }));
    for (const rows of chunk(assetRows, IN_CHUNK)) await tx.run(UPSERT.into(LedgerAddressAssets).entries(rows));
    if (stakeAddress) stakes.add(stakeAddress);
  }
  await recountLedgerAccounts(tx, [...stakes]);
}

/** Recount `LedgerAccounts` for the given stake keys from `LedgerAddresses`. */
export async function recountLedgerAccounts(tx: CapTransaction, stakeAddresses: string[]): Promise<void> {
  for (const stakeChunk of chunk(stakeAddresses, IN_CHUNK)) {
    const [addrRows, existing] = await Promise.all([
      tx.run(SELECT.from(LedgerAddresses).columns('stakeAddress', 'totalLovelace', 'utxoCount')
        .where({ stakeAddress: { in: stakeChunk } })) as Promise<Array<Record<string, unknown>>>,
      tx.run(SELECT.from(LedgerAccounts).where({ stakeAddress: { in: stakeChunk } })) as Promise<Array<Record<string, unknown>>>,
    ]);
    const sums = new Map<string, { lovelace: bigint; addresses: number; utxos: number }>();
    for (const r of addrRows ?? []) {
      const k = String(r.stakeAddress);
      const s = sums.get(k) ?? { lovelace: 0n, addresses: 0, utxos: 0 };
      s.lovelace += big(r.totalLovelace);
      s.addresses += 1;
      s.utxos += num(r.utxoCount);
      sums.set(k, s);
    }
    const byStake = new Map((existing ?? []).map(e => [String(e.stakeAddress), e]));
    const rows = stakeChunk.map((stakeAddress) => {
      const s = sums.get(stakeAddress) ?? { lovelace: 0n, addresses: 0, utxos: 0 };
      const prev = byStake.get(stakeAddress);
      return {
        stakeAddress,
        controlledAmount: s.lovelace.toString(),
        addressCount: s.addresses,
        utxoCount: s.utxos,
        lastActiveSlot: prev?.lastActiveSlot == null ? null : num(prev.lastActiveSlot),
      };
    });
    await tx.run(UPSERT.into(LedgerAccounts).entries(rows));
  }
}
