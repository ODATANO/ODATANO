import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import {
  LedgerUTxOs,
  LedgerUTxOAssets,
  LedgerAddresses,
  LedgerAddressAssets,
  LedgerAccounts,
  type LedgerUTxO,
  type LedgerUTxOAsset,
} from '#cds-models/odatano/cardano';
import type { Amount, BlockData, Transaction as ProviderTransaction, TxOutputLine, ReferenceScriptType } from '../utils/types';
import { decodeShelleyAddress, assetSlice } from '../utils/mappers';
import { chunk, IN_CHUNK } from '../utils/collections';

const { SELECT, UPSERT, UPDATE, DELETE } = cds.ql;
const logger = cds.log('LedgerState');

// UTxO set and running sums per address and stake key, fed by the crawler (`crawler.utxoSet`).
// Only blocks after the imported snapshot (the anchor) are applied. A reorg before it invalidates the set.

/** The point the imported UTxO set describes; blocks with slot > anchor.slot are applied. */
export interface LedgerAnchor {
  slot: number;
  hash: string;
}

export interface LedgerApplyResult {
  created: number;
  spent: number;
  /** Consumed outputs with no open row. Means a gap between snapshot and crawl, never expected. */
  missing: number;
  addresses: number;
}

/** A `LedgerUTxOs` row as the block path writes it: every column set, lovelace as an exact string. */
export type LedgerUtxoRow = Required<Omit<LedgerUTxO, 'assets' | 'lovelace' | 'utxo_referenceScriptType' | 'address' | 'addressType' | 'isScript' | 'hasAssets'>>
  & { address: string; addressType: string; isScript: boolean; hasAssets: boolean; lovelace: string; utxo_referenceScriptType: ReferenceScriptType | null };

/** A `LedgerUTxOAssets` row as the block path writes it. */
export type LedgerUtxoAssetRow = Required<Omit<LedgerUTxOAsset, 'utxo' | 'asset_quantity'>> & { asset_quantity: string };

/** Minimal output shape the row builder needs, shared by the block path and the import. */
export interface LedgerOutputLike {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: Amount[];
  dataHash?: string | null;
  inlineDatum?: string | null;
  referenceScriptHash?: string | null;
  referenceScriptSize?: number | null;
  referenceScriptType?: ReferenceScriptType | null;
}

const outpoint =(txHash: string, outputIndex: number): string => `${txHash}#${outputIndex}`;
const lovelaceOf = (amount: Amount[] | undefined): bigint =>
  BigInt(amount?.find(a => a.unit === 'lovelace')?.quantity ?? '0');
const nativeAssets = (amount: Amount[] | undefined): Amount[] =>
  (amount ?? []).filter(a => a.unit !== 'lovelace' && a.quantity !== '0');
const big = (v: unknown): bigint => (v == null || v === '' ? 0n : BigInt(String(v)));
const num = (v: unknown): number => Number(v ?? 0);

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
    ...assetSlice(a.unit, a.quantity),
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
      utxo_referenceScriptSize: o.referenceScriptSize ?? null,
      utxo_referenceScriptType: o.referenceScriptType ?? null,
      utxo_paymentCredential: decoded.paymentCredential,
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

/** `LedgerUTxOs` rows (+ asset rows) of a set of source transactions, keyed `txHash#outputIndex`. */
export interface LedgerLookup {
  /** Source transaction hashes this lookup covers (found or not). */
  hashes: Set<string>;
  rows: Map<string, LedgerUtxoRow>;
  assets: Map<string, LedgerUtxoAssetRow[]>;
}

