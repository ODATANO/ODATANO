// --- Regular Expressions ---
export const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
export const POLICY_ID_REGEX = /^[a-fA-F0-9]{56}$/;
export const BECH32_TEST_PREFIX = /^addr_test/; // preview/testnet bech32 prefix

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
 * Note: For mainnet, adapt the prefix to /^addr1/ if needed.
 */
export function isBech32Address(s: unknown): s is string {
  return typeof s === "string" && BECH32_TEST_PREFIX.test(s);
}
