import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { dataFromCbor, dataToCbor } from "@harmoniclabs/plutus-data";
import { Tx, Hash32 } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Inline datums given as CBOR, keyed by output index. Buildooor writes every datum in its
 * own encoding, so definite lists and maps change bytes and hash. These helpers put the
 * caller's bytes back into the built transaction.
 */
export type CallerDatums = Map<number, Uint8Array>;

/** Output map entry `2 => [1, #6.24(datum)]` that holds an inline datum. */
function inlineDatumEntry(datum: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0x02, 0x82, 0x01]), Buffer.from(Cbor.encode(new CborTag(24, new CborBytes(datum))))]);
}

/** Bytes one output gains when its datum is written as given; negative when it shrinks. */
export function callerDatumGrowth(datum: Uint8Array): number {
  return inlineDatumEntry(datum).length - inlineDatumEntry(dataToCbor(dataFromCbor(datum))).length;
}

/** Bytes the whole transaction gains from the caller's datums, never below zero. */
export function callerDatumsGrowth(datums: CallerDatums): number {
  let growth = 0;
  for (const datum of datums.values()) growth += callerDatumGrowth(datum);
  return Math.max(0, growth);
}

/**
 * Replace Buildooor's datum encoding in the listed outputs with the caller's bytes.
 * Only the datum bytes change. Containers in CBOR count items, not bytes, so the rest stays valid.
 */
export function writeCallerDatums(tx: Tx, datums: CallerDatums): Tx {
  if (datums.size === 0) return tx;
  let bytes = Buffer.from(tx.toCbor());
  const outputs = Tx.fromCbor(toHex(bytes)).body.outputs;
  // Last output first, so the offsets of earlier outputs stay valid
  for (const index of [...datums.keys()].sort((a, b) => b - a)) {
    const out = outputs[index];
    const ref = out?.cborRef;
    if (!out || !ref || out.datum === undefined || out.datum instanceof Hash32) {
      throw new Error(`output ${index} of the built transaction carries no inline datum`);
    }
    const built = inlineDatumEntry(dataToCbor(out.datum));
    const at = bytes.subarray(ref.start, ref.end).indexOf(built);
    if (at < 0) throw new Error(`inline datum of output ${index} not found in the built transaction`);
    const start = ref.start + at;
    bytes = Buffer.concat([bytes.subarray(0, start), inlineDatumEntry(datums.get(index)!), bytes.subarray(start + built.length)]);
  }
  return Tx.fromCbor(toHex(bytes));
}

/** Datum hash as the ledger computes it: blake2b-256 of the datum bytes. */
export function datumHashOf(datum: Uint8Array): string {
  return toHex(blake2b_256(datum));
}

/** Bytes the witness set gains from the caller's datums, never below zero. */
export function witnessDatumsGrowth(datums: Uint8Array[]): number {
  let growth = 0;
  for (const datum of datums) growth += datum.length - dataToCbor(dataFromCbor(datum)).length;
  return Math.max(0, growth);
}

/** End offset of a parsed item; a tag carries no offset of its own, its content does. */
function endOf(item: CborObj): number {
  let inner = item;
  while (inner instanceof CborTag) inner = inner.data;
  return inner.subCborRef!.end;
}

/** Length of a CBOR item head, from its first byte. */
function headLength(first: number): number {
  const info = first & 0x1f;
  return info < 24 || info === 31 ? 1 : info === 24 ? 2 : info === 25 ? 3 : info === 26 ? 5 : 9;
}

function entryOf(map: CborMap, key: number) {
  return map.map.find(e => e.k instanceof CborUInt && Number(e.k.num) === key);
}

/** Bytes of a map entry's value as they stand in `bytes`. */
function valueBytes(bytes: Buffer, entry: { k: CborObj; v: CborObj }): Buffer {
  return bytes.subarray(entry.k.subCborRef!.end, endOf(entry.v));
}

/**
 * Replace Buildooor's encoding of the witness datums with the caller's bytes, then recompute
 * scriptDataHash over redeemers, datums and language views as they now stand in the transaction.
 * The ledger finds a witness datum by the hash of its bytes, so a re-encoded datum is missing to it.
 */
export function writeWitnessDatums(tx: Tx, datums: Uint8Array[], languageViews: Uint8Array): Tx {
  const wanted = new Map<string, Uint8Array>();
  for (const datum of datums) {
    const built = toHex(dataToCbor(dataFromCbor(datum)));
    if (built !== toHex(datum)) wanted.set(built, datum);
  }
  if (wanted.size === 0) return tx;

  let bytes = Buffer.from(tx.toCbor());
  let root = Cbor.parse(bytes, { keepRef: true }) as CborArray;
  const datumsEntry = entryOf(root.array[1] as CborMap, 4);
  let list = datumsEntry?.v;
  while (list instanceof CborTag) list = list.data;
  if (!(list instanceof CborArray)) throw new Error('the built transaction carries no witness datums');

  // Rebuild the datum list item by item: head, items, and the break byte of an indefinite list
  const listStart = list.subCborRef!.start;
  const listEnd = list.subCborRef!.end;
  let at = listStart + headLength(bytes[listStart]);
  const parts: Uint8Array[] = [bytes.subarray(listStart, at)];
  for (const item of list.array) {
    const end = endOf(item);
    parts.push(wanted.get(toHex(bytes.subarray(at, end))) ?? bytes.subarray(at, end));
    at = end;
  }
  parts.push(bytes.subarray(at, listEnd));
  bytes = Buffer.concat([bytes.subarray(0, listStart), ...parts, bytes.subarray(listEnd)]);

  root = Cbor.parse(bytes, { keepRef: true }) as CborArray;
  const hashEntry = entryOf(root.array[0] as CborMap, 11);
  if (!hashEntry) throw new Error('the built transaction carries no scriptDataHash');
  bytes.set(scriptDataHashOf(bytes, languageViews), endOf(hashEntry.v) - 32);
  return Tx.fromCbor(toHex(bytes));
}

/** scriptDataHash of a transaction over its redeemer and datum bytes as they stand, laid out like Buildooor's getScriptDataHash. */
export function scriptDataHashOf(txBytes: Uint8Array, languageViews: Uint8Array): Uint8Array {
  const bytes = Buffer.from(txBytes);
  const witnesses = (Cbor.parse(bytes, { keepRef: true }) as CborArray).array[1] as CborMap;
  const redeemers = entryOf(witnesses, 5);
  const datums = entryOf(witnesses, 4);
  if (!redeemers && !datums) throw new Error('the transaction carries no redeemers and no datums');
  const datumBytes = datums ? valueBytes(bytes, datums) : Buffer.alloc(0);
  return blake2b_256(redeemers
    ? Buffer.concat([valueBytes(bytes, redeemers), datumBytes, languageViews])
    : Buffer.concat([Buffer.from([0xa0]), datumBytes, Buffer.from([0xa0])]));
}
