import { normalizeITxBuildInput, forceBigUInt, type CanBeUInteger, type ITxBuildInput } from "@harmoniclabs/buildooor";
import { UTxO, Value, type ValueUnits } from "@harmoniclabs/cardano-ledger-ts";

/**
 * Coin selection ("keep relevant" strategy) — vendored fix for
 * @harmoniclabs/buildooor 0.2.6 (HarmonicLabs/buildooor PR #12).
 *
 * The shipped `TxBuilder.keepRelevant` has several defects: the asset-relevance
 * filter matches lovelace too (whenever lovelace is requested, EVERY input counts
 * as a multi-asset match and the whole UTxO set is selected), the dedup between
 * the asset and lovelace selection phases compares only the tx id — not id#index,
 * so sibling outputs of one transaction collapse and inputs get selected twice —
 * the lovelace sort goes through parseInt/number (breaks above 2^53), and
 * `enoughValueHasBeenSelected` has an operator-precedence bug that makes asset
 * sums meaningless.
 *
 * Vendored here (instead of patch-package) so the fix actually reaches consumers
 * of the published package: `patches/` never ships in the tarball, and running
 * patch-package from a dependency's postinstall is unreliable under npm hoisting.
 * Drop this module and call `txBuilder.keepRelevant` again once a buildooor
 * release contains the upstream PR.
 *
 * Semantics: select the inputs holding any requested non-lovelace asset, then add
 * smallest-first lovelace-relevant inputs until the requested lovelace (plus a
 * safety minimum for fee/change) is covered. Selection may still undershoot when
 * the pool itself is insufficient — Buildooor's build() surfaces that as its own
 * insufficient-funds error, exactly like the upstream implementation.
 */
export function keepRelevant(
  requestedOutputSet: Value | ValueUnits | Record<string, CanBeUInteger>,
  initialUTxOSet: ITxBuildInput[],
  minimumLovelaceRequired: CanBeUInteger = 5_000_000
): ITxBuildInput[] {
  const requested = normalizeRequestedOutputSet(requestedOutputSet);
  const requestedLovelace = (requested["lovelace"] ?? 0n) + forceBigUInt(minimumLovelaceRequired);
  const requestedAssetUnits = Object.keys(requested).filter(unit => unit !== "lovelace");

  const multiAssetIns = initialUTxOSet.filter(input =>
    new UTxO(input.utxo).resolved.value.toUnits()
      .filter(asset => asset.unit !== "lovelace")
      .some(asset => requestedAssetUnits.includes(asset.unit))
  );

  const totLovelaces = getTotLovelaces(multiAssetIns);
  const lovelaceIns = totLovelaces < requestedLovelace
    ? remainingLovelace(
      requestedLovelace - totLovelaces,
      // filter out inputs already picked by the multi-asset selection
      initialUTxOSet.filter(initialUtxo => {
        const refStr = utxoRefStr(initialUtxo);
        return !multiAssetIns.some(selected => utxoRefStr(selected) === refStr);
      })
    )
    : [];

  return lovelaceIns.concat(multiAssetIns).map(normalizeITxBuildInput);
}

/**
 * Tolerates `Value` instances from a duplicated `cardano-ledger-ts` in
 * node_modules, where `instanceof` fails across the two copies.
 */
function isValueLike(x: unknown): x is Value {
  return x instanceof Value ||
    (!Array.isArray(x) && typeof (x as { toUnits?: unknown } | null)?.toUnits === "function");
}

/**
 * `keepRelevant` historically accepted two shapes besides `Value`: the
 * `ValueUnits` array returned by `Value.toUnits()` and a Mesh-style
 * `{ [unit]: quantity }` record. Normalize all of them to a record with
 * `bigint` quantities so the algorithm only deals with one shape.
 */
function normalizeRequestedOutputSet(
  requested: Value | ValueUnits | Record<string, CanBeUInteger>
): Record<string, bigint> {
  const units = isValueLike(requested)
    ? requested.toUnits()
    : requested;

  const result: Record<string, bigint> = {};
  if (Array.isArray(units)) {
    for (const { unit, quantity } of units) {
      result[unit] = (result[unit] ?? 0n) + BigInt(quantity);
    }
    return result;
  }
  for (const unit of Object.keys(units)) {
    result[unit] = BigInt(units[unit]);
  }
  return result;
}

/** Full utxo ref (id#index) — the id alone collapses sibling outputs of one tx. */
function utxoRefStr(input: ITxBuildInput): string {
  const ref = input.utxo.utxoRef;
  return `${ref.id.toString()}#${ref.index.toString()}`;
}

function getTotLovelaces(inputs: ITxBuildInput[]): bigint {
  return inputs.reduce((sum, input) => sum + new UTxO(input.utxo).resolved.value.lovelaces, 0n);
}

function remainingLovelace(quantity: bigint, initialUTxOSet: ITxBuildInput[]): ITxBuildInput[] {
  // smallest-first, compared as bigint (a number sort breaks above 2^53 lovelace)
  const sortedUTxOs = initialUTxOSet.slice().sort((a, b) => {
    const aLovelaces = new UTxO(a.utxo).resolved.value.lovelaces;
    const bLovelaces = new UTxO(b.utxo).resolved.value.lovelaces;
    return aLovelaces < bLovelaces ? -1 : aLovelaces > bLovelaces ? 1 : 0;
  });
  return selectValue(sortedUTxOs, { lovelace: quantity });
}

function enoughValueHasBeenSelected(selection: ITxBuildInput[], assets: Record<string, bigint>): boolean {
  return Object.keys(assets).every(unit =>
    selection.reduce((selectedQuantity, input) => {
      const utxoQuantity = new UTxO(input.utxo).resolved.value.toUnits()
        .reduce((quantity, a) => quantity + (unit === a.unit ? BigInt(a.quantity) : 0n), 0n);
      return selectedQuantity + utxoQuantity;
    }, 0n) >= assets[unit]
  );
}

function selectValue(
  inputUTxO: ITxBuildInput[],
  outputSet: Record<string, bigint>,
  selection: ITxBuildInput[] = []
): ITxBuildInput[] {
  if (inputUTxO.length === 0 || enoughValueHasBeenSelected(selection, outputSet)) {
    return selection;
  }
  if (canValueBeSelected(inputUTxO[0], outputSet)) {
    return selectValue(inputUTxO.slice(1), outputSet, selection.concat(inputUTxO[0]));
  }
  return selectValue(inputUTxO.slice(1), outputSet, selection);
}

function canValueBeSelected(input: ITxBuildInput, assets: Record<string, bigint>): boolean {
  return Object.keys(assets).some(unit =>
    new UTxO(input.utxo).resolved.value.toUnits()
      .some(asset => asset.unit === unit)
  );
}
