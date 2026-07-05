import type { UTxO as OdatanoUtxo, JSONValue } from '../utils/types';
import { toHex, fromHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_256 } from '@harmoniclabs/crypto';
import { MixedAssetsError, InsufficientFundsError, BackendError, TransactionValidationError } from './errors';
import { ERROR_CODES } from './error-codes';
import { dataFromJson, dataToCbor, type Data } from '@harmoniclabs/plutus-data';
import { UPLCProgram, UPLCDecoder, Application, UPLCConst, compileUPLC } from '@harmoniclabs/uplc';
import { Cbor, CborArray, CborBytes, CborMap, CborUInt, CborTag, type CborObj } from '@harmoniclabs/cbor';
import { Address } from '@harmoniclabs/cardano-ledger-ts';

/**
 * Extract lovelace amount from UTxO
 * @param u UTxO to extract from
 * @returns {bigint} lovelace amount
 */
export function getLovelace(u: OdatanoUtxo): bigint {
  const entry = u.amount.find(a => (a.unit).toLowerCase() === "lovelace");
  return BigInt(entry?.quantity ?? "0");
}

/**
 * Assert that UTxO contains only ADA (lovelace)
 * @param u UTxO to check
 * @throws {MixedAssetsError} if UTxO contains non-ADA assets
 */
export function assertAdaOnly(u: OdatanoUtxo): void {
  const nonAda = u.amount.filter(a => (a.unit).toLowerCase() !== "lovelace" && BigInt(a.quantity) !== 0n);
  if (nonAda.length > 0) {
    throw new MixedAssetsError(
      `${u.txHash}#${u.outputIndex}`,
      nonAda.map(a => a.unit)
    );
  }
}

/**
 * Extract transaction hash from a transaction CBOR (signed or unsigned).
 * Hash is computed over the body, so witness presence does not affect it.
 * @param txCbor transaction in CBOR hex format
 * @returns {string} transaction hash (64 character hex string)
 * @throws {Error} if CBOR is invalid or transaction hash cannot be extracted
 */
export function getTxHashFromCbor(txCbor: string): string {
  if (!txCbor || typeof txCbor !== 'string') {
    throw new Error('Invalid input: txCbor must be a non-empty string');
  }

  // Validate hex format. Require even length — a hex byte string encodes whole bytes,
  // so an odd-length string is malformed and would otherwise surface as a confusing
  // "Failed to parse transaction CBOR" from fromHex/Cbor.parse rather than a clear
  // input-validation error.
  if (!/^[a-fA-F0-9]+$/.test(txCbor) || txCbor.length % 2 !== 0) {
    throw new Error('Invalid input: txCbor must be a valid hex string');
  }

  // Compute blake2b-256 over the ORIGINAL transaction-body bytes (CBOR array index 0).
  // subCborRef.toBuffer() returns the exact bytes as received — no re-serialization, so
  // the hash matches what was signed. Working at the raw-CBOR level also sidesteps the
  // @harmoniclabs/cardano-ledger-ts AuxiliaryData.fromCbor bug on metadata-only aux_data
  // (we never instantiate the high-level Tx type).
  try {
    const tx = Cbor.parse(fromHex(txCbor));
    if (!(tx instanceof CborArray) || tx.array.length < 1 || !tx.array[0].subCborRef) {
      throw new Error('not a transaction');
    }
    const bodyBytes = tx.array[0].subCborRef.toBuffer();
    return toHex(blake2b_256(bodyBytes));
  } catch (err: unknown) {
    // typed 400 — a plain Error here surfaced as a 500 to the consumer
    throw new TransactionValidationError('Failed to parse transaction CBOR', err, ERROR_CODES.TX_PARSE_FAILED);
  }
}

/** Cache-invalidation targets of a submitted transaction (see extractTxCacheTargets). */
export interface TxCacheTargets {
  /** UTxO refs consumed by the transaction (now spent). */
  inputs: Array<{ txHash: string; outputIndex: number }>;
  /** Distinct bech32 addresses receiving outputs (sender change + recipients). */
  outputAddresses: string[];
}

/**
 * Extract the consumed input refs and the output addresses from a transaction
 * CBOR (signed or unsigned) — the rows a successful submit makes stale in the
 * UTxO cache. Works at the raw-CBOR level for the same reason as
 * getTxHashFromCbor (the high-level Tx.fromCbor rejects its own tag-259
 * AuxiliaryData builds).
 *
 * Outputs whose address bytes cannot be decoded (e.g. Byron bootstrap
 * addresses) are skipped — invalidation is best-effort per address.
 *
 * @param txCbor transaction in CBOR hex format
 * @throws {TransactionValidationError} if the CBOR is not a transaction
 */
