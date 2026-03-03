import { bech32 } from "bech32";
import {BECH32_MAX_LENGTH,MAX_JSON_SIZE,MAX_DEPTH,MAX_KEYS,MAX_ARRAY_LENGTH,MAX_STRING_LENGTH,MAX_EPOCH,POOL_ID_BYTES,DREP_ID_BYTES,TX_HASH_REGEX,HEX_64_REGEX,ASSET_UNIT_REGEX,
  POOL_ID_REGEX, DREP_ID_REGEX, HRP, ED25519_KEY_HASH_REGEX
} from "./const";

import { getCardanoClient } from "../server";
/** 
 * Safely trim a string value
 * @param s - The value to trim
 * @returns { string | null } trimmed string or null if input is not a string or empty after trim
 */
function safeTrimString(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * Strict bech32 decode with HRP allowlist.
 * @param value - bech32 encoded string
 * @param allowedHrp - list of allowed HRP prefixes
 * @returns { prefix: string; words: number[] } decoded bech32 parts or null if invalid
 */
function tryDecodeBech32WithHrp(value: string, allowedHrp: string[]): { prefix: string; words: number[] } | null {
  try {
    const decoded = bech32.decode(value, BECH32_MAX_LENGTH);
    if (allowedHrp.includes(decoded.prefix)) {
      return { prefix: decoded.prefix, words: decoded.words };
    }
    return null;
  } catch {
    return null;
  }
}


/**
 * Convert bech32 words to byte length
 * @param words - bech32 decoded words
 * @returns { number } byte length of decoded words
 */
function wordsToBytesLen(words: number[]): number {
  // bech32.fromWords validates word range and converts 5-bit words -> bytes
  return Buffer.from(bech32.fromWords(words)).length;
}

/**
 * Result of JSON validation with limits
 */
interface JsonValidationResult {
  valid: boolean;
  error?: string;
  parsed?: unknown;
}

/**
 * Validate JSON string with size and complexity limits to prevent DoS
 * @param jsonString - The JSON string to validate
 * @param fieldName - Name of the field (for error messages)
 * @returns JsonValidationResult with parsed value or error message
 */
function validateJsonWithLimits(jsonString: string, fieldName: string): JsonValidationResult {
  // Check size limit first (before parsing)
  if (jsonString.length > MAX_JSON_SIZE) {
    return { valid: false, error: `${fieldName} exceeds maximum size of ${MAX_JSON_SIZE} bytes` };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { valid: false, error: `Invalid JSON in ${fieldName}` };
  }

  // Validate complexity recursively
  const complexityError = checkJsonComplexity(parsed, 0);
  if (complexityError) {
    return { valid: false, error: `${fieldName}: ${complexityError}` };
  }

  return { valid: true, parsed };
}

/**
 * Recursively check JSON complexity (depth, keys, array length, string length)
 * @param value - The parsed JSON value
 * @param depth - Current nesting depth
 * @returns Error message if limits exceeded, null otherwise
 */
function checkJsonComplexity(value: unknown, depth: number): string | null {
  // Check depth limit
  if (depth > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} exceeded`;
  }

  if (value === null || typeof value !== 'object') {
    // Check string length for primitive strings
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      return `String value exceeds maximum length of ${MAX_STRING_LENGTH}`;
    }
    return null;
  }

  if (Array.isArray(value)) {
    // Check array length
    if (value.length > MAX_ARRAY_LENGTH) {
      return `Array exceeds maximum length of ${MAX_ARRAY_LENGTH}`;
    }
    // Recursively check array elements
    for (const item of value) {
      const error = checkJsonComplexity(item, depth + 1);
      if (error) return error;
    }
  } else {
    // Check object key count
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) {
      return `Object exceeds maximum key count of ${MAX_KEYS}`;
    }
    // Recursively check object values
    for (const key of keys) {
      const error = checkJsonComplexity((value as Record<string, unknown>)[key], depth + 1);
      if (error) return error;
    }
  }

  return null;
}

/**
 * Transaction hash: 64-character hexadecimal string
 * @param s - The raw value to validate against transaction hash format
 * @returns { boolean } true if s is a valid transaction hash false otherwise
 */
export function isTxHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH_REGEX.test(s);
}

/**
 * Asset unit: concatenation of policy ID (56 hex chars) + asset name (0-128 hex chars)
 * @param s - The raw value to validate against asset unit format
 * @returns { boolean } true if v is a valid asset unit false otherwise
 */
export function isAssetUnit(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();

  // Regex ensures: 56-192 hex chars, even length, valid hex
  return ASSET_UNIT_REGEX.test(t);
}

/**
 * Block hash: 64-character hexadecimal string
 * @param s - The raw value to validate against block hash format
 * @returns { boolean } true if s is a valid block hash false otherwise
 */
export function isBlockHash(s: unknown): s is string {
  return typeof s === "string" && HEX_64_REGEX.test(s);
}

/**
 * Pool ID: must be bech32-decodable, HRP=pool, payload length 28 bytes.
 * @param poolIdRaw - The raw value to validate against pool ID format
 * @returns { boolean } true if valid pool ID false otherwise
 */
export function isValidPoolId(poolIdRaw: unknown): poolIdRaw is string {
  const poolId = safeTrimString(poolIdRaw);
  if (!poolId) return false;

  // optional: cheap prefilter (keeps performance high)
  if (!POOL_ID_REGEX.test(poolId)) return false;

  const decoded = tryDecodeBech32WithHrp(poolId, ["pool"]);
  if (decoded) return wordsToBytesLen(decoded.words) === POOL_ID_BYTES;
  return false;
}

/**
 * DRep ID: must be bech32-decodable, HRP=drep.
 * @param drepRaw - The raw value to validate against drep ID format
 * @returns { boolean } true if valid drep ID false otherwise
 */
export function isValidDrepId(drepRaw: unknown): drepRaw is string {
  const drepId = safeTrimString(drepRaw);
  if (!drepId) return false;

  // optional cheap prefilter
  if (!DREP_ID_REGEX.test(drepId)) return false;

  const decoded = tryDecodeBech32WithHrp(drepId, ["drep"]);
  if (decoded) return wordsToBytesLen(decoded.words) === DREP_ID_BYTES;
  return false;
}

/**
 * Validate Bech32 address: must be bech32-decodable, HRP based on network config.
 * @param addrRaw - The raw value to validate against bech32 address format
 * @returns { boolean } true if valid bech32 address false otherwise
 */
export function isValidBech32Address(addrRaw: string): addrRaw is string {
  const addr = safeTrimString(addrRaw);
  if (!addr) return false;

  // get client to check right network
  const client = getCardanoClient();
  const network = client.network;

  // prefilter from config to make sure it is the right network
  if (!HRP[network].addr.test(addr)) return false;

  const allowed = ["addr", "addr_test"];
  const decoded = tryDecodeBech32WithHrp(addr, allowed);
  if (decoded) {
  // avoid absurdly short/long decoded payloads
  const len = wordsToBytesLen(decoded.words);
  return len >= 1 && len <= 128;
  }
  return false;
}

/** 
 * Validate Bech32 stake address: must be bech32-decodable, HRP based on network config.
 * @param stakeRaw - The raw value to validate against stake address format
 * @returns { boolean } true if valid bech32 stake address false otherwise
 */
export function isValidBech32StakeAddress(stakeRaw: unknown): stakeRaw is string {
  const stake = safeTrimString(stakeRaw);
  if (!stake) return false;

  // get client to check right network
  const client = getCardanoClient();
  const network = client.network;

  // prefilter from config to make sure it is the right network
  if (!HRP[network].stake.test(stake)) return false;

  const allowed = ["stake", "stake_test"];
  const decoded = tryDecodeBech32WithHrp(stake, allowed);
  if (!decoded) return false;

  const len = wordsToBytesLen(decoded.words);
  return len >= 1 && len <= 64;
}

/** 
 * Epoch number: non-negative integer within reasonable bounds
 * @param s - The parameter value to validate as epoch number
 * @returns { boolean } true if s is a valid epoch number false otherwise
 */
export function isEpochNumber(s: unknown): s is number {
  return typeof s === "number" && s >= 0 && s <= MAX_EPOCH && Number.isInteger(s);
}

/**
 * Validate CBOR string: must be a non-empty even-length hexadecimal string
 * @param cborRaw - The raw value to validate against CBOR format
 * @returns { boolean } true if valid CBOR false otherwise
 */
export function isValidCbor(cborRaw: unknown): cborRaw is string {
  const cbor = safeTrimString(cborRaw);
  if (!cbor) return false;
  // basic validation: must be even-length hex string
  return /^[a-f0-9]+$/i.test(cbor) && cbor.length % 2 === 0;
}

/**
 * Validate an array of Ed25519 key hashes (hex, 28 bytes / 56 hex chars each).
 * @param signers - The parsed JSON array to validate
 * @returns validated string array
 * @throws Error if any signer is invalid
 */
export function validateRequiredSigners(signers: any[]): string[] {
  if (!Array.isArray(signers)) {
    throw new Error('requiredSignersJson must be a JSON array');
  }
  for (const signer of signers) {
    if (typeof signer !== 'string' || !ED25519_KEY_HASH_REGEX.test(signer)) {
      throw new Error('Invalid Ed25519 key hash: must be 56 hex chars');
    }
  }
  return signers;
}

/**
 * Validation error details for transaction input validation
 */
export interface ValidationError {
  type: 'missing' | 'invalid';
  field: string;
  message: string;
}

/**
 * Transaction input fields for validation
 */
export interface TransactionInputs {
  senderAddress?: string;
  recipientAddress?: string;
  changeAddress?: string;
  lovelaceAmount?: number | bigint;
  signedTxCbor?: string;
  metadataJson?: string;
  assetsJson?: string;
  mintActionsJson?: string;
  mintingPolicyScript?: string;
  buildId?: string;
  submissionId?: string;
  // M3 - External Signing Workflow
  signingRequestId?: string;
  signerType?: string;
  signerInfo?: string;
  // Plutus spending
  validatorScript?: string;
  scriptTxHash?: string;
  scriptOutputIndex?: number;
  redeemerJson?: string;
  datumJson?: string;
}

/**
 * Validate transaction build inputs and return validation errors if any
 * @param inputs - Transaction input fields to validate
 * @param requiredFields - List of required field names
 * @returns Array of validation errors, empty if all valid
 */
export function validateTransactionInputs(
  inputs: TransactionInputs,
  requiredFields: (keyof TransactionInputs)[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check required fields
  for (const field of requiredFields) {
    if (inputs[field] === undefined || inputs[field] === null || inputs[field] === '') {
      errors.push({
        type: 'missing',
        field,
        message: `${field} is required`
      });
    }
  }

  // If required fields are missing, return early
  if (errors.length > 0) return errors;

  // Validate address formats
  if (inputs.senderAddress && !isValidBech32Address(inputs.senderAddress)) {
    errors.push({
      type: 'invalid',
      field: 'senderAddress',
      message: 'Invalid sender address format'
    });
  }

  if (inputs.recipientAddress && !isValidBech32Address(inputs.recipientAddress)) {
    errors.push({
      type: 'invalid',
      field: 'recipientAddress',
      message: 'Invalid recipient address format'
    });
  }

  if (inputs.changeAddress && !isValidBech32Address(inputs.changeAddress)) {
    errors.push({
      type: 'invalid',
      field: 'changeAddress',
      message: 'Invalid change address format'
    });
  }

  // Validate lovelaceAmount is a positive integer (string-based to avoid precision loss for large values)
  if (inputs.lovelaceAmount !== undefined && inputs.lovelaceAmount !== null) {
    const s = String(inputs.lovelaceAmount);
    if (!/^\d+$/.test(s) || s === '0') {
      errors.push({
        type: 'invalid',
        field: 'lovelaceAmount',
        message: 'lovelaceAmount must be a positive integer'
      });
    }
  }

  // Validate CBOR format and size (max 32K hex chars = 16KB binary)
  const MAX_CBOR_HEX_LENGTH = 65536;
  if (inputs.signedTxCbor && !isValidCbor(inputs.signedTxCbor)) {
    errors.push({
      type: 'invalid',
      field: 'signedTxCbor',
      message: 'Invalid signedTxCbor format'
    });
  } else if (inputs.signedTxCbor && typeof inputs.signedTxCbor === 'string' && inputs.signedTxCbor.length > MAX_CBOR_HEX_LENGTH) {
    errors.push({
      type: 'invalid',
      field: 'signedTxCbor',
      message: `signedTxCbor exceeds maximum size of ${MAX_CBOR_HEX_LENGTH} hex characters`
    });
  }

  if (inputs.mintingPolicyScript && !isValidCbor(inputs.mintingPolicyScript)) {
    errors.push({
      type: 'invalid',
      field: 'mintingPolicyScript',
      message: 'Invalid mintingPolicyScript format'
    });
  }

  if (inputs.validatorScript && !isValidCbor(inputs.validatorScript)) {
    errors.push({
      type: 'invalid',
      field: 'validatorScript',
      message: 'Invalid validatorScript format'
    });
  }

  if (inputs.scriptTxHash && !isTxHash(inputs.scriptTxHash)) {
    errors.push({
      type: 'invalid',
      field: 'scriptTxHash',
      message: 'Invalid scriptTxHash format'
    });
  }

  if (inputs.scriptOutputIndex !== undefined && inputs.scriptOutputIndex !== null) {
    if (!Number.isInteger(inputs.scriptOutputIndex) || inputs.scriptOutputIndex < 0) {
      errors.push({
        type: 'invalid',
        field: 'scriptOutputIndex',
        message: 'scriptOutputIndex must be a non-negative integer'
      });
    }
  }

  // Validate JSON fields with size and complexity limits
  if (inputs.metadataJson) {
    const result = validateJsonWithLimits(inputs.metadataJson, 'metadataJson');
    if (!result.valid) {
      errors.push({
        type: 'invalid',
        field: 'metadataJson',
        message: result.error!
      });
    }
  }

  if (inputs.assetsJson) {
    const result = validateJsonWithLimits(inputs.assetsJson, 'assetsJson');
    if (!result.valid) {
      errors.push({
        type: 'invalid',
        field: 'assetsJson',
        message: result.error!
      });
    }
  }

  if (inputs.mintActionsJson) {
    const result = validateJsonWithLimits(inputs.mintActionsJson, 'mintActionsJson');
    if (!result.valid) {
      errors.push({
        type: 'invalid',
        field: 'mintActionsJson',
        message: result.error!
      });
    }
  }

  if (inputs.redeemerJson) {
    const result = validateJsonWithLimits(inputs.redeemerJson, 'redeemerJson');
    if (!result.valid) {
      errors.push({
        type: 'invalid',
        field: 'redeemerJson',
        message: result.error!
      });
    }
  }

  if (inputs.datumJson) {
    const result = validateJsonWithLimits(inputs.datumJson, 'datumJson');
    if (!result.valid) {
      errors.push({
        type: 'invalid',
        field: 'datumJson',
        message: result.error!
      });
    }
  }

  return errors;
}
