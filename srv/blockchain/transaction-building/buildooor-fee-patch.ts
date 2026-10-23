import { TxBuilder } from '@harmoniclabs/buildooor';
import { estimateMaxSignersNeeded } from '@harmoniclabs/buildooor/dist/TxBuilder/utils';
import { Tx, cborFromRational, defaultProtocolParameters, type ProtocolParameters } from '@harmoniclabs/cardano-ledger-ts';
import type { CanBeUInteger } from '@harmoniclabs/cardano-ledger-ts/dist/utils/ints';
import { referenceScriptSize } from '../../utils/reference-script';

/** Conway reference-script fee: the price per byte rises by 1.2 for every tier of this many bytes. */
export const REF_SCRIPT_TIER_BYTES = 25_600n;

export interface Rational {
  num: bigint;
  den: bigint;
}

/**
 * Reference-script fee as the ledger computes it: `totalBytes` priced tier by tier, each tier
 * 1.2 times the previous, exact rationals, floored once at the end.
 */
export function tierRefScriptFee(totalBytes: bigint, pricePerByte: Rational): bigint {
  let remaining = totalBytes;
  let priceNum = pricePerByte.num;
  let priceDen = pricePerByte.den;
  let accNum = 0n;
  let accDen = 1n;
  const add = (bytes: bigint): void => {
    accNum = accNum * priceDen + bytes * priceNum * accDen;
    accDen *= priceDen;
  };
  while (remaining >= REF_SCRIPT_TIER_BYTES) {
    add(REF_SCRIPT_TIER_BYTES);
    priceNum *= 6n;
    priceDen *= 5n;
    remaining -= REF_SCRIPT_TIER_BYTES;
  }
  add(remaining);
  return accNum / accDen;
}

/** Reference-script bytes of the inputs and reference inputs, not deduplicated, as the ledger counts them. */
export function refScriptBytesOf(tx: Tx): bigint {
  const utxos = [...tx.body.inputs, ...(tx.body.refInputs ?? [])];
  return utxos.reduce((sum, u) => sum + BigInt(u.resolved.refScript ? referenceScriptSize(u.resolved.refScript) : 0), 0n);
}

function refScriptPrice(pp: ProtocolParameters): Rational {
  const r = cborFromRational(pp.minfeeRefScriptCostPerByte ?? defaultProtocolParameters.minfeeRefScriptCostPerByte);
  return { num: BigInt(r.num), den: BigInt(r.den) };
}

interface TxBuilderInternals {
  protocolParamters: ProtocolParameters;
  calcLinearFee(tx: Tx): bigint;
}

/**
 * `TxBuilder.calcMinFee` with the ledger's reference-script rule. Buildooor 0.2.9 prices only the
 * reference inputs, linearly; the ledger also counts scripts on spent inputs and prices in tiers.
 * The rest (linear fee, estimated key witnesses) is Buildooor's own arithmetic.
 */
function calcMinFeeWithRefScripts(this: TxBuilder, tx: Tx, minimum?: CanBeUInteger): bigint {
  const self = this as unknown as TxBuilderInternals;
  const pp = self.protocolParamters;
  const perByte = BigInt(pp.txFeePerByte ?? defaultProtocolParameters.txFeePerByte);
  const nVkeyWits = BigInt(estimateMaxSignersNeeded(tx));
  const minFee = self.calcLinearFee(tx)
    + tierRefScriptFee(refScriptBytesOf(tx), refScriptPrice(pp))
    // one key witness is 102 CBOR bytes plus 2 for encoding slack, plus the array header
    + 104n * nVkeyWits * perByte
    + BigInt(nVkeyWits < 24n ? 1 : nVkeyWits < 256n ? 2 : 4) * perByte;
  if (minimum === undefined || minimum === null) return minFee;
  const min = BigInt(minimum);
  return minFee < min ? min : minFee;
}

const PATCHED = Symbol.for('odatano.buildooor.refScriptFee');

/** Replace `TxBuilder.prototype.calcMinFee` once per process. */
export function installReferenceScriptFeePatch(): void {
  const proto = TxBuilder.prototype as unknown as Record<symbol, boolean> & { calcMinFee: typeof calcMinFeeWithRefScripts };
  if (proto[PATCHED]) return;
  proto.calcMinFee = calcMinFeeWithRefScripts;
  proto[PATCHED] = true;
}