export function extractTxCacheTargets(txCbor: string): TxCacheTargets {
  let body: CborMap;
  try {
    const tx = Cbor.parse(fromHex(txCbor));
    if (!(tx instanceof CborArray) || !(tx.array[0] instanceof CborMap)) {
      throw new Error('not a transaction');
    }
    body = tx.array[0];
  } catch (err: unknown) {
    throw new TransactionValidationError('Failed to parse transaction CBOR', err, ERROR_CODES.TX_PARSE_FAILED);
  }

  const bodyValue = (key: number): CborObj | undefined =>
    body.map.find(e => e.k instanceof CborUInt && e.k.num === BigInt(key))?.v;

  // key 0: inputs — plain array or a CBOR tag-258 set (Conway)
  const inputs: TxCacheTargets['inputs'] = [];
  let inputsObj = bodyValue(0);
  if (inputsObj instanceof CborTag) inputsObj = inputsObj.data;
  if (inputsObj instanceof CborArray) {
    for (const entry of inputsObj.array) {
      if (
        entry instanceof CborArray &&
        entry.array[0] instanceof CborBytes &&
        entry.array[1] instanceof CborUInt
      ) {
        inputs.push({ txHash: toHex(entry.array[0].bytes), outputIndex: Number(entry.array[1].num) });
      }
    }
  }

  // key 1: outputs — post-alonzo map form ({0: address, ...}) or legacy array form ([address, amount, ...])
  const outputAddresses = new Set<string>();
  const outputsObj = bodyValue(1);
  if (outputsObj instanceof CborArray) {
    for (const output of outputsObj.array) {
      const addrObj = output instanceof CborMap
        ? output.map.find(e => e.k instanceof CborUInt && e.k.num === 0n)?.v
        : output instanceof CborArray ? output.array[0] : undefined;
      if (!(addrObj instanceof CborBytes)) continue;
      try {
        outputAddresses.add(Address.fromBuffer(addrObj.bytes).toString());
      } catch {
        // non-Shelley address bytes — nothing cached under a bech32 key for it
      }
    }
  }

  return { inputs, outputAddresses: [...outputAddresses] };
}

/**
 * Maps builder errors to typed BackendErrors
 * Used by the Buildooor transaction builder.
 * When no assetUnit is provided, extracts it from the error message if possible
 * (e.g. "not enough <policyId.assetName>"), falling back to 'lovelace'.
 * @param err Error from builder
 * @param assetUnit Optional asset unit override (auto-extracted from error message if omitted)
 * @param context Optional build-flow context (e.g. the collateral/funding partition)
 *                appended to the consumer-facing message — the builder's own message
 *                has no way of knowing it
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: unknown, assetUnit?: string, context?: string): never {
  // Already-typed errors carry their own status + payload (amounts, asset units,
  // validation details) — re-wrapping them into a generic InsufficientFundsError
  // because their MESSAGE happens to contain "balance"/"insufficient" destroys that.
  if (err instanceof BackendError) {
    throw err;
  }

  const errObj = err as { message?: string; toString?: () => string } | null;
  const rawMsg = errObj?.message || errObj?.toString?.() || String(err);
  const msg = rawMsg.toLowerCase();

  if (msg.includes('not enough') ||
      msg.includes('insufficient') ||
      msg.includes('balance')) {
    const effectiveUnit = assetUnit ?? (() => {
      const match = msg.match(/not enough\s+([a-f0-9.]+)/i);
      return match?.[1] || 'lovelace';
    })();
    // The builder knows no amounts here — surface its own message (plus the build
    // context) instead of a meaningless "required 0, available 0".
    throw new InsufficientFundsError(effectiveUnit, 0n, 0n, err,
      context ? `${rawMsg} (${context})` : rawMsg);
  }

  throw err;
}

/**
 * Parse asset unit string into policyId and assetName
 * Format: policyId (56 hex chars) + assetName (remaining hex)
 * Used by the Buildooor transaction builder
 */
export function parseAssetUnit(assetUnit: string): { policyId: string; assetName: string } {
  return {
    policyId: assetUnit.substring(0, 56),
    assetName: assetUnit.substring(56)
  };
}

/** Allowed keys in PlutusData JSON — strip anything else for defense-in-depth */
const PLUTUS_DATA_ALLOWED_KEYS = new Set([
  'constructor', 'constr', 'fields', 'int', 'bytes', 'list', 'map', 'k', 'v'
]);

/** Strip keys not in the PlutusData whitelist */
function sanitizePlutusKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (PLUTUS_DATA_ALLOWED_KEYS.has(key)) {
      clean[key] = obj[key];
    }
  }
  return clean;
}

/**
 * Normalize PlutusData JSON from cardano-cli format ("constructor") to
 * Buildooor format ("constr"), recursively through fields/list/map.
 * Also strips unrecognized keys for safety.
 */
