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
 * Execution unit buffer — relative multiplier applied to evaluator output.
 * Combined with ABS_* floors below so small validators also get a meaningful cushion.
 */
export const EXECUTION_UNIT_BUFFER = 1.1;

/**
 * Absolute ExUnits floor added on top of the relative multiplier.
 *
 * Rationale: validators that iterate reference inputs and decode inline CBOR
 * datums (e.g. oracle-consuming mint policies) show a larger ScriptContext →
 * ledger drift than the documented ~10k–30k CPU / ~50–100 mem band — real-world
 * cases overshot a 50k/1k floor by ~27k CPU / ~56 mem, burning the submit fee.
 * The floor is sized to cover reference-input + CBOR-decoding drift on top of
 * the 10% relative multiplier; `max_tx_ex_units` still caps build-time totals,
 * so oversizing here cannot push a tx past network limits — it only trades a
 * few extra lovelace of fee for avoiding an opaque PlutusFailure on submit.
 */
export const ABS_CPU_BUFFER = 200_000;
export const ABS_MEM_BUFFER = 5_000;

/**
 * Transaction building constants
 */

  /** Buffer for witness set CBOR overhead when signing adds ~44 bytes */
export const  WITNESS_BUFFER_BYTES =  50;


/** Collateral amount in lovelace (5 ADA) */
export const COLLATERAL_LOVELACE = 5_000_000n;
/** Fee buffer in lovelace (1 ADA) */
export const FEE_BUFFER_LOVELACE = 1_000_000n;

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
/**
 * Maximum hex length of transaction CBOR accepted by ParseTransactionCbor.
 * Mainnet `maxTxSize` is currently 16 KiB; 64 KiB raw (= 128 KiB hex) leaves
 * generous headroom for future protocol bumps and reference-script outputs
 * while keeping the parser from being a memory-exhaustion vector.
 */
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

/**
 * Shelley-era genesis parameters per network, used to construct Buildooor's
 * GenesisInfos so `TxBuilder.posixToSlot()` can convert validity-window
 * Posix ms into ledger slots. `slotLengthMs` is 1000 ms on all current networks.
 */
export const GENESIS_INFOS_BY_NETWORK = {
  mainnet: { systemStartPosixMs: 1596491091000, slotLengthMs: 1000, startSlotNo: 4492800 },
  preprod: { systemStartPosixMs: 1655683200000, slotLengthMs: 1000, startSlotNo: 0 },
  preview: { systemStartPosixMs: 1666656000000, slotLengthMs: 1000, startSlotNo: 0 },
} as const;

/** Default validity-window start offset: `now - 2 min` to absorb clock skew. */
export const DEFAULT_VALIDITY_START_OFFSET_MS = 120_000;

/** Default validity-window end offset: `now + 1 h` — generous enough for human-latency sign+submit flows. */
export const DEFAULT_VALIDITY_END_OFFSET_MS = 60 * 60 * 1000;

/** Max accepted digits in a Posix-ms string (13 digits covers Unix ms timestamps through ~Nov 2286). */
export const MAX_POSIX_MS_DIGITS = 13;

/**
 * Generic 64-character hex string (used for block hashes and other 32-byte hex identifiers)
 */
export const HEX_64_REGEX = /^[a-f0-9]{64}$/;

/**
 * Generic 56-character hex string — 28-byte hashes (Blake2b-224 / payment credential / script hash / pool key hash).
 */
export const HEX_56_REGEX = /^[a-f0-9]{56}$/;

/**
 * Transaction hash Regex - 64-character hexadecimal string
 */
export const TX_HASH_REGEX = /^[a-f0-9]{64}$/;

/**
 * Asset unit Regex - policy ID (56 hex chars) + asset name (0-128 hex chars)
 */
export const ASSET_UNIT_REGEX = /^[a-f0-9]{56}([a-f0-9]{2})*$/; // policy ID (56) + asset name (0-64 bytes -> 0-128 hex chars, even length)

/**
 *  Pool ID Regex - bech32 with HRP "pool" and 28 bytes payload
 */
export const POOL_ID_REGEX = /^pool1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{51}$/;

/**
 * DRep ID Regex - bech32 with HRP "drep" and 50-60 chars payload
 */
export const DREP_ID_REGEX = /^drep1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,60}$/;
