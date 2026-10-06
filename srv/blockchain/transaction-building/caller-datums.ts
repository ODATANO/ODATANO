import { Cbor, CborBytes, CborTag } from "@harmoniclabs/cbor";
import { dataFromCbor, dataToCbor } from "@harmoniclabs/plutus-data";
import { Tx, Hash32 } from "@harmoniclabs/cardano-ledger-ts";
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
