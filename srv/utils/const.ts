/** Cardano protocol constants */
export const CARDANO_DEFAULTS = {
  /** Maximum ADA supply in lovelace (45 billion ADA) */
  MAX_LOVELACE_SUPPLY: '45000000000000000',
  /** Milliseconds per slot */
  MS_PER_SLOT: 1000,
};

/**
 * Per-network epoch geometry anchored at the Shelley transition:
 * `epochStartSlot(epoch) = shelleyStartSlot + (epoch - shelleyStartEpoch) * slotsPerEpoch`.
 * Preview epochs are 1 day; mainnet/preprod are offset by their Byron era.
 */
export const EPOCH_CONFIG_BY_NETWORK = {
  mainnet: { shelleyStartEpoch: 208, shelleyStartSlot: 4_492_800, slotsPerEpoch: 432_000 },
  preprod: { shelleyStartEpoch: 4, shelleyStartSlot: 86_400, slotsPerEpoch: 432_000 },
  preview: { shelleyStartEpoch: 0, shelleyStartSlot: 0, slotsPerEpoch: 86_400 },
} as const;

/** Default Plutus execution units when dynamic evaluation is not available */
export const DEFAULT_EXECUTION_UNITS = {
  mem: 14_000_000,
  cpu: 10_000_000_000,
};

/** High execution units for the initial build pass, so the fee estimate holds before evaluation */
export const HIGH_EXECUTION_UNITS = {
  mem: 28_000_000,
  cpu: 20_000_000_000,
};

/** Relative multiplier on evaluator ExUnits; combined with the ABS_* floors below. */
export const EXECUTION_UNIT_BUFFER = 1.1;

/**
 * Absolute ExUnits floor on top of the relative multiplier: covers ScriptContext drift of validators
 * that iterate reference inputs and decode CBOR datums. `max_tx_ex_units` still caps the total.
 */
export const ABS_CPU_BUFFER = 200_000;
export const ABS_MEM_BUFFER = 5_000;

/** Transaction building constants */

/** Collateral amount in lovelace (5 ADA) */
export const COLLATERAL_LOVELACE = 5_000_000n;
/** Fee buffer in lovelace (1 ADA) */
export const FEE_BUFFER_LOVELACE = 1_000_000n;

export const HRP = {
  mainnet: { addr: /^addr1[0-9a-z]{50,100}$/, stake: /^stake1[0-9a-z]{53,}$/ },
  preview: { addr: /^addr_test1[0-9a-z]{50,100}$/, stake: /^stake_test1[0-9a-z]{53,}$/ },
  preprod: { addr: /^addr_test1[0-9a-z]{50,100}$/, stake: /^stake_test1[0-9a-z]{53,}$/ },
};

/** Input validation limits to prevent DoS attacks */

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
/** Max tx CBOR hex accepted by ParseTransactionCbor: 64 KiB raw, well above mainnet maxTxSize (16 KiB). */
export const MAX_TX_CBOR_HEX_LENGTH = 65536 * 2;
/** Maximum reasonable epoch number */
export const MAX_EPOCH = 100_000;
/** Standard pool ID payload length */
export const POOL_ID_BYTES = 28;
/** Standard DRep ID payload length (1 byte type prefix + 28 byte key hash) */
export const DREP_ID_BYTES = 29;

/** Length of a hex-encoded Cardano policy ID (28 bytes = 56 hex chars) */
export const POLICY_ID_HEX_LENGTH = 56;
/** Minimum length of a full asset unit (policyId + at least 1 char assetName) */
export const MIN_FULL_ASSET_UNIT_LENGTH = POLICY_ID_HEX_LENGTH + 1; // 57
/** Length of a hex-encoded Ed25519 key hash (28 bytes = 56 hex chars) */
export const ED25519_KEY_HASH_HEX_LENGTH = 56;
/** Regex for validating Ed25519 key hash hex strings */
export const ED25519_KEY_HASH_REGEX = /^[a-f0-9]{56}$/i;
/** Minimum lovelace for a change output carrying native assets (2 ADA) */
export const MIN_CHANGE_LOVELACE = 2_000_000;

/** Shelley genesis parameters per network for Buildooor's GenesisInfos (`TxBuilder.posixToSlot()`). */
export const GENESIS_INFOS_BY_NETWORK = {
  mainnet: { systemStartPosixMs: 1596491091000, slotLengthMs: 1000, startSlotNo: 4492800 },
  preprod: { systemStartPosixMs: 1655683200000, slotLengthMs: 1000, startSlotNo: 0 },
  preview: { systemStartPosixMs: 1666656000000, slotLengthMs: 1000, startSlotNo: 0 },
} as const;

/** Default validity-window start offset: `now - 2 min` to absorb clock skew. */
export const DEFAULT_VALIDITY_START_OFFSET_MS = 120_000;

/** Default validity-window end offset: `now + 1 h`, enough for human-latency sign+submit flows. */
export const DEFAULT_VALIDITY_END_OFFSET_MS = 60 * 60 * 1000;

/** Max accepted digits in a Posix-ms string (13 digits covers Unix ms timestamps through ~Nov 2286). */
export const MAX_POSIX_MS_DIGITS = 13;

/** Generic 64-character hex string (block hashes and other 32-byte identifiers) */
export const HEX_64_REGEX = /^[a-f0-9]{64}$/;

/** Generic 56-character hex string: 28-byte hashes (Blake2b-224, payment credential, script hash, pool key hash) */
export const HEX_56_REGEX = /^[a-f0-9]{56}$/;

/** Transaction hash: 64-character hex string */
export const TX_HASH_REGEX = /^[a-f0-9]{64}$/;

/** Asset unit: policy ID (56 hex) + asset name (0-32 bytes = 0-64 hex, even length; total <= 120 = String(120) key column) */
export const ASSET_UNIT_REGEX = /^[a-f0-9]{56}([a-f0-9]{2}){0,32}$/;

/** Pool ID: bech32 with HRP "pool" and 28-byte payload */
export const POOL_ID_REGEX = /^pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{51}$/;

/** DRep ID: bech32 with HRP "drep" and 50-60 chars payload */
export const DREP_ID_REGEX = /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;