// Read the ledger rows of the given source transactions. Asset rows are read only where a row
// has assets, so an ada-only block costs one SELECT.
export async function readLedgerOutputs(tx: CapTransaction, txHashes: Iterable<string>, into?: LedgerLookup): Promise<LedgerLookup> {
  const lookup: LedgerLookup = into ?? { hashes: new Set(), rows: new Map(), assets: new Map() };
  const todo = [...new Set(txHashes)].filter(h => !lookup.hashes.has(h));
  for (const hashChunk of chunk(todo, IN_CHUNK)) {
    const rows = await tx.run(SELECT.from(LedgerUTxOs).where({ txHash: { in: hashChunk } })) as LedgerUtxoRow[];
    for (const r of rows ?? []) lookup.rows.set(outpoint(r.txHash, num(r.outputIndex)), r);
    const withAssets = [...new Set((rows ?? []).filter(r => r.hasAssets).map(r => r.txHash))];
    if (withAssets.length) {
      const assets = await tx.run(SELECT.from(LedgerUTxOAssets).where({ utxo_txHash: { in: withAssets } })) as LedgerUtxoAssetRow[];
      for (const a of assets ?? []) {
        const k = outpoint(a.utxo_txHash, num(a.utxo_outputIndex));
        const list = lookup.assets.get(k) ?? [];
        list.push(a);
        lookup.assets.set(k, list);
      }
    }
    for (const h of hashChunk) lookup.hashes.add(h);
  }
  return lookup;
}

/** Amount list (lovelace + native assets) of a ledger row, the shape a resolved input carries. */
export function ledgerRowAmount(row: LedgerUtxoRow, assets: LedgerUtxoAssetRow[] | undefined): Amount[] {
  return [
    { unit: 'lovelace', quantity: String(row.lovelace ?? '0') },
    ...(assets ?? []).map(a => ({ unit: a.unit, quantity: String(a.asset_quantity) })),
  ];
}

