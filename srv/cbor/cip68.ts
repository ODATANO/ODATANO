import { dataFromCbor, DataConstr, DataI, DataB, DataMap } from '@harmoniclabs/plutus-data';

/** CIP-67 asset-name labels of the CIP-68 token classes, as the first 4 bytes of the asset name. */
export const CIP68_LABEL = {
  reference: '000643b0',
  nft: '000de140',
  ft: '0014df10',
  rft: '001bc280',
} as const;

/** Labels whose reference datum may carry `decimals`. */
const USER_LABELS_WITH_DECIMALS: readonly string[] = [CIP68_LABEL.ft, CIP68_LABEL.rft];

const labelOf = (unit: string): string => unit.slice(56, 64);

/** Reference-NFT unit of a CIP-68 user token with label 333 or 444; null for any other unit. */
export function cip68ReferenceUnit(unit: string): string | null {
  if (unit.length < 64 || !USER_LABELS_WITH_DECIMALS.includes(labelOf(unit))) return null;
  return unit.slice(0, 56) + CIP68_LABEL.reference + unit.slice(64);
}

/** The label-333 and label-444 units a CIP-68 reference NFT describes; null for any other unit. */
export function cip68UserUnits(referenceUnit: string): string[] | null {
  if (referenceUnit.length < 64 || labelOf(referenceUnit) !== CIP68_LABEL.reference) return null;
  return USER_LABELS_WITH_DECIMALS.map((label) => referenceUnit.slice(0, 56) + label + referenceUnit.slice(64));
}

const DECIMALS_KEY = Buffer.from('decimals');

// The datum is Constr 0 with the metadata map, keyed by UTF-8 bytes, as first field.
// Null when the shape differs or decimals is not an integer in 0..255.
export function cip68DecimalsFromDatum(cborHex: string): number | null {
  let data;
  try {
    data = dataFromCbor(cborHex);
  } catch {
    return null;
  }
  if (!(data instanceof DataConstr) || data.constr !== 0n) return null;
  const metadata = data.fields[0];
  if (!(metadata instanceof DataMap)) return null;
  for (const kv of metadata.map) {
    if (!(kv.fst instanceof DataB) || !DECIMALS_KEY.equals(Buffer.from(kv.fst.bytes))) continue;
    if (!(kv.snd instanceof DataI)) return null;
    const n = kv.snd.int;
    return n >= 0n && n <= 255n ? Number(n) : null;
  }
  return null;
}
