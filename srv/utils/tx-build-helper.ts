import type { UTxO as OdatanoUtxo, JSONValue } from '../utils/types';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { toHex } from '@harmoniclabs/uint8array-utils';
import { MixedAssetsError, InsufficientFundsError } from './errors';
import { dataFromJson, type Data } from '@harmoniclabs/plutus-data';
import { UPLCProgram, UPLCDecoder, Application, UPLCConst, compileUPLC } from '@harmoniclabs/uplc';
import { Cbor, CborBytes } from '@harmoniclabs/cbor';

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

  // Validate hex format
  if (!/^[a-fA-F0-9]+$/.test(txCbor)) {
    throw new Error('Invalid input: txCbor must be a valid hex string');
  }

  // Use CSL.FixedTransaction: preserves original CBOR bytes (deterministic hash)
  // and avoids the harmoniclabs AuxiliaryData.fromCbor bug on metadata-only aux_data.
  try {
    const txBytes = Buffer.from(txCbor, 'hex');
    const fixedTx = CSL.FixedTransaction.from_bytes(txBytes);
    return Buffer.from(fixedTx.transaction_hash().to_bytes()).toString('hex');
  } catch {
    throw new Error('Failed to parse transaction CBOR');
  }
}

/**
 * Maps builder errors to typed BackendErrors
 * Shared between CSL and Buildooor transaction builders.
 * When no assetUnit is provided, extracts it from the error message if possible
 * (e.g. "not enough <policyId.assetName>"), falling back to 'lovelace'.
 * @param err Error from builder
 * @param assetUnit Optional asset unit override (auto-extracted from error message if omitted)
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: any, assetUnit?: string): never {
  const msg = (err?.message || err?.toString?.() || String(err)).toLowerCase();

  if (msg.includes('not enough') ||
      msg.includes('insufficient') ||
      msg.includes('balance')) {
    const effectiveUnit = assetUnit ?? (() => {
      const match = msg.match(/not enough\s+([a-f0-9.]+)/i);
      return match?.[1] || 'lovelace';
    })();
    throw new InsufficientFundsError(effectiveUnit, 0n, 0n, err);
  }

  throw err;
}

/**
 * Parse asset unit string into policyId and assetName
 * Format: policyId (56 hex chars) + assetName (remaining hex)
 * Shared between CSL and Buildooor transaction builders
 */
export function parseAssetUnit(assetUnit: string): { policyId: string; assetName: string } {
  return {
    policyId: assetUnit.substring(0, 56),
    assetName: assetUnit.substring(56)
  };
}

/**
 * Parse optional JSON string, returning undefined if not provided.
 * Throws with a descriptive message on parse failure.
 */
export function parseOptionalJson(json: string | undefined, fieldName: string): any | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
}

/**
 * Parse optional JSON string that must be an array.
 * Returns undefined if not provided, throws on invalid JSON or non-array.
 */
export function parseOptionalJsonArray(json: string | undefined, fieldName: string): any[] | undefined {
  if (!json) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON array`);
  }
  return parsed;
}

/** Allowed keys in PlutusData JSON — strip anything else for defense-in-depth */
const PLUTUS_DATA_ALLOWED_KEYS = new Set([
  'constructor', 'constr', 'fields', 'int', 'bytes', 'list', 'map', 'k', 'v'
]);

/** Strip keys not in the PlutusData whitelist */
function sanitizePlutusKeys(obj: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
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
function normalizeConstructorKey(obj: Record<string, any>): Record<string, any> {
  const safe = sanitizePlutusKeys(obj);
  if (Object.hasOwn(safe, 'constructor') && !Object.hasOwn(safe, 'constr')) {
    const result: Record<string, any> = { constr: safe.constructor };
    if (Array.isArray(safe.fields)) {
      result.fields = safe.fields.map((f: any) =>
        typeof f === 'object' && f !== null && !Array.isArray(f) ? normalizeConstructorKey(f) : f
      );
    }
    return result;
  }
  if ('list' in safe && Array.isArray(safe.list)) {
    return { list: safe.list.map((item: any) =>
      typeof item === 'object' && item !== null && !Array.isArray(item) ? normalizeConstructorKey(item) : item
    )};
  }
  if ('map' in safe && Array.isArray(safe.map)) {
    return { map: safe.map.map((entry: any) => ({
      k: typeof entry.k === 'object' && entry.k !== null ? normalizeConstructorKey(entry.k) : entry.k,
      v: typeof entry.v === 'object' && entry.v !== null ? normalizeConstructorKey(entry.v) : entry.v,
    }))};
  }
  if ('constr' in safe && Array.isArray(safe.fields)) {
    return { constr: safe.constr, fields: safe.fields.map((f: any) =>
      typeof f === 'object' && f !== null && !Array.isArray(f) ? normalizeConstructorKey(f) : f
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
 * Apply parameters to a parameterized PlutusV3 script (CBOR-wrapped flat UPLC).
 * Each parameter is applied as a successive UPLC Application node wrapping the program body.
 * @param scriptHex CBOR hex of the unapplied Plutus script (as output by Aiken/Plutus compilers)
 * @param params Array of PlutusData JSON objects (DetailedSchema format) to apply in order
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

  // 3. Apply each parameter as Application(body, UPLCConst.data(paramData))
  let body = program.body;
  for (const param of params) {
    const paramData = jsonToPlutusData(param);
    body = new Application(body, UPLCConst.data(paramData));
  }

  // 4. Create new program with applied body, flat-encode, CBOR-wrap
  const applied = new UPLCProgram(program.version, body);
  const appliedFlatBytes = compileUPLC(applied);
  const cborEncoded = Cbor.encode(new CborBytes(appliedFlatBytes));
  return toHex(cborEncoded);
}