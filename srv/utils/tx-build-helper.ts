import type { UTxO as OdatanoUtxo, JSONValue } from '../utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';
import { MixedAssetsError, InsufficientFundsError } from './errors';
import { dataFromJson, type Data } from '@harmoniclabs/plutus-data';

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
 * Extract transaction hash from signed CBOR without submitting
 * @param signedTxCbor signed transaction in CBOR hex format
 * @returns {string} transaction hash (64 character hex string)
 * @throws {Error} if CBOR is invalid or transaction hash cannot be extracted
 */
export function getTxHashFromCbor(signedTxCbor: string): string {
  if (!signedTxCbor || typeof signedTxCbor !== 'string') {
    throw new Error('Invalid input: signedTxCbor must be a non-empty string');
  }

  // Validate hex format
  if (!/^[a-fA-F0-9]+$/.test(signedTxCbor)) {
    throw new Error('Invalid input: signedTxCbor must be a valid hex string');
  }

  let tx;
  try {
    const txBytes = fromHex(signedTxCbor);
    tx = Tx.fromCbor(txBytes);
  } catch {
    throw new Error('Failed to parse transaction CBOR');
  }

  if (!tx?.hash) {
    throw new Error('Failed to extract transaction hash from CBOR');
  }

  return tx.hash.toString();
}

/**
 * Maps builder errors to typed BackendErrors
 * Shared between CSL and Buildooor transaction builders
 * @param err Error from builder
 * @param assetUnit Asset unit that caused the error (default: 'lovelace')
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: any, assetUnit: string = 'lovelace'): never {
  const msg = (err?.message || err?.toString?.() || String(err)).toLowerCase();

  if (msg.includes('not enough') ||
      msg.includes('insufficient') ||
      msg.includes('balance')) {
    throw new InsufficientFundsError(assetUnit, 0n, 0n, err);
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
 * Normalize PlutusData JSON from cardano-cli format ("constructor") to
 * Buildooor format ("constr"), recursively through fields/list/map.
 */
function normalizeConstructorKey(obj: Record<string, any>): Record<string, any> {
  if (Object.hasOwn(obj, 'constructor') && !Object.hasOwn(obj, 'constr')) {
    const result: Record<string, any> = { constr: obj.constructor };
    if (Array.isArray(obj.fields)) {
      result.fields = obj.fields.map((f: any) =>
        typeof f === 'object' && f !== null && !Array.isArray(f) ? normalizeConstructorKey(f) : f
      );
    }
    return result;
  }
  if ('list' in obj && Array.isArray(obj.list)) {
    return { list: obj.list.map((item: any) =>
      typeof item === 'object' && item !== null && !Array.isArray(item) ? normalizeConstructorKey(item) : item
    )};
  }
  if ('map' in obj && Array.isArray(obj.map)) {
    return { map: obj.map.map((entry: any) => ({
      k: typeof entry.k === 'object' && entry.k !== null ? normalizeConstructorKey(entry.k) : entry.k,
      v: typeof entry.v === 'object' && entry.v !== null ? normalizeConstructorKey(entry.v) : entry.v,
    }))};
  }
  if ('constr' in obj && Array.isArray(obj.fields)) {
    return { constr: obj.constr, fields: obj.fields.map((f: any) =>
      typeof f === 'object' && f !== null && !Array.isArray(f) ? normalizeConstructorKey(f) : f
    )};
  }
  return obj;
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