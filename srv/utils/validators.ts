import { CONFIG } from "../../config/config";
import { bech32 } from "bech32";

/** 
 * Configuration constants 
 */
const { BECH32_MAX_LENGTH, MAX_EPOCH, POOL_ID_BYTES } = CONFIG.VALIDITY_VARIANTS;

/** 
 * Transaction hash Regex - 64-character hexadecimal string
 */
const TX_HASH_REGEX = /^[a-f0-9]{64}$/;

/**
 * Asset unit Regex - policy ID (56 hex chars) + asset name (0-128 hex chars)
 */
const ASSET_UNIT_REGEX = /^[a-f0-9]{56,192}$/; // policy ID (56) + asset name (0-64 bytes -> 0-128 hex chars)

/**
 *  Pool ID Regex - bech32 with HRP "pool" and 28 bytes payload
 */
const POOL_ID_REGEX = /^pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{51}$/;

/**
 * DRep ID Regex - bech32 with HRP "drep" and 50-60 chars payload
 */
const DREP_ID_REGEX = /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;

/**
 * Bech32 Address Regular Expressions from Config
 */
const BECH32_ADDRESS_REGEX = CONFIG.hrp.addr;

/**
 * Bech32 Stake Address Regular Expressions from Config
 */
const BECH32_STAKE_REGEX = CONFIG.hrp.stake;

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
  return typeof s === "string" && TX_HASH_REGEX.test(s);
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
  return decoded != null;
}

/**
 * Validate Bech32 address: must be bech32-decodable, HRP based on network config.
 * @param addrRaw - The raw value to validate against bech32 address format
 * @returns { boolean } true if valid bech32 address false otherwise
 */
export function isValidBech32Address(addrRaw: unknown): addrRaw is string {
  const addr = safeTrimString(addrRaw);
  if (!addr) return false;

  // prefilter from config to make sure it is the right network
  if (!BECH32_ADDRESS_REGEX.test(addr)) return false;

  const allowed = ["addr", "addr_test"];
  const decoded = tryDecodeBech32WithHrp(addr, allowed);
  if (!decoded) return false;

  // avoid absurdly short/long decoded payloads
  const len = wordsToBytesLen(decoded.words);
  return len >= 1 && len <= 128;
}

/** 
 * Validate Bech32 stake address: must be bech32-decodable, HRP based on network config.
 * @param stakeRaw - The raw value to validate against stake address format
 * @returns { boolean } true if valid bech32 stake address false otherwise
 */
export function isValidBech32StakeAddress(stakeRaw: unknown): stakeRaw is string {
  const stake = safeTrimString(stakeRaw);
  if (!stake) return false;

  // prefilter from config to make sure it is the right network
  if (!BECH32_STAKE_REGEX.test(stake)) return false;

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
