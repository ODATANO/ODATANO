/**
 * Cardano protocol constants
 */
export const CARDANO_DEFAULTS = {
  /** Maximum ADA supply in lovelace (45 billion ADA) */
  MAX_LOVELACE_SUPPLY: '45000000000000000',
  /** Slots per epoch (mainnet/testnets) */
  SLOTS_PER_EPOCH: 432_000,
  /** Milliseconds per slot */
  MS_PER_SLOT: 1000,
};

/**
 * Default execution units for Plutus scripts
 * Used when dynamic evaluation is not available
 */
export const DEFAULT_EXECUTION_UNITS = {
  /** Memory units for script execution */
  mem: 14_000_000,
  /** CPU steps for script execution */
  cpu: 10_000_000_000,
};

/**
 * High execution units for initial transaction build (before evaluation)
 * Set higher than DEFAULT to ensure fee estimation is sufficient before actual evaluation
 */
export const HIGH_EXECUTION_UNITS = {
  /** Memory units - high for evaluation pass */
  mem: 28_000_000,
  /** CPU steps - high for evaluation pass */
  cpu: 20_000_000_000,
};

/**
 * Execution unit buffer multiplier (10% safety margin)
 */
export const EXECUTION_UNIT_BUFFER = 1.1;

/**
 * Transaction building constants
 */

  /** Buffer for witness set CBOR overhead when signing adds ~44 bytes */
export const  WITNESS_BUFFER_BYTES =  50;


export const HRP = {
  mainnet: { addr: /^addr1[0-9a-z]{50,100}$/, stake: /^stake1[0-9a-z]{53,}$/ },
  preview: { addr: /^addr_test1[0-9a-z]{50,100}$/, stake: /^stake_test1[0-9a-z]{53,}$/ },
  preprod: { addr: /^addr_test1[0-9a-z]{50,100}$/, stake: /^stake_test1[0-9a-z]{53,}$/ },
};

/**
 * Input validation limits to prevent DoS attacks
 */

/** Maximum JSON string length in bytes (1MB) */
export const MAX_JSON_SIZE = 1_048_576;
/** Maximum nesting depth for JSON objects/arrays */
export const MAX_DEPTH = 10;
/** Maximum number of keys in a JSON object */
export const MAX_KEYS = 100;
/** Maximum number of elements in a JSON array */
export const MAX_ARRAY_LENGTH = 1000;
/** Maximum length of a single string value */
export const MAX_STRING_LENGTH = 65536;
/** Maximum ech32 string length to prevent DoS */
export const BECH32_MAX_LENGTH = 2000;
/** Maximum reasonable epoch number */
export const MAX_EPOCH = 100_000;
/** Standard pool ID payload length */
export const POOL_ID_BYTES = 28;
/** Standard DRep ID payload length (1 byte type prefix + 28 byte key hash) */
export const DREP_ID_BYTES = 29;

/** 
 * Transaction hash Regex - 64-character hexadecimal string
 */
export const TX_HASH_REGEX = /^[a-f0-9]{64}$/;

/**
 * Asset unit Regex - policy ID (56 hex chars) + asset name (0-128 hex chars)
 */
export const ASSET_UNIT_REGEX = /^[a-f0-9]{56,192}$/; // policy ID (56) + asset name (0-64 bytes -> 0-128 hex chars)

/**
 *  Pool ID Regex - bech32 with HRP "pool" and 28 bytes payload
 */
export const POOL_ID_REGEX = /^pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{51}$/;

/**
 * DRep ID Regex - bech32 with HRP "drep" and 50-60 chars payload
 */
export const DREP_ID_REGEX = /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;