// Apply one block after the anchor. `lookup` may carry rows the caller already read.
// A missing output is counted, not thrown. DB errors propagate so the block transaction rolls back.
export async function applyBlockToLedger(
  tx: CapTransaction,
  block: BlockData,
  txs: ProviderTransaction[],
  lookup?: LedgerLookup,
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

  // 2) everything this block consumes, same-block outputs first, the rest from the DB
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
  const { rows: dbRows, assets: dbAssets } = await readLedgerOutputs(tx, lookups.map(l => l.txHash), lookup);
  const spentRows: LedgerUtxoRow[] = [];
  let missing = 0;
  for (const l of lookups) {
    const row = dbRows.get(l.key);
    if (!row || row.spentTxHash) {
      missing++;
      if (missing <= 3) {
        logger.warn(`ledger: ${l.spender} consumes ${l.key} which has no open row (${row ? 'already spent' : 'unknown'}), snapshot gap?`);
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
        paymentCredential: decodeShelleyAddress(address).paymentCredential,
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
            ...assetSlice(unit, next),
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

/** Asset rows of the given ledger rows, keyed `txHash#outputIndex`. Reads only rows that have assets. */
async function assetsOfRows(tx: CapTransaction, rows: LedgerUtxoRow[]): Promise<Map<string, LedgerUtxoAssetRow[]>> {
  const byKey = new Map<string, LedgerUtxoAssetRow[]>();
  const wanted = new Set(rows.filter(r => Boolean(r.hasAssets)).map(r => outpoint(r.txHash, num(r.outputIndex))));
  const hashes = [...new Set(rows.filter(r => Boolean(r.hasAssets)).map(r => r.txHash))];
  for (const hashChunk of chunk(hashes, IN_CHUNK)) {
    const assets = await tx.run(SELECT.from(LedgerUTxOAssets).where({ utxo_txHash: { in: hashChunk } })) as LedgerUtxoAssetRow[];
    for (const a of assets ?? []) {
      const k = outpoint(a.utxo_txHash, num(a.utxo_outputIndex));
      if (!wanted.has(k)) continue;
      byKey.set(k, [...(byKey.get(k) ?? []), a]);
    }
  }
  return byKey;
}

/** Latest slot at or before `forkSlot` at which a row of `address` was created or spent. */
async function lastActiveSlotUpTo(tx: CapTransaction, address: string, forkSlot: number): Promise<number | null> {
  const [created, spent] = await Promise.all([
    tx.run(SELECT.one.from(LedgerUTxOs).columns('max(createdSlot) as slot').where({ address, createdSlot: { '<=': forkSlot } })),
    tx.run(SELECT.one.from(LedgerUTxOs).columns('max(spentSlot) as slot').where({ address, spentSlot: { '<=': forkSlot } })),
  ]) as Array<{ slot?: unknown } | undefined>;
  const slots = [created?.slot, spent?.slot].filter(s => s != null).map(num);
  return slots.length ? Math.max(...slots) : null;
}

// Undo rolled-back transactions: drop what they created, reopen what they spent, and take the
// same amounts off the address and account sums that the apply added. `forkSlot` is the slot the
// chain rolled back to. Returns the touched addresses.
export async function undoLedgerForTransactions(tx: CapTransaction, txHashes: string[], forkSlot: number): Promise<string[]> {
  if (!txHashes.length) return [];
  const rolledBack = new Set(txHashes);
  const deltas = new Map<string, AddressDelta>();
  const hashChunks = chunk(txHashes, IN_CHUNK);
  // Every chunk is read before the first write: a reopen in one chunk would otherwise change
  // what a later chunk reads about the outputs its transactions created.
  for (const hashChunk of hashChunks) {
    const [created, spent] = await Promise.all([
      tx.run(SELECT.from(LedgerUTxOs).where({ txHash: { in: hashChunk } })) as Promise<LedgerUtxoRow[]>,
      tx.run(SELECT.from(LedgerUTxOs).where({ spentTxHash: { in: hashChunk } })) as Promise<LedgerUtxoRow[]>,
    ]);
    // A row a rolled-back transaction created and another one spent added nothing to the sums.
    const openCreated = (created ?? []).filter(r => r.spentTxHash == null);
    const reopened = (spent ?? []).filter(r => !rolledBack.has(r.txHash));
    const assets = await assetsOfRows(tx, [...openCreated, ...reopened]);
    for (const r of openCreated) applyDelta(deltaFor(deltas, r), r, assets.get(outpoint(r.txHash, num(r.outputIndex))), -1n);
    for (const r of reopened) applyDelta(deltaFor(deltas, r), r, assets.get(outpoint(r.txHash, num(r.outputIndex))), 1n);
  }
  for (const hashChunk of hashChunks) {
    await tx.run(DELETE.from(LedgerUTxOAssets).where({ utxo_txHash: { in: hashChunk } }));
    await tx.run(DELETE.from(LedgerUTxOs).where({ txHash: { in: hashChunk } }));
  }
  for (const hashChunk of hashChunks) {
    await tx.run(UPDATE.entity(LedgerUTxOs).set({ spentTxHash: null, spentSlot: null }).where({ spentTxHash: { in: hashChunk } }));
  }

  const touched = [...deltas.keys()];
  const stakeDeltas = new Map<string, { lovelace: bigint; utxos: number; removedAddresses: number }>();
  for (const addrChunk of chunk(touched, IN_CHUNK)) {
    const [existing, existingAssets] = await Promise.all([
      tx.run(SELECT.from(LedgerAddresses).where({ address: { in: addrChunk } })) as Promise<Array<Record<string, unknown>>>,
      tx.run(SELECT.from(LedgerAddressAssets).where({ address_address: { in: addrChunk } })) as Promise<Array<Record<string, unknown>>>,
    ]);
    const byAddress = new Map((existing ?? []).map(e => [String(e.address), e]));
    const assetQty = new Map<string, bigint>();
    for (const a of existingAssets ?? []) assetQty.set(`${a.address_address}|${a.unit}`, big(a.asset_quantity));

    for (const address of addrChunk) {
      const d = deltas.get(address)!;
      const prev = byAddress.get(address);
      if (!prev) continue;
      const count = num(prev.utxoCount) + d.utxos;
      const stake = (prev.stakeAddress as string | null) ?? d.stakeAddress;
      // An address the rolled-back blocks brought in did not exist at the fork.
      const firstSeen = prev.firstSeenSlot == null ? null : num(prev.firstSeenSlot);
      const bornAfterFork = firstSeen != null && firstSeen > forkSlot && count <= 0;
      if (bornAfterFork) {
        await tx.run(DELETE.from(LedgerAddressAssets).where({ address_address: address }));
        await tx.run(DELETE.from(LedgerAddresses).where({ address }));
      } else {
        const lastActive = prev.lastActiveSlot == null ? null : num(prev.lastActiveSlot);
        await tx.run(UPSERT.into(LedgerAddresses).entries({
          ...prev,
          totalLovelace: (big(prev.totalLovelace) + d.lovelace).toString(),
          utxoCount: count,
          lastActiveSlot: lastActive != null && lastActive > forkSlot ? await lastActiveSlotUpTo(tx, address, forkSlot) : lastActive,
        }));
        for (const [unit, delta] of d.assets) {
          if (delta === 0n) continue;
          const k = `${address}|${unit}`;
          const next = (assetQty.get(k) ?? 0n) + delta;
          if (next === 0n) {
            await tx.run(DELETE.from(LedgerAddressAssets).where({ address_address: address, unit }));
          } else {
            await tx.run(UPSERT.into(LedgerAddressAssets).entries({
              address_address: address,
              unit,
              ...assetSlice(unit, next),
            }));
          }
        }
      }
      if (stake) {
        const s = stakeDeltas.get(stake) ?? { lovelace: 0n, utxos: 0, removedAddresses: 0 };
        s.lovelace += d.lovelace;
        s.utxos += d.utxos;
        if (bornAfterFork) s.removedAddresses++;
        stakeDeltas.set(stake, s);
      }
    }
  }

  for (const stakeChunk of chunk([...stakeDeltas.keys()], IN_CHUNK)) {
    const existing = await tx.run(SELECT.from(LedgerAccounts).where({ stakeAddress: { in: stakeChunk } })) as Array<Record<string, unknown>>;
    for (const prev of existing ?? []) {
      const stakeAddress = String(prev.stakeAddress);
      const d = stakeDeltas.get(stakeAddress)!;
      const addressCount = num(prev.addressCount) - d.removedAddresses;
      if (addressCount <= 0) {
        await tx.run(DELETE.from(LedgerAccounts).where({ stakeAddress }));
        continue;
      }
      const lastActive = prev.lastActiveSlot == null ? null : num(prev.lastActiveSlot);
      let lastActiveSlot = lastActive;
      if (lastActive != null && lastActive > forkSlot) {
        const latest = await tx.run(
          SELECT.one.from(LedgerAddresses).columns('max(lastActiveSlot) as slot').where({ stakeAddress, lastActiveSlot: { '<=': forkSlot } })
        ) as { slot?: unknown } | undefined;
        lastActiveSlot = latest?.slot == null ? null : num(latest.slot);
      }
      await tx.run(UPSERT.into(LedgerAccounts).entries({
        stakeAddress,
        controlledAmount: (big(prev.controlledAmount) + d.lovelace).toString(),
        addressCount,
        utxoCount: num(prev.utxoCount) + d.utxos,
        lastActiveSlot,
      }));
    }
  }
  return touched;
}

// Recount the sums of these addresses and their stake keys from open rows. Also repairs a drifted sum.
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
      paymentCredential: decoded.paymentCredential,
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
      ...assetSlice(unit, q),
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

/** Address types that carry a payment credential. */
const CREDENTIAL_ADDRESS_TYPES = ['base', 'pointer', 'enterprise'];

// Fill a missing `LedgerAddresses.paymentCredential`, one transaction per chunk. Returns rows updated.
export async function backfillPaymentCredentials(chunkSize = 1000): Promise<number> {
  let updated = 0;
  for (;;) {
    const n = await cds.tx(async (tx: CapTransaction) => {
      const rows = await tx.run(
        SELECT.from(LedgerAddresses).columns('address')
          .where({ paymentCredential: null, addressType: { in: CREDENTIAL_ADDRESS_TYPES } })
          .limit(chunkSize)
      ) as Array<{ address: string }>;
      for (const { address } of rows ?? []) {
        // '' marks an address that decodes without a credential, so it is not picked again
        const credential = decodeShelleyAddress(address).paymentCredential ?? '';
        await tx.run(UPDATE.entity(LedgerAddresses).set({ paymentCredential: credential }).where({ address }));
      }
      return (rows ?? []).length;
    }) as number;
    updated += n;
    if (n < chunkSize) return updated;
  }
}