function normalizeConstructorKey(obj: Record<string, unknown>): Record<string, unknown> {
  const safe = sanitizePlutusKeys(obj);
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Object.hasOwn(safe, 'constructor') && !Object.hasOwn(safe, 'constr')) {
    const result: Record<string, unknown> = { constr: safe.constructor };
    if (Array.isArray(safe.fields)) {
      result.fields = (safe.fields as unknown[]).map((f) =>
        isObj(f) ? normalizeConstructorKey(f) : f
      );
    }
    return result;
  }
  if ('list' in safe && Array.isArray(safe.list)) {
    return { list: (safe.list as unknown[]).map((item) =>
      isObj(item) ? normalizeConstructorKey(item) : item
    )};
  }
  if ('map' in safe && Array.isArray(safe.map)) {
    return { map: (safe.map as Array<{ k: unknown; v: unknown }>).map((entry) => ({
      k: isObj(entry.k) ? normalizeConstructorKey(entry.k) : entry.k,
      v: isObj(entry.v) ? normalizeConstructorKey(entry.v) : entry.v,
    }))};
  }
  if ('constr' in safe && Array.isArray(safe.fields)) {
    return { constr: safe.constr, fields: (safe.fields as unknown[]).map((f) =>
      isObj(f) ? normalizeConstructorKey(f) : f
    )};
  }
  return safe;
}

/**
 * Convert JSON value to Buildooor PlutusData (Data type).
 * Accepts both cardano-cli format ("constructor") and Buildooor format ("constr").
 * - { "int": 42 } → DataI(42)
 * - { "bytes": "deadbeef" } → DataB("deadbeef")
 * - { "list": [...] } → DataList([...])
 * - { "map": [{ "k": ..., "v": ... }] } → DataMap([...])
 * - { "constructor": 0, "fields": [...] } or { "constr": 0, "fields": [...] } → DataConstr(0, [...])
 * @param json JSON value representing PlutusData
 * @returns Buildooor Data object
 */
export function jsonToPlutusData(json: JSONValue): Data {
  if (json === null || json === undefined) {
    throw new Error('PlutusData JSON cannot be null or undefined');
  }
  if (typeof json === 'object' && !Array.isArray(json)) {
    const normalized = normalizeConstructorKey(json as Record<string, any>);
    return dataFromJson(normalized);
  }
  throw new Error(`Unsupported PlutusData JSON format: expected an object with "int", "bytes", "list", "map", or "constructor" key`);
}

/**
 * Normalize a backend-provided inline datum to canonical CBOR hex.
 *
 * Backends report inline datums in different shapes:
 * - Blockfrost: hex CBOR string (e.g. "19a6aa")
 * - Koios (_extended): wrapper { bytes: "<hex>", value: { ...PlutusData JSON... } }
 * - Koios (sometimes empty): { bytes: null, value: null }
 * - Some endpoints: raw PlutusData JSON ({ "int": 42 } / { "constructor": 0, "fields": [] })
 *
 * Returns hex CBOR (lowercase) or null. Defensive: returns null on unknown
 * shapes rather than throwing — backend mappers must not crash on malformed data.
 */
export function inlineDatumToHex(datum: unknown): string | null {
  if (datum === null || datum === undefined) return null;

  // Already hex CBOR (Blockfrost path, or pre-normalized)
  if (typeof datum === 'string') {
    const s = datum.trim();
    if (!s) return null;
    return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 ? s.toLowerCase() : null;
  }

  if (typeof datum !== 'object' || Array.isArray(datum)) return null;

  const obj = datum as Record<string, unknown>;

  // Koios wrapper: { bytes: "<hex>", value: <PlutusData JSON> }.
  // Distinguished from raw PlutusData {bytes:"deadbeef"} by the presence of `value`.
  if ('value' in obj && typeof obj.bytes === 'string' && obj.bytes.length > 0) {
    const hex = obj.bytes.trim();
    return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 ? hex.toLowerCase() : null;
  }

  // Koios empty wrapper: all top-level values null
  if ('value' in obj || ('bytes' in obj && obj.bytes === null)) {
    const vals = Object.values(obj);
    if (vals.length > 0 && vals.every(v => v === null)) return null;
  }

  // Raw PlutusData JSON (DetailedSchema or Buildooor "constr" form)
  try {
    const data = jsonToPlutusData(datum as JSONValue);
    return Buffer.from(dataToCbor(data) as unknown as Uint8Array).toString('hex');
  } catch {
    return null;
  }
}

/** UPLC type tag for a typed script parameter (see {@link encodeScriptParam}). */
export type ScriptParamUplcType = 'data' | 'bytes' | 'int' | 'bool' | 'unit';

