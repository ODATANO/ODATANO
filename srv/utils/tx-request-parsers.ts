import { validateJsonWithLimits, isTxHash, isAssetUnit, isValidCbor, isValidBech32Address, validateRequiredSigners } from './validators';
import type { JSONValue } from './types';

/**
 * Shared parsers for the Build*-action JSON payload fields. Used by the
 * synchronous CardanoTransactionService handlers AND the wallet-worker's
 * request transformation (srv/blockchain/wallet-worker/build-request.ts) so
 * both paths accept exactly the same payload shape.
 *
 * Result contract: { parsed } on success (undefined for absent/empty input →
 * no-op) or { error } with a caller-presentable message.
 */

export function parseUtxoRefArray(
  json: string | undefined,
  fieldName: 'forceInputsJson' | 'referenceInputsJson'
): { parsed?: Array<{ txHash: string; outputIndex: number }>; error?: string } {
  if (!json) return { parsed: undefined };
  const entryName = fieldName.replace(/Json$/, '');
  const jsonResult = validateJsonWithLimits(json, fieldName);
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: `${fieldName} must be a JSON array` };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  const refs: Array<{ txHash: string; outputIndex: number }> = [];
  for (const rawEntry of jsonResult.parsed) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      return { error: `Each ${entryName} entry must be an object with txHash and outputIndex` };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.txHash !== 'string' || !isTxHash(entry.txHash)) {
      return { error: `Each ${entryName} entry must have a valid 64-hex txHash` };
    }
    const idx = entry.outputIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      return { error: `Each ${entryName} entry must have a non-negative integer outputIndex` };
    }
    refs.push({ txHash: entry.txHash, outputIndex: idx });
  }
  return { parsed: refs };
}

/**
 * Parse and validate requiredSignersJson (array of 56-hex Ed25519 key hashes).
 * Same result contract as the other parse* helpers.
 */
