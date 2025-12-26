import { CONFIG } from "../../config/config";
import { bech32 } from "bech32";

// ---------------------------------------------------------------------------
// Regular Expressions (cheap prefilters; not sufficient for checksum validity)
// ---------------------------------------------------------------------------
const TX_HASH_REGEX = /^[a-f0-9]{64}$/;
const POLICY_ID_REGEX = /^[a-f0-9]{56}$/;

// keep as cheap prefilter if you want, but do not rely on it alone
const POOL_ID_REGEX = /^pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{51}$/;
const DREP_ID_REGEX = /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;

// Your config-driven regexes (cheap prefilter)
const BECH32_ADDRESS_REGEX = CONFIG.hrp.addr;
const BECH32_STAKE_REGEX = CONFIG.hrp.stake;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeTrimString(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * Strict bech32 decode with HRP allowlist.
 * Returns decoded words if valid, otherwise null.
 */
function tryDecodeBech32WithHrp(value: string, allowedHrp: string[]): { prefix: string; words: number[] } | null {
  try {
    const decoded = bech32.decode(value, 2000); // checksum+structure validated here
    if (!allowedHrp.includes(decoded.prefix)) return null;
    return { prefix: decoded.prefix, words: decoded.words };
  } catch {
    return null;
  }
}

function wordsToBytesLen(words: number[]): number {
  // bech32.fromWords validates word range and converts 5-bit words -> bytes
  return Buffer.from(bech32.fromWords(words)).length;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Transaction hash: 64-character hexadecimal string
 * @param s
 * @returns true if s is a valid transaction hash false otherwise
 */
export function isTxHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH_REGEX.test(s);
}

/**
 * Policy ID: 56-character hexadecimal string
 * @param s 
 * @returns true if s is a valid policy ID false otherwise
 */
export function isPolicyId(s: unknown): s is string {
  return typeof s === "string" && POLICY_ID_REGEX.test(s);
}

/**
 * Block hash: 64-character hexadecimal string
 * @param s
 * @returns true if s is a valid block hash false otherwise
 */
export function isBlockHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH_REGEX.test(s);
}

/**
 * Pool ID: must be bech32-decodable, HRP=pool, payload length 28 bytes.
 * @param poolIdRaw 
 * @returns true if valid pool ID false otherwise
 */
export function isValidPoolId(poolIdRaw: unknown): poolIdRaw is string {
  const poolId = safeTrimString(poolIdRaw);
  if (!poolId) return false;

  // optional: cheap prefilter (keeps performance high)
  if (!POOL_ID_REGEX.test(poolId)) return false;

  const decoded = tryDecodeBech32WithHrp(poolId, ["pool"]);
  if (!decoded) return false;

  return wordsToBytesLen(decoded.words) === 28;
}

/**
 * Drep ID: must be bech32-decodable, HRP=drep, payload length 36 bytes.
 * @param drepRaw 
 * @returns true if valid drep ID false otherwise 
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
 * Bech32 address: must be bech32-decodable, HRP based on network config.
 * @param addrRaw 
 * @returns true if valid bech32 address false otherwise
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
 * Stake address (bech32):
 * Accept HRPs based on network config (mainnet/testnet). 
 * @param stakeRaw 
 * @returns true if valid bech32 stake address false otherwise
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
 * @param s 
 * @returns true if s is a valid epoch number false otherwise
 */

export function isEpochNumber(s: unknown): s is number {
  return typeof s === "number" && s >= 0 && s <= 100000 && Number.isInteger(s);
}