/**
 * Encode a single script parameter into the UPLC constant the parameterized
 * script expects.
 *
 * A script parameter is applied as a UPLC constant whose TYPE must match what
 * the compiled validator expects for that parameter. Two input shapes are
 * accepted:
 *
 *  1. Typed — `{ "uplc": "<type>", "value": <...> }`:
 *       - `"data"`  → `UPLCConst.data(...)`        value: PlutusData JSON ("constr"/cardano-cli form)
 *       - `"bytes"` → `UPLCConst.byteString(...)`  value: even-length hex string
 *       - `"int"`   → `UPLCConst.int(...)`         value: number | numeric string
 *       - `"bool"`  → `UPLCConst.bool(...)`        value: boolean
 *       - `"unit"`  → `UPLCConst.unit`             value: omitted
 *     Required for compilers whose scalar params are NATIVE-typed rather than
 *     Data-wrapped (e.g. Pebble: `param x: PubKeyHash` expects a native
 *     `bytestring`, not a `Data` bytestring).
 *
 *  2. Bare PlutusData object (e.g. `{ "bytes": "ab.." }`, `{ "constructor": 0, ... }`)
 *     — shorthand for `{ "uplc": "data", "value": <object> }`. This is the
 *     Aiken / CIP-57 blueprint convention, where every parameter is Data.
 */
export function encodeScriptParam(param: JSONValue): UPLCConst {
  if (
    param !== null &&
    typeof param === 'object' &&
    !Array.isArray(param) &&
    'uplc' in (param as Record<string, unknown>)
  ) {
    const { uplc, value } = param as { uplc: unknown; value?: JSONValue };
    switch (uplc) {
      case 'data':
        return UPLCConst.data(jsonToPlutusData(value as JSONValue));
      case 'bytes': {
        if (typeof value !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(value)) {
          throw new Error('Script param of uplc type "bytes" requires an even-length hex string "value"');
        }
        return UPLCConst.byteString(fromHex(value));
      }
      case 'int': {
        if (typeof value !== 'number' && typeof value !== 'string') {
          throw new Error('Script param of uplc type "int" requires a number or numeric-string "value"');
        }
        let n: bigint;
        try {
          n = BigInt(value as string | number);
        } catch {
          throw new Error(`Script param of uplc type "int" has a non-integer "value": ${String(value)}`);
        }
        return UPLCConst.int(n);
      }
      case 'bool': {
        if (typeof value !== 'boolean') {
          throw new Error('Script param of uplc type "bool" requires a boolean "value"');
        }
        return UPLCConst.bool(value);
      }
      case 'unit':
        return UPLCConst.unit;
      default:
        throw new Error(`Unknown script param uplc type "${String(uplc)}"; expected one of: data, bytes, int, bool, unit`);
    }
  }
  // Bare PlutusData → apply as Data (Aiken / blueprint convention)
  return UPLCConst.data(jsonToPlutusData(param));
}

/**
 * Apply parameters to a parameterized PlutusV3 script (CBOR-wrapped flat UPLC).
 * Each parameter becomes a successive UPLC Application wrapping the program body.
 *
 * Parameters are applied in their declared UPLC type via {@link encodeScriptParam}:
 * pass `{ uplc, value }` entries for native-typed params (e.g. Pebble scalars),
 * or bare PlutusData objects for the Data convention (Aiken / CIP-57 blueprints).
 *
 * @param scriptHex CBOR hex of the unapplied Plutus script (as output by Aiken/Pebble/Plutus compilers)
 * @param params Array of script parameters (typed `{uplc,value}` and/or bare PlutusData JSON) to apply in order
 * @returns CBOR hex of the applied script (ready for transaction building)
 */
export function applyScriptParameters(scriptHex: string, params: JSONValue[]): string {
  if (!Array.isArray(params) || params.length === 0) {
    throw new Error('Script parameters must be a non-empty array');
  }

  // 1. CBOR-decode script hex → get inner flat UPLC bytes
  const cborObj = Cbor.parse(scriptHex) as CborBytes;
  const flatBytes = cborObj.bytes;

  // 2. Flat-decode → UPLCProgram
  const program = UPLCDecoder.parse(flatBytes, 'flat');

  // 3. Apply each parameter as Application(body, <typed UPLC constant>)
  let body = program.body;
  for (const param of params) {
    body = new Application(body, encodeScriptParam(param));
  }

  // 4. Create new program with applied body, flat-encode, CBOR-wrap
  const applied = new UPLCProgram(program.version, body);
  const appliedFlatBytes = compileUPLC(applied);
  const cborEncoded = Cbor.encode(new CborBytes(appliedFlatBytes));
  return toHex(cborEncoded);
}