import type { UTxO as OdatanoUtxo, JSONValue } from '../utils/types';
import { toHex, fromHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_256 } from '@harmoniclabs/crypto';
import { MixedAssetsError, InsufficientFundsError, BackendError, TransactionValidationError } from './errors';
import { ERROR_CODES } from './error-codes';
import { dataFromJson, dataToCbor, type Data } from '@harmoniclabs/plutus-data';
import { UPLCProgram, UPLCDecoder, Application, UPLCConst, compileUPLC } from '@harmoniclabs/uplc';
import { Cbor, CborArray, CborBytes, CborMap, CborUInt, CborTag, type CborObj } from '@harmoniclabs/cbor';
import { Address } from '@harmoniclabs/cardano-ledger-ts';

/** Lovelace amount of a UTxO. */
export function getLovelace(u: OdatanoUtxo): bigint {
  const entry = u.amount.find(a => (a.unit).toLowerCase() === "lovelace");
  return BigInt(entry?.quantity ?? "0");
}

/** Throws MixedAssetsError when the UTxO carries non-ADA assets. */
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
 * Transaction hash of a signed or unsigned tx CBOR: blake2b-256 over the body bytes, so witnesses do not affect it.
 * @returns 64-char hex string
 */
export function getTxHashFromCbor(txCbor: string): string {
  if (!txCbor || typeof txCbor !== 'string') {
    throw new Error('Invalid input: txCbor must be a non-empty string');
  }

  // Even length: an odd hex string would otherwise fail later as a confusing parse error
  if (!/^[a-fA-F0-9]+$/.test(txCbor) || txCbor.length % 2 !== 0) {
    throw new Error('Invalid input: txCbor must be a valid hex string');
  }

  // Hash the ORIGINAL body bytes via subCborRef (no re-serialization), so it matches what was signed
  try {
    const tx = Cbor.parse(fromHex(txCbor));
    if (!(tx instanceof CborArray) || tx.array.length < 1 || !tx.array[0].subCborRef) {
      throw new Error('not a transaction');
    }
    const bodyBytes = tx.array[0].subCborRef.toBuffer();
    return toHex(blake2b_256(bodyBytes));
  } catch (err: unknown) {
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
 * Consumed input refs and output addresses of a tx CBOR: the UTxO-cache rows a submit makes stale.
 * Outputs whose address bytes cannot be decoded (Byron) are skipped.
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

  // key 0: inputs, plain array or CBOR tag-258 set (Conway)
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

  // key 1: outputs, post-Alonzo map form ({0: address, ...}) or legacy array form ([address, amount, ...])
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
        // non-Shelley address bytes: nothing cached under a bech32 key
      }
    }
  }

  return { inputs, outputAddresses: [...outputAddresses] };
}

/**
 * Maps Buildooor errors to typed BackendErrors. Asset unit is parsed from "not enough <unit>" when not given;
 * `context` (e.g. the collateral partition) is appended to the consumer-facing message.
 */
export function mapBuilderError(err: unknown, assetUnit?: string, context?: string): never {
  // Typed errors keep their own status and payload
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
    // No amounts known here: surface the builder's own message instead of "required 0, available 0"
    throw new InsufficientFundsError(effectiveUnit, 0n, 0n, err,
      context ? `${rawMsg} (${context})` : rawMsg);
  }

  throw err;
}

/** Split an asset unit into policyId (56 hex chars) and assetName (remaining hex). */
export function parseAssetUnit(assetUnit: string): { policyId: string; assetName: string } {
  return {
    policyId: assetUnit.substring(0, 56),
    assetName: assetUnit.substring(56)
  };
}

/** Allowed keys in PlutusData JSON; anything else is stripped */
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

/** Normalize cardano-cli "constructor" to Buildooor "constr" recursively; strips unknown keys. */
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

/** JSON (`int` / `bytes` / `list` / `map` / `constructor`|`constr`) to Buildooor PlutusData. */
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
 * Backend inline datum to lowercase CBOR hex: hex string (Blockfrost), `{ bytes, value }` wrapper (Koios)
 * or raw PlutusData JSON. Returns null on unknown shapes instead of throwing.
 */
export function inlineDatumToHex(datum: unknown): string | null {
  if (datum === null || datum === undefined) return null;

  // Already hex CBOR
  if (typeof datum === 'string') {
    const s = datum.trim();
    if (!s) return null;
    return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 ? s.toLowerCase() : null;
  }

  if (typeof datum !== 'object' || Array.isArray(datum)) return null;

  const obj = datum as Record<string, unknown>;

  // Koios wrapper { bytes, value }; `value` distinguishes it from raw PlutusData { bytes }
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
 * Encode a script parameter as the UPLC constant of the type the validator expects: typed
 * `{ uplc: data|bytes|int|bool|unit, value }` for native-typed params, or a bare PlutusData object
 * (Aiken / CIP-57 convention) as shorthand for `uplc: "data"`.
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
  // Bare PlutusData: apply as Data
  return UPLCConst.data(jsonToPlutusData(param));
}

/**
 * Apply parameters to a parameterized PlutusV3 script (CBOR-wrapped flat UPLC): each parameter becomes a
 * UPLC Application around the program body, encoded via {@link encodeScriptParam}.
 * @returns CBOR hex of the applied script
 */
export function applyScriptParameters(scriptHex: string, params: JSONValue[]): string {
  if (!Array.isArray(params) || params.length === 0) {
    throw new Error('Script parameters must be a non-empty array');
  }

  // CBOR-unwrap to the flat UPLC bytes
  const cborObj = Cbor.parse(scriptHex) as CborBytes;
  const flatBytes = cborObj.bytes;

  const program = UPLCDecoder.parse(flatBytes, 'flat');

  let body = program.body;
  for (const param of params) {
    body = new Application(body, encodeScriptParam(param));
  }

  // Flat-encode the applied program and CBOR-wrap it again
  const applied = new UPLCProgram(program.version, body);
  const appliedFlatBytes = compileUPLC(applied);
  const cborEncoded = Cbor.encode(new CborBytes(appliedFlatBytes));
  return toHex(cborEncoded);
}