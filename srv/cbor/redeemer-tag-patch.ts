import { CborArray, CborUInt, type CborMapEntry, type CborObj } from '@harmoniclabs/cbor';
import { TxRedeemer, TxRedeemerTag } from '@harmoniclabs/cardano-ledger-ts';

// The TxRedeemer constructor accepts only tags 0 to 3, so Tx.fromCbor throws on Conway voting and
// proposing redeemers. Decode and clone them with tag 0, then set the real tag.
const CONWAY_TAGS = new Set<number>([TxRedeemerTag.Voting, TxRedeemerTag.Proposing]);
const PLACEHOLDER = new CborUInt(TxRedeemerTag.Spend);

type Mutable = { tag: TxRedeemerTag };

function conwayTag(head: CborArray): number | undefined {
  const first = head.array[0];
  if (!(first instanceof CborUInt)) return undefined;
  const tag = Number(first.num);
  return CONWAY_TAGS.has(tag) ? tag : undefined;
}

// Swaps the tag in the parsed CBOR for the call only. The CBOR object keeps its byte reference.
function decodeWithPlaceholder(head: CborArray, decode: () => TxRedeemer): TxRedeemer {
  const tag = conwayTag(head);
  if (tag === undefined) return decode();
  const original = head.array[0];
  head.array[0] = PLACEHOLDER;
  try {
    const redeemer = decode();
    (redeemer as unknown as Mutable).tag = tag;
    return redeemer;
  } finally {
    head.array[0] = original;
  }
}

const PATCHED = Symbol.for('odatano.ledger-ts.redeemerTags');

/** Let `TxRedeemer` decode and clone Voting and Proposing redeemers. Once per process. */
export function installRedeemerTagPatch(): void {
  const cls = TxRedeemer as unknown as Record<symbol, boolean> & {
    fromCborObj(cObj: CborObj): TxRedeemer;
    fromCborMapEntry(entry: CborMapEntry): TxRedeemer;
  };
  if (cls[PATCHED]) return;
  const fromCborObj = cls.fromCborObj;
  const fromCborMapEntry = cls.fromCborMapEntry;
  const clone = TxRedeemer.prototype.clone;

  cls.fromCborObj = (cObj) =>
    cObj instanceof CborArray ? decodeWithPlaceholder(cObj, () => fromCborObj(cObj)) : fromCborObj(cObj);
  cls.fromCborMapEntry = (entry) =>
    entry?.k instanceof CborArray ? decodeWithPlaceholder(entry.k, () => fromCborMapEntry(entry)) : fromCborMapEntry(entry);
  TxRedeemer.prototype.clone = function (this: TxRedeemer): TxRedeemer {
    const self = this as unknown as Mutable;
    const tag = self.tag;
    if (!CONWAY_TAGS.has(tag)) return clone.call(this);
    self.tag = TxRedeemerTag.Spend;
    try {
      const copy = clone.call(this);
      (copy as unknown as Mutable).tag = tag;
      return copy;
    } finally {
      self.tag = tag;
    }
  };
  cls[PATCHED] = true;
}
