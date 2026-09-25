import { bech32 } from "bech32";
import {BECH32_MAX_LENGTH,MAX_JSON_SIZE,MAX_DEPTH,MAX_KEYS,MAX_ARRAY_LENGTH,MAX_STRING_LENGTH,MAX_EPOCH,POOL_ID_BYTES,DREP_ID_BYTES,TX_HASH_REGEX,HEX_64_REGEX,HEX_56_REGEX,ASSET_UNIT_REGEX,
  POOL_ID_REGEX, DREP_ID_REGEX, HRP, ED25519_KEY_HASH_REGEX, MAX_POSIX_MS_DIGITS, MAX_TX_CBOR_HEX_LENGTH
} from "./const";

// Leaf module, not `../server`: importing server would pull the whole server/indexer graph in here.
import { getActiveNetwork } from "./network-context";
/** Trimmed string, or null when not a string or empty after trim. */
function safeTrimString(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** Strict bech32 decode with HRP allowlist; null when invalid. */
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


/** Byte length of decoded bech32 words (fromWords validates the word range). */
function wordsToBytesLen(words: number[]): number {
  return Buffer.from(bech32.fromWords(words)).length;
}

/** Result of JSON validation with limits */
interface JsonValidationResult {
  valid: boolean;
  error?: string;
  parsed?: unknown;
}

/** Parse a JSON string under size and complexity limits (DoS prevention); `fieldName` is for messages. */
export function validateJsonWithLimits(jsonString: string, fieldName: string): JsonValidationResult {
  // Size limit before parsing
  if (jsonString.length > MAX_JSON_SIZE) {
    return { valid: false, error: `${fieldName} exceeds maximum size of ${MAX_JSON_SIZE} bytes` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { valid: false, error: `Invalid JSON in ${fieldName}` };
  }

  const complexityError = checkJsonComplexity(parsed, 0);
  if (complexityError) {
    return { valid: false, error: `${fieldName}: ${complexityError}` };
  }

  return { valid: true, parsed };
}

/** Recursive complexity check (depth, keys, array length, string length); error message or null. */
function checkJsonComplexity(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} exceeded`;
  }

  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      return `String value exceeds maximum length of ${MAX_STRING_LENGTH}`;
    }
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      return `Array exceeds maximum length of ${MAX_ARRAY_LENGTH}`;
    }
    for (const item of value) {
      const error = checkJsonComplexity(item, depth + 1);
      if (error) return error;
    }
  } else {
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) {
      return `Object exceeds maximum key count of ${MAX_KEYS}`;
    }
    for (const key of keys) {
      const error = checkJsonComplexity((value as Record<string, unknown>)[key], depth + 1);
      if (error) return error;
    }
  }

  return null;
}

/** Transaction hash: 64-character hex string */
export function isTxHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH_REGEX.test(s);
}

/** Asset unit: policy ID (56 hex chars) + asset name (0-64 hex chars, even length) */
export function isAssetUnit(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();

  return ASSET_UNIT_REGEX.test(t);
}

/** Block hash: 64-character hex string */
export function isBlockHash(s: unknown): s is string {
  return typeof s === "string" && HEX_64_REGEX.test(s);
}

/** Payment credential: 28-byte key or script hash as 56-char lowercase hex (credential-keyed UTxO queries). */
export function isValidCredential(s: unknown): s is string {
  return typeof s === "string" && HEX_56_REGEX.test(s);
}

/** Pool ID: bech32 with HRP "pool" and a 28-byte payload. */
export function isValidPoolId(poolIdRaw: unknown): poolIdRaw is string {
  const poolId = safeTrimString(poolIdRaw);
  if (!poolId) return false;

  // cheap prefilter
  if (!POOL_ID_REGEX.test(poolId)) return false;

  const decoded = tryDecodeBech32WithHrp(poolId, ["pool"]);
  if (decoded) return wordsToBytesLen(decoded.words) === POOL_ID_BYTES;
  return false;
}

/** DRep ID: bech32 with HRP "drep" and a 29-byte payload. */
export function isValidDrepId(drepRaw: unknown): drepRaw is string {
  const drepId = safeTrimString(drepRaw);
  if (!drepId) return false;

  // cheap prefilter
  if (!DREP_ID_REGEX.test(drepId)) return false;

  const decoded = tryDecodeBech32WithHrp(drepId, ["drep"]);
  if (decoded) return wordsToBytesLen(decoded.words) === DREP_ID_BYTES;
  return false;
}

/** Bech32 address with the HRP of the active network; false before the app context is ready. */
export function isValidBech32Address(addrRaw: unknown): addrRaw is string {
  const addr = safeTrimString(addrRaw);
  if (!addr) return false;

  // No network yet (app context not initialized): a clean 400 instead of a leaked init error
  const network = getActiveNetwork();
  if (!network) return false;

  // network HRP prefilter
  if (!HRP[network].addr.test(addr)) return false;

  const allowed = ["addr", "addr_test"];
  const decoded = tryDecodeBech32WithHrp(addr, allowed);
  if (decoded) {
  // 29 bytes (enterprise/reward) to 57 bytes (base address)
  const len = wordsToBytesLen(decoded.words);
  return len >= 29 && len <= 57;
  }
  return false;
}

/** Bech32 stake address with the HRP of the active network; false before the app context is ready. */
export function isValidBech32StakeAddress(stakeRaw: unknown): stakeRaw is string {
  const stake = safeTrimString(stakeRaw);
  if (!stake) return false;

  const network = getActiveNetwork();
  if (!network) return false;

  // network HRP prefilter
  if (!HRP[network].stake.test(stake)) return false;

  const allowed = ["stake", "stake_test"];
  const decoded = tryDecodeBech32WithHrp(stake, allowed);
  if (!decoded) return false;

  const len = wordsToBytesLen(decoded.words);
  return len >= 1 && len <= 64;
}

/** Epoch number: non-negative integer up to MAX_EPOCH */
export function isEpochNumber(s: unknown): s is number {
  return typeof s === "number" && s >= 0 && s <= MAX_EPOCH && Number.isInteger(s);
}

/** CBOR hex: non-empty, even-length hex string */
export function isValidCbor(cborRaw: unknown): cborRaw is string {
  const cbor = safeTrimString(cborRaw);
  if (!cbor) return false;
  return /^[a-f0-9]+$/i.test(cbor) && cbor.length % 2 === 0;
}

/** `isValidCbor` plus the MAX_TX_CBOR_HEX_LENGTH cap (ParseTransactionCbor memory bound). */
export function isValidTxCborHex(cborRaw: unknown): cborRaw is string {
  if (!isValidCbor(cborRaw)) return false;
  return (cborRaw as string).trim().length <= MAX_TX_CBOR_HEX_LENGTH;
}

/**
 * Payment credential of a Shelley bech32 address: 28-byte hash (hex) plus whether it is a script
 * credential (bit 0 of the header's high nibble); null for undecodable or stake addresses.
 */
export function extractPaymentCredential(address: string): { hash: string; isScript: boolean } | null {
  try {
    const decoded = bech32.decode(address, BECH32_MAX_LENGTH);
    const bytes = Buffer.from(bech32.fromWords(decoded.words));
    // 1 header byte + 28-byte payment credential (+ optional 28-byte stake part)
    if (bytes.length < 29) return null;
    const addrType = bytes[0] >> 4;
    // types 0-7 are payment addresses; 14/15 are stake addresses (no payment part)
    if (addrType > 7) return null;
    return {
      hash: bytes.subarray(1, 29).toString('hex'),
      isScript: (addrType & 0x1) === 1,
    };
  } catch {
    return null;
  }
}

/** Validate an array of Ed25519 key hashes (56 hex chars each); throws on any invalid entry. */
export function validateRequiredSigners(signers: unknown): string[] {
  if (!Array.isArray(signers)) {
    throw new Error('requiredSignersJson must be a JSON array');
  }
  for (const signer of signers) {
    if (typeof signer !== 'string' || !ED25519_KEY_HASH_REGEX.test(signer)) {
      throw new Error('Invalid Ed25519 key hash: must be 56 hex chars');
    }
  }
  return signers as string[];
}

/** Validation error details for transaction input validation */
export interface ValidationError {
  type: 'missing' | 'invalid';
  field: string;
  message: string;
}

/** Transaction input fields for validation */
export interface TransactionInputs {
  senderAddress?: string;
  recipientAddress?: string;
  changeAddress?: string;
  // Runtime value is a string (OData Decimal(20,0)); bigint/number are coerced via String()
  lovelaceAmount?: string | number | bigint;
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
  // CIP-33 reference script deploy
  referenceScriptHex?: string;
  // Validity interval (Posix ms, string-encoded to avoid JS number precision loss)
  validityStartMs?: string;
  validityEndMs?: string;
}

/** Validate transaction build inputs; returns the validation errors (empty when all valid). */
export function validateTransactionInputs(
  inputs: TransactionInputs,
  requiredFields: (keyof TransactionInputs)[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of requiredFields) {
    if (inputs[field] === undefined || inputs[field] === null || inputs[field] === '') {
      errors.push({
        type: 'missing',
        field,
        message: `${field} is required`
      });
    }
  }

  if (errors.length > 0) return errors;

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

  // String-based positive-integer check avoids precision loss for large values
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

  // 65536 hex chars = 32 KB binary
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

  if (inputs.referenceScriptHex && !isValidCbor(inputs.referenceScriptHex)) {
    errors.push({
      type: 'invalid',
      field: 'referenceScriptHex',
      message: 'Invalid referenceScriptHex format (must be even-length hex)'
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

  const validityStartErr = validatePosixMsField(inputs.validityStartMs, 'validityStartMs');
  if (validityStartErr) errors.push(validityStartErr);
  const validityEndErr = validatePosixMsField(inputs.validityEndMs, 'validityEndMs');
  if (validityEndErr) errors.push(validityEndErr);
  if (!validityStartErr && !validityEndErr && inputs.validityStartMs && inputs.validityEndMs) {
    if (BigInt(inputs.validityStartMs) >= BigInt(inputs.validityEndMs)) {
      errors.push({
        type: 'invalid',
        field: 'validityEndMs',
        message: 'validityEndMs must be greater than validityStartMs'
      });
    }
  }

  return errors;
}

/** Posix-ms string field: non-negative integer with at most MAX_POSIX_MS_DIGITS digits; null when valid or absent. */
function validatePosixMsField(value: string | undefined, field: 'validityStartMs' | 'validityEndMs'): ValidationError | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > MAX_POSIX_MS_DIGITS) {
    return {
      type: 'invalid',
      field,
      message: `${field} must be a non-negative integer string in milliseconds (max ${MAX_POSIX_MS_DIGITS} digits)`
    };
  }
  return null;
}
