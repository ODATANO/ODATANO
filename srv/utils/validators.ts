import { CONFIG } from "../../config/config";

// --- Regular Expressions ---
export const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
export const POLICY_ID_REGEX = /^[a-fA-F0-9]{56}$/;

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
 * Check if a string is a valid Cardano policy ID (56 hex chars).
 */
export function isPolicyId(s: unknown): s is string {
  return typeof s === "string" && POLICY_ID_REGEX.test(s);
}

/**
 * Checks if a string is a valid bech32 address (testnet preview pattern).
 * Validates format: addr_test1 + base32 chars (minimum 53 additional characters).
 * Note: For mainnet, adapt to /^addr1[a-z0-9]{53,}$/ pattern.
 */
export function isBech32Address(s: unknown): s is string {
  return typeof s === "string" && BECH32_ADDRESS_REGEX.test(s);
}
