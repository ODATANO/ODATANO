import { validateJsonWithLimits, validatePlutusJson, isTxHash, isAssetUnit, isValidCbor, isValidBech32Address, isValidBech32StakeAddress, validateRequiredSigners } from './validators';
import type { JSONValue, MintAction } from './types';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { dataFromCbor } from '@harmoniclabs/plutus-data';
import { MIN_FULL_ASSET_UNIT_LENGTH } from './const';

/**
 * Shared parsers for the Build*-action JSON payload fields (transaction service and wallet worker).
 * Result contract: `{ parsed }` on success (undefined for absent/empty input) or `{ error }` with a client message.
 */

/** PlutusData as CBOR hex, checked to decode; `field` names it in the error. */
export function parsePlutusCbor(value: unknown, field: string): { hex?: string; error?: string } {
  if (typeof value !== 'string' || !isValidCbor(value)) return { error: `${field} must be even-length CBOR hex` };
  try {
    dataFromCbor(value);
  } catch (err: unknown) {
    return { error: `${field} is not PlutusData CBOR: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { hex: value.toLowerCase() };
}

export function parseUtxoRefArray(
  json: string | undefined,
  fieldName: 'forceInputsJson' | 'referenceInputsJson' | 'protectInputsJson'
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

/** Parse and validate requiredSignersJson (array of 56-hex Ed25519 key hashes). */
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

/** Parse and validate an assetsJson array of `{unit, quantity}` entries. */
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
  /** Hash of a datum the output is locked with (hex, 32 bytes); `outputsJson` only. */
  datumHash?: string;
  /** Inline datum as PlutusData CBOR hex, taken byte for byte; `outputsJson` only. */
  inlineDatumCbor?: string;
  referenceScript?: string;
}

/** Parse and validate extraOutputsJson (undefined for an empty array). */
export function parseExtraOutputs(
  extraOutputsJson: string | undefined
): { parsed?: ParsedExtraOutput[]; error?: string } {
  return parseOutputList(extraOutputsJson, 'extraOutputsJson');
}

/**
 * Parse an output list. `outputsJson` (BuildPlutusTransaction) additionally accepts `datumHash`;
 * the entries keep their order, each is min-ADA checked by the builder.
 */
export function parseOutputList(
  json: string | undefined,
  fieldName: 'extraOutputsJson' | 'outputsJson'
): { parsed?: ParsedExtraOutput[]; error?: string } {
  if (!json) return { parsed: undefined };
  const name = fieldName.replace(/Json$/, '');
  const jsonResult = validateJsonWithLimits(json, fieldName);
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: `${fieldName} must be a JSON array` };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  if (jsonResult.parsed.length > MAX_EXTRA_OUTPUTS) {
    return { error: `${fieldName} exceeds maximum of ${MAX_EXTRA_OUTPUTS} entries` };
  }

  const out: ParsedExtraOutput[] = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      return { error: `${name}[${i}] must be an object` };
    }
    if (typeof entry.address !== 'string' || !isValidBech32Address(entry.address)) {
      return { error: `${name}[${i}].address is not a valid Bech32 address` };
    }
    if (typeof entry.lovelaceAmount !== 'string' || !/^\d+$/.test(entry.lovelaceAmount) || entry.lovelaceAmount === '0') {
      return { error: `${name}[${i}].lovelaceAmount must be a positive integer string` };
    }

    let assets: Array<{ unit: string; quantity: string }> | undefined;
    if (entry.assets !== undefined && entry.assets !== null) {
      if (!Array.isArray(entry.assets)) {
        return { error: `${name}[${i}].assets must be an array` };
      }
      assets = [];
      for (let j = 0; j < entry.assets.length; j++) {
        const a = entry.assets[j] as Record<string, unknown>;
        if (!a || typeof a !== 'object') {
          return { error: `${name}[${i}].assets[${j}] must be an object` };
        }
        if (typeof a.unit !== 'string' || a.unit.toLowerCase() === 'lovelace' || !isAssetUnit(a.unit)) {
          return { error: `${name}[${i}].assets[${j}].unit must be a valid asset unit (policyId + assetName hex)` };
        }
        if (typeof a.quantity !== 'string' || !/^\d+$/.test(a.quantity) || a.quantity === '0') {
          return { error: `${name}[${i}].assets[${j}].quantity must be a positive integer string` };
        }
        assets.push({ unit: a.unit, quantity: a.quantity });
      }
    }

    let inlineDatum: JSONValue | undefined;
    if (entry.inlineDatumJson !== undefined && entry.inlineDatumJson !== null) {
      if (typeof entry.inlineDatumJson !== 'string') {
        return { error: `${name}[${i}].inlineDatumJson must be a JSON string` };
      }
      const datumResult = validatePlutusJson(entry.inlineDatumJson, `${name}[${i}].inlineDatumJson`);
      if (!datumResult.valid) return { error: datumResult.error! };
      inlineDatum = datumResult.parsed as JSONValue;
    }

    let inlineDatumCbor: string | undefined;
    if (entry.inlineDatumCbor !== undefined && entry.inlineDatumCbor !== null) {
      if (fieldName !== 'outputsJson') return { error: `${name}[${i}].inlineDatumCbor is only supported in outputsJson` };
      if (inlineDatum !== undefined) return { error: `${name}[${i}] takes inlineDatumJson or inlineDatumCbor, not both` };
      const cbor = parsePlutusCbor(entry.inlineDatumCbor, `${name}[${i}].inlineDatumCbor`);
      if (cbor.error) return { error: cbor.error };
      inlineDatumCbor = cbor.hex;
    }

    let datumHash: string | undefined;
    if (entry.datumHash !== undefined && entry.datumHash !== null) {
      if (fieldName !== 'outputsJson') return { error: `${name}[${i}].datumHash is only supported in outputsJson` };
      if (typeof entry.datumHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(entry.datumHash)) {
        return { error: `${name}[${i}].datumHash must be 64 hex chars` };
      }
      if (inlineDatum !== undefined || inlineDatumCbor !== undefined) return { error: `${name}[${i}] takes an inline datum or datumHash, not both` };
      datumHash = entry.datumHash.toLowerCase();
    }

    let referenceScript: string | undefined;
    if (entry.referenceScriptHex !== undefined && entry.referenceScriptHex !== null) {
      if (typeof entry.referenceScriptHex !== 'string' || !isValidCbor(entry.referenceScriptHex)) {
        return { error: `${name}[${i}].referenceScriptHex must be even-length hex` };
      }
      referenceScript = entry.referenceScriptHex;
    }

    out.push({
      address: entry.address,
      lovelaceAmount: entry.lovelaceAmount,
      assets,
      inlineDatum,
      ...(datumHash ? { datumHash } : {}),
      ...(inlineDatumCbor ? { inlineDatumCbor } : {}),
      referenceScript,
    });
  }
  return { parsed: out };
}

/**
 * Parse the optional per-action policy fields of a mintActionsJson entry: `mintingPolicyScript` (CBOR hex,
 * applied as-is) and `redeemerJson` (JSON string). Absent fields fall back to the top-level script/redeemer.
 */
export function parseMintActionPolicyFields(
  entry: Record<string, unknown>,
  i: number,
  byReference = false
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
    const jsonResult = validatePlutusJson(entry.redeemerJson, `mintActions[${i}].redeemerJson`);
    if (!jsonResult.valid) return { error: jsonResult.error! };
    redeemer = jsonResult.parsed as JSONValue;
  }
  if (redeemer !== undefined && script === undefined && !byReference) {
    return { error: `mintActions[${i}].redeemerJson requires mintActions[${i}].mintingPolicyScript` };
  }
  return { script, redeemer };
}

/** Upper bound on script inputs per BuildPlutusTransaction. */
export const MAX_SCRIPT_INPUTS = 16;

/** One script UTxO of a BuildPlutusTransaction, validated; `validatorScript` still without params applied. */
export interface ParsedScriptInput {
  txHash: string;
  outputIndex: number;
  validatorScript?: string;
  scriptParams?: JSONValue[];
  referenceScript?: { txHash: string; outputIndex: number };
  redeemer: JSONValue;
  /** Redeemer as PlutusData CBOR hex (instead of redeemerJson), taken byte for byte. */
  redeemerCbor?: string;
  datum?: JSONValue;
  /** Datum preimage as PlutusData CBOR hex (instead of datumJson). */
  datumCbor?: string;
}

/** Parse and validate scriptInputsJson: 1..MAX_SCRIPT_INPUTS distinct script UTxOs, each with its own redeemer. */
export function parseScriptInputs(json: string | undefined): { parsed?: ParsedScriptInput[]; error?: string } {
  if (!json) return { error: 'scriptInputsJson is required' };
  const jsonResult = validateJsonWithLimits(json, 'scriptInputsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed) || jsonResult.parsed.length === 0) {
    return { error: 'scriptInputsJson must be a non-empty JSON array' };
  }
  if (jsonResult.parsed.length > MAX_SCRIPT_INPUTS) {
    return { error: `scriptInputsJson exceeds maximum of ${MAX_SCRIPT_INPUTS} entries` };
  }

  const parseJsonField = (value: unknown, field: string): { parsed?: JSONValue; error?: string } => {
    if (typeof value !== 'string') return { error: `${field} must be a JSON string` };
    const r = validatePlutusJson(value, field);
    return r.valid ? { parsed: r.parsed as JSONValue } : { error: r.error! };
  };

  const out: ParsedScriptInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    const at = `scriptInputs[${i}]`;
    if (!entry || typeof entry !== 'object') return { error: `${at} must be an object` };
    if (typeof entry.txHash !== 'string' || !isTxHash(entry.txHash)) return { error: `${at}.txHash must be 64 hex chars` };
    const idx = entry.outputIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return { error: `${at}.outputIndex must be a non-negative integer` };
    const key = `${entry.txHash.toLowerCase()}#${idx}`;
    if (seen.has(key)) return { error: `${at} spends ${key} a second time` };
    seen.add(key);

    const hasInline = entry.validatorScript !== undefined && entry.validatorScript !== null;
    const hasRef = entry.referenceScript !== undefined && entry.referenceScript !== null;
    if (hasInline === hasRef) return { error: `${at} needs exactly one of validatorScript or referenceScript` };

    const input: ParsedScriptInput = { txHash: entry.txHash.toLowerCase(), outputIndex: idx, redeemer: null };
    if (hasInline) {
      if (typeof entry.validatorScript !== 'string' || !isValidCbor(entry.validatorScript)) {
        return { error: `${at}.validatorScript must be even-length CBOR hex` };
      }
      input.validatorScript = entry.validatorScript;
      if (entry.scriptParamsJson !== undefined && entry.scriptParamsJson !== null) {
        const params = parseJsonField(entry.scriptParamsJson, `${at}.scriptParamsJson`);
        if (params.error) return { error: params.error };
        if (!Array.isArray(params.parsed)) return { error: `${at}.scriptParamsJson must be a JSON array` };
        if (params.parsed.length > 0) input.scriptParams = params.parsed;
      }
    } else {
      const ref = entry.referenceScript as Record<string, unknown>;
      if (!ref || typeof ref !== 'object' || typeof ref.txHash !== 'string' || !isTxHash(ref.txHash)
        || typeof ref.outputIndex !== 'number' || !Number.isInteger(ref.outputIndex) || ref.outputIndex < 0) {
        return { error: `${at}.referenceScript must be {txHash, outputIndex} of the UTxO carrying the script` };
      }
      if (entry.scriptParamsJson !== undefined && entry.scriptParamsJson !== null) {
        return { error: `${at}.scriptParamsJson applies to an inline validatorScript only` };
      }
      input.referenceScript = { txHash: ref.txHash.toLowerCase(), outputIndex: ref.outputIndex };
    }

    const hasRedeemerJson = entry.redeemerJson !== undefined && entry.redeemerJson !== null;
    const hasRedeemerCbor = entry.redeemerCbor !== undefined && entry.redeemerCbor !== null;
    if (hasRedeemerJson === hasRedeemerCbor) return { error: `${at} needs exactly one of redeemerJson or redeemerCbor` };
    if (hasRedeemerCbor) {
      const cbor = parsePlutusCbor(entry.redeemerCbor, `${at}.redeemerCbor`);
      if (cbor.error) return { error: cbor.error };
      input.redeemerCbor = cbor.hex;
    } else {
      const redeemer = parseJsonField(entry.redeemerJson, `${at}.redeemerJson`);
      if (redeemer.error) return { error: redeemer.error };
      input.redeemer = redeemer.parsed as JSONValue;
    }

    const hasDatumJson = entry.datumJson !== undefined && entry.datumJson !== null;
    const hasDatumCbor = entry.datumCbor !== undefined && entry.datumCbor !== null;
    if (hasDatumJson && hasDatumCbor) return { error: `${at} takes datumJson or datumCbor, not both` };
    if (hasDatumCbor) {
      const cbor = parsePlutusCbor(entry.datumCbor, `${at}.datumCbor`);
      if (cbor.error) return { error: cbor.error };
      input.datumCbor = cbor.hex;
    } else if (hasDatumJson) {
      const datum = parseJsonField(entry.datumJson, `${at}.datumJson`);
      if (datum.error) return { error: datum.error };
      input.datum = datum.parsed;
    }
    out.push(input);
  }
  return { parsed: out };
}

/** Upper bound on withdrawals per BuildPlutusTransaction. */
export const MAX_WITHDRAWALS = 16;

/** One withdrawal of a BuildPlutusTransaction, validated; `stakingScript` still without params applied. */
export interface ParsedWithdrawal {
  rewardAddress: string;
  lovelace: string;
  stakingScript?: string;
  scriptParams?: JSONValue[];
  referenceScript?: { txHash: string; outputIndex: number };
  redeemer?: JSONValue;
  redeemerCbor?: string;
}

/**
 * Parse and validate withdrawalsJson: distinct reward accounts, lovelace >= 0, optionally a staking
 * script (inline or by reference) with exactly one redeemer form; without a script no redeemer.
 */
export function parseWithdrawals(json: string | undefined): { parsed?: ParsedWithdrawal[]; error?: string } {
  if (!json) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(json, 'withdrawalsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'withdrawalsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  if (jsonResult.parsed.length > MAX_WITHDRAWALS) {
    return { error: `withdrawalsJson exceeds maximum of ${MAX_WITHDRAWALS} entries` };
  }

  const out: ParsedWithdrawal[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    const at = `withdrawals[${i}]`;
    if (!entry || typeof entry !== 'object') return { error: `${at} must be an object` };
    if (typeof entry.rewardAddress !== 'string' || !isValidBech32StakeAddress(entry.rewardAddress)) {
      return { error: `${at}.rewardAddress must be a Bech32 stake address` };
    }
    const rewardAddress = entry.rewardAddress.toLowerCase();
    if (seen.has(rewardAddress)) return { error: `${at} withdraws from ${rewardAddress} a second time` };
    seen.add(rewardAddress);
    const lovelace = typeof entry.lovelace === 'number' && Number.isInteger(entry.lovelace) && entry.lovelace >= 0
      ? String(entry.lovelace)
      : typeof entry.lovelace === 'string' && /^\d+$/.test(entry.lovelace) ? entry.lovelace : undefined;
    if (lovelace === undefined) return { error: `${at}.lovelace must be a non-negative integer (0 for withdraw-zero)` };

    const witness = parseStakingScriptWitness(entry, at, 'withdrawal');
    if (witness.error) return { error: witness.error };
    out.push({ rewardAddress, lovelace, ...witness.parsed });
  }
  return { parsed: out };
}

/** Optional staking script (inline with params, or by reference) plus its redeemer, shared by withdrawals and certificates. */
type ParsedStakingScriptWitness = Pick<ParsedWithdrawal, 'stakingScript' | 'scriptParams' | 'referenceScript' | 'redeemer' | 'redeemerCbor'>;
function parseStakingScriptWitness(
  entry: Record<string, unknown>, at: string, kind: 'withdrawal' | 'certificate'
): { parsed?: ParsedStakingScriptWitness; error?: string } {
  const present = (v: unknown) => v !== undefined && v !== null;
  const parseJsonField = (value: unknown, field: string): { parsed?: JSONValue; error?: string } => {
    if (typeof value !== 'string') return { error: `${field} must be a JSON string` };
    const r = validatePlutusJson(value, field);
    return r.valid ? { parsed: r.parsed as JSONValue } : { error: r.error! };
  };
  const w: ParsedStakingScriptWitness = {};
  const hasInline = present(entry.stakingScript);
  const hasRef = present(entry.referenceScript);
  if (hasInline && hasRef) return { error: `${at} takes stakingScript or referenceScript, not both` };
  if (hasInline) {
    if (typeof entry.stakingScript !== 'string' || !isValidCbor(entry.stakingScript)) {
      return { error: `${at}.stakingScript must be even-length CBOR hex` };
    }
    w.stakingScript = entry.stakingScript;
    if (present(entry.scriptParamsJson)) {
      const params = parseJsonField(entry.scriptParamsJson, `${at}.scriptParamsJson`);
      if (params.error) return { error: params.error };
      if (!Array.isArray(params.parsed)) return { error: `${at}.scriptParamsJson must be a JSON array` };
      if (params.parsed.length > 0) w.scriptParams = params.parsed;
    }
  } else if (hasRef) {
    const ref = entry.referenceScript as Record<string, unknown>;
    if (!ref || typeof ref !== 'object' || typeof ref.txHash !== 'string' || !isTxHash(ref.txHash)
      || typeof ref.outputIndex !== 'number' || !Number.isInteger(ref.outputIndex) || ref.outputIndex < 0) {
      return { error: `${at}.referenceScript must be {txHash, outputIndex} of the UTxO carrying the script` };
    }
    if (present(entry.scriptParamsJson)) return { error: `${at}.scriptParamsJson applies to an inline stakingScript only` };
    w.referenceScript = { txHash: ref.txHash.toLowerCase(), outputIndex: ref.outputIndex };
  } else if (present(entry.scriptParamsJson)) {
    return { error: `${at}.scriptParamsJson applies to an inline stakingScript only` };
  }

  const hasRedeemerJson = present(entry.redeemerJson);
  const hasRedeemerCbor = present(entry.redeemerCbor);
  if (hasInline || hasRef) {
    if (hasRedeemerJson === hasRedeemerCbor) return { error: `${at} needs exactly one of redeemerJson or redeemerCbor` };
    if (hasRedeemerCbor) {
      const cbor = parsePlutusCbor(entry.redeemerCbor, `${at}.redeemerCbor`);
      if (cbor.error) return { error: cbor.error };
      w.redeemerCbor = cbor.hex;
    } else {
      const redeemer = parseJsonField(entry.redeemerJson, `${at}.redeemerJson`);
      if (redeemer.error) return { error: redeemer.error };
      w.redeemer = redeemer.parsed;
    }
  } else if (hasRedeemerJson || hasRedeemerCbor) {
    return { error: `${at} has a redeemer but no staking script; a key-witnessed ${kind} takes none` };
  }
  return { parsed: w };
}

/** Upper bound on certificates per BuildPlutusTransaction. */
export const MAX_CERTIFICATES = 16;

/** One certificate of a BuildPlutusTransaction, validated; `stakingScript` still without params applied. */
export interface ParsedCertificate extends ParsedStakingScriptWitness {
  type: 'registerStake' | 'deregisterStake';
  stakeAddress: string;
  deposit?: string;
}

/**
 * Parse and validate certificatesJson: stake registrations and deregistrations, each with an
 * optional staking script (inline or by reference) and exactly one redeemer form when scripted.
 */
export function parseCertificates(json: string | undefined): { parsed?: ParsedCertificate[]; error?: string } {
  if (!json) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(json, 'certificatesJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'certificatesJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  if (jsonResult.parsed.length > MAX_CERTIFICATES) {
    return { error: `certificatesJson exceeds maximum of ${MAX_CERTIFICATES} entries` };
  }
  const out: ParsedCertificate[] = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    const at = `certificates[${i}]`;
    if (!entry || typeof entry !== 'object') return { error: `${at} must be an object` };
    if (entry.type !== 'registerStake' && entry.type !== 'deregisterStake') {
      return { error: `${at}.type must be registerStake or deregisterStake` };
    }
    if (typeof entry.stakeAddress !== 'string' || !isValidBech32StakeAddress(entry.stakeAddress)) {
      return { error: `${at}.stakeAddress must be a Bech32 stake address` };
    }
    let deposit: string | undefined;
    if (entry.deposit !== undefined && entry.deposit !== null) {
      deposit = typeof entry.deposit === 'number' && Number.isInteger(entry.deposit) && entry.deposit > 0
        ? String(entry.deposit)
        : typeof entry.deposit === 'string' && /^\d+$/.test(entry.deposit) && entry.deposit !== '0' ? entry.deposit : undefined;
      if (deposit === undefined) return { error: `${at}.deposit must be a positive integer (lovelace)` };
    }
    const witness = parseStakingScriptWitness(entry, at, 'certificate');
    if (witness.error) return { error: witness.error };
    out.push({ type: entry.type, stakeAddress: entry.stakeAddress.toLowerCase(), ...(deposit ? { deposit } : {}), ...witness.parsed });
  }
  return { parsed: out };
}

/**
 * Parse mintActionsJson for BuildPlutusTransaction: every action carries its own `mintingPolicyScript`
 * or `referenceScript` (no request-level default) and optional `redeemerJson`; `assetUnit` is
 * policyId+assetName, or with an inline script a bare assetName prefixed with the script's policy id.
 */
export function parsePolicyMintActions(json: string | undefined): { parsed?: MintAction[]; error?: string } {
  if (!json) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(json, 'mintActionsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'mintActionsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  const out: MintAction[] = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') return { error: `mintActions[${i}] must be an object` };
    if (typeof entry.quantity !== 'string' || !/^-?\d+$/.test(entry.quantity) || BigInt(entry.quantity) === 0n) {
      return { error: `mintActions[${i}].quantity must be a non-zero integer string` };
    }
    const present = (v: unknown) => v !== undefined && v !== null;
    const hasRef = present(entry.referenceScript);
    if (present(entry.mintingPolicyScript) === hasRef) {
      return { error: `mintActions[${i}] needs exactly one of mintingPolicyScript or referenceScript` };
    }
    const policy = parseMintActionPolicyFields(entry, i, hasRef);
    if (policy.error) return { error: policy.error };
    if (typeof entry.assetUnit !== 'string' || !/^[0-9a-fA-F]*$/.test(entry.assetUnit) || entry.assetUnit.length % 2 !== 0) {
      return { error: `mintActions[${i}].assetUnit must be hex (policyId+assetName, or a bare assetName)` };
    }
    let assetUnit = entry.assetUnit.toLowerCase();
    let referenceScript: { txHash: string; outputIndex: number } | undefined;
    if (hasRef) {
      const ref = entry.referenceScript as Record<string, unknown>;
      if (!ref || typeof ref !== 'object' || typeof ref.txHash !== 'string' || !isTxHash(ref.txHash)
        || typeof ref.outputIndex !== 'number' || !Number.isInteger(ref.outputIndex) || ref.outputIndex < 0) {
        return { error: `mintActions[${i}].referenceScript must be {txHash, outputIndex} of the UTxO carrying the policy` };
      }
      referenceScript = { txHash: ref.txHash.toLowerCase(), outputIndex: ref.outputIndex };
      // the policy id is known only once the builder has read the reference script
      if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
        return { error: `mintActions[${i}].assetUnit must be policyId+assetName when the policy is a referenceScript` };
      }
    } else {
      let policyId: string;
      try {
        policyId = Script.fromCbor(Buffer.from(policy.script!, 'hex')).hash.toString();
      } catch (err: unknown) {
        return { error: `mintActions[${i}].mintingPolicyScript is not a valid Plutus script: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
        assetUnit = policyId + assetUnit;
      } else if (!assetUnit.startsWith(policyId)) {
        return { error: `mintActions[${i}].assetUnit does not start with its policy id ${policyId}` };
      }
    }
    if (!isAssetUnit(assetUnit)) return { error: `mintActions[${i}].assetUnit is not a valid asset unit` };
    out.push({
      assetUnit,
      quantity: BigInt(entry.quantity),
      ...(policy.script ? { mintingPolicyScript: policy.script } : { referenceScript }),
      ...(policy.redeemer !== undefined ? { redeemerJson: policy.redeemer } : {}),
    });
  }
  return { parsed: out };
}