export function parseRequiredSigners(
  requiredSignersJson: string | undefined
): { parsed?: string[]; error?: string } {
  if (!requiredSignersJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(requiredSignersJson, 'requiredSignersJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  try {
    return { parsed: validateRequiredSigners(jsonResult.parsed) };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse and validate an assetsJson array ({unit, quantity} entries) with the same
 * per-entry strictness as parseExtraOutputs — unchecked entries previously flowed
 * into the builder and surfaced as 500s.
 */
export function parseAssetsArray(
  assetsJson: string | undefined,
  fieldName: string
): { parsed?: Array<{ unit: string; quantity: string }>; error?: string } {
  if (!assetsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(assetsJson, fieldName);
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: `${fieldName} must be a JSON array` };
  const out: Array<{ unit: string; quantity: string }> = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const a = jsonResult.parsed[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object') {
      return { error: `${fieldName}[${i}] must be an object` };
    }
    if (typeof a.unit !== 'string' || a.unit.toLowerCase() === 'lovelace' || !isAssetUnit(a.unit)) {
      return { error: `${fieldName}[${i}].unit must be a valid asset unit (policyId + assetName hex)` };
    }
    if (typeof a.quantity !== 'string' || !/^\d+$/.test(a.quantity) || a.quantity === '0') {
      return { error: `${fieldName}[${i}].quantity must be a positive integer string` };
    }
    out.push({ unit: a.unit, quantity: a.quantity });
  }
  return { parsed: out };
}

/** Upper bound on extra outputs per transaction (defence against tx-size blow-up). */
export const MAX_EXTRA_OUTPUTS = 32;

export interface ParsedExtraOutput {
  address: string;
  lovelaceAmount: string;
  assets?: Array<{ unit: string; quantity: string }>;
  inlineDatum?: JSONValue;
  referenceScript?: string;
}

/**
 * Parse and validate extraOutputsJson. Returns { parsed } on success (possibly undefined
 * for empty array → no-op) or { error } on validation failure.
 */
export function parseExtraOutputs(
  extraOutputsJson: string | undefined
): { parsed?: ParsedExtraOutput[]; error?: string } {
  if (!extraOutputsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(extraOutputsJson, 'extraOutputsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'extraOutputsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  if (jsonResult.parsed.length > MAX_EXTRA_OUTPUTS) {
    return { error: `extraOutputsJson exceeds maximum of ${MAX_EXTRA_OUTPUTS} entries` };
  }

  const out: ParsedExtraOutput[] = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      return { error: `extraOutputs[${i}] must be an object` };
    }
    if (typeof entry.address !== 'string' || !isValidBech32Address(entry.address)) {
      return { error: `extraOutputs[${i}].address is not a valid Bech32 address` };
    }
    if (typeof entry.lovelaceAmount !== 'string' || !/^\d+$/.test(entry.lovelaceAmount) || entry.lovelaceAmount === '0') {
      return { error: `extraOutputs[${i}].lovelaceAmount must be a positive integer string` };
    }

    let assets: Array<{ unit: string; quantity: string }> | undefined;
    if (entry.assets !== undefined && entry.assets !== null) {
      if (!Array.isArray(entry.assets)) {
        return { error: `extraOutputs[${i}].assets must be an array` };
      }
      assets = [];
      for (let j = 0; j < entry.assets.length; j++) {
        const a = entry.assets[j] as Record<string, unknown>;
        if (!a || typeof a !== 'object') {
          return { error: `extraOutputs[${i}].assets[${j}] must be an object` };
        }
        if (typeof a.unit !== 'string' || a.unit.toLowerCase() === 'lovelace' || !isAssetUnit(a.unit)) {
          return { error: `extraOutputs[${i}].assets[${j}].unit must be a valid asset unit (policyId + assetName hex)` };
        }
        if (typeof a.quantity !== 'string' || !/^\d+$/.test(a.quantity) || a.quantity === '0') {
          return { error: `extraOutputs[${i}].assets[${j}].quantity must be a positive integer string` };
        }
        assets.push({ unit: a.unit, quantity: a.quantity });
      }
    }

    let inlineDatum: JSONValue | undefined;
    if (entry.inlineDatumJson !== undefined && entry.inlineDatumJson !== null) {
      if (typeof entry.inlineDatumJson !== 'string') {
        return { error: `extraOutputs[${i}].inlineDatumJson must be a JSON string` };
      }
      const datumResult = validateJsonWithLimits(entry.inlineDatumJson, `extraOutputs[${i}].inlineDatumJson`);
      if (!datumResult.valid) return { error: datumResult.error! };
      inlineDatum = datumResult.parsed as JSONValue;
    }

    let referenceScript: string | undefined;
    if (entry.referenceScriptHex !== undefined && entry.referenceScriptHex !== null) {
      if (typeof entry.referenceScriptHex !== 'string' || !isValidCbor(entry.referenceScriptHex)) {
        return { error: `extraOutputs[${i}].referenceScriptHex must be even-length hex` };
      }
      referenceScript = entry.referenceScriptHex;
    }

    out.push({
      address: entry.address,
      lovelaceAmount: entry.lovelaceAmount,
      assets,
      inlineDatum,
      referenceScript,
    });
  }
  return { parsed: out };
}

/**
 * Parse the optional PER-ACTION policy fields of a mintActionsJson entry
 * (multi-policy mint FR): `mintingPolicyScript` (CBOR hex, applied as-is; a
 * parameterized per-action script must be pre-applied by the caller) and
 * `redeemerJson` (a JSON-encoded string, same convention as extraOutputs'
 * inlineDatumJson). Absent fields fall back to the action's top-level
 * script/redeemer at build time.
 */
export function parseMintActionPolicyFields(
  entry: Record<string, unknown>,
  i: number
): { script?: string; redeemer?: JSONValue; error?: string } {
  let script: string | undefined;
  if (entry.mintingPolicyScript !== undefined && entry.mintingPolicyScript !== null) {
    if (typeof entry.mintingPolicyScript !== 'string' || !isValidCbor(entry.mintingPolicyScript)) {
      return { error: `mintActions[${i}].mintingPolicyScript must be even-length CBOR hex` };
    }
    script = entry.mintingPolicyScript;
  }
  let redeemer: JSONValue | undefined;
  if (entry.redeemerJson !== undefined && entry.redeemerJson !== null) {
    if (typeof entry.redeemerJson !== 'string') {
      return { error: `mintActions[${i}].redeemerJson must be a JSON string` };
    }
    const jsonResult = validateJsonWithLimits(entry.redeemerJson, `mintActions[${i}].redeemerJson`);
    if (!jsonResult.valid) return { error: jsonResult.error! };
    redeemer = jsonResult.parsed as JSONValue;
  }
  if (redeemer !== undefined && script === undefined) {
    return { error: `mintActions[${i}].redeemerJson requires mintActions[${i}].mintingPolicyScript` };
  }
  return { script, redeemer };
}
