import { CONFIG } from "../../config/config";

// --- Regular Expressions ---
export const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
export const POLICY_ID_REGEX = /^[a-fA-F0-9]{56}$/;
export const POOL_ID_REGEX = /^([0-9a-f]{56}|pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60})$/;
export const DREP_ID_REGEX =
  /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;
  
// Supports mainnet (addr1...) and testnet/preview (addr_test1...), lower-case bech32 payload, ≥53 chars
export const BECH32_ADDRESS_REGEX = CONFIG.hrp.addr;
export const BECH32_STAKE_REGEX = CONFIG.hrp.stake;

// --- Type Guards ---

/**
 * Check if a string is a valid Cardano transaction hash (64 hex chars).
 */
export function isTxHash(s: unknown): s is string {
  return typeof s === "string" && TX_HASH_REGEX.test(s);
}

/**
 * Checks if a string is a valid Cardano Pool ID (56 hex chars OR pool1... bech32 format)
 */
export function isPoolId(s: unknown): s is string {
  return typeof s === "string" && POOL_ID_REGEX.test(s);
}
/**
 * Checks if a string is a valild Cardano DREP ID (drep1... bech32 format)
 */
export function isDrepId(s: unknown): s is string {
  return typeof s === "string" && DREP_ID_REGEX.test(s);
}

/**
 * Checks if a string is a valid bech32 address (testnet preview pattern).
 * Validates format: addr_test1 + base32 chars (minimum 53 additional characters).
 */
export function isBech32Address(s: unknown): s is string {
  return typeof s === "string" && BECH32_ADDRESS_REGEX.test(s);
}

/**
 * Checks if a string is a valid bech32 stake address for the current network.
 * Preview network uses pattern: stake_test1 + base32 chars (minimum 53 additional characters).
 */
export function isBech32StakeAddress(s: unknown): s is string {
  return typeof s === "string" && BECH32_STAKE_REGEX.test(s);
}
