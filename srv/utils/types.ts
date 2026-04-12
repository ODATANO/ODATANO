import { LedgerProtocolParameter } from "#cds-models/odatano/cardano";

/**
 *  Hex-encoded string (lower/upper-case depending on source) 
 */
export type Hex = string;

/**
 * Lovelace amount (integer) - represented as string to preserve precision for values > Number.MAX_SAFE_INTEGER.
 * Cardano max supply = 45B ADA = 45,000,000,000,000,000 lovelace (exceeds MAX_SAFE_INTEGER).
 * Provider APIs (Blockfrost, Koios) return lovelace as strings. Harmonic Labs uses bigint internally.
 */
export type Lovelace = number | string;

/** 
 * JSON Value Type - Represents any valid JSON value 
 */
export type JSONValue = | string | number | boolean | { [key: string]: JSONValue } | JSONValue[] | null;

/** 
 * Amount Data Structure Type - Multi-asset amount line as returned by common Cardano APIs 
 */
export interface Amount {
  unit: string;
  quantity: string;
}

/** 
 * Transaction Input Data Structure Type 
 */
export interface TxInputLine {
  address: string;
  amount: Amount[];
  txHash: Hex;
  outputIndex: number;
  dataHash?: Hex | null;
  inlineDatum?: string | null;
  referenceScriptHash?: Hex | null;
  isCollateral?: boolean;
  isReference?: boolean;
}

/** 
 * Transaction Output Data Structure Type 
 */
export interface TxOutputLine {
  address: string;
  amount: Amount[];
  txHash: Hex;
  outputIndex: number;
  dataHash: string | null;
  inlineDatum: string | null;
  isCollateral: boolean;
  referenceScriptHash?: Hex | null;
}

/** 
 * Transaction Data Structure Type - Normalized transaction structure 
 */
export interface Transaction {
  hash: Hex;
  blockHash: Hex;
  blockHeight: number;
  slot: number;
  index: number;
  fee: Lovelace | string;
  deposit: Lovelace | string;
  size: number;
  blockTime: number;
  outputAmount?: Amount[];
  inputs: TxInputLine[];
  outputs: TxOutputLine[];
  metadata?: MetadataLabelTx[];
}

/**
 *  Address Data Structure Type - Address view, including current value and known UTxOs
 */
export interface Address {
  address: string;
  stakeAddress: string | null;
  type: string;
  isScript: boolean;
  amount: Amount[];
  utxos: UTxO[];
  transactions?: Transaction[]; // Optional - loaded separately via getAddressTransactions()
}

/** 
 * UTxO Data Structure Type - Unspent transaction outputs (UTxOs) 
 */
export interface UTxO {
  txHash: Hex;
  outputIndex: number;
  address: string;
  amount: Amount[];
  blockHash?: Hex;
  datumHash?: Hex | null;
  scriptRef?: Hex | null;
  inlineDatum?: string | null;
}

/** 
 * Block Data Structure Type - Basic block information structure
 */
export interface BlockData {
  time: number;
  height: number | null;
  hash: string;
  slot: number | null;
  slotLeader: string;
  epoch: number | null;
  epochSlot: number | null;
  size: number;
  txCount: number;
  fees?: string | null;
}

/** 
 * Supply Data Structure Type - Network supply information
 */
export interface Supply {
  max: string;
  total: string;
  circulating: string;
  locked: string;
  treasury: string;
  reserves: string;
}

/** 
 * Stake Data Structure Type - Network stake information
 */
export interface Stake {
  live: string;
  active: string;
}

/** 
 * Network Information Data Structure Type - Network supply and stake information
 */
export interface NetworkInformation {
  supply: Supply;
  stake: Stake;
}

/** 
 * Epoch Data Structure Type - Epoch information
 */
export interface EpochData {
  epoch: number;
  start_time: number;
  end_time: number;
  first_block_time: number;
  last_block_time: number;
  block_count: number;
  tx_count: number;
  output: string;
  fees: string;
  active_stake: string | null;
}

/** 
 * Metadata Label Transaction Data Structure Type - Transaction metadata under a specific label 
 */
export interface MetadataLabelTx {
  txHash: Hex;
  label: number | string;
  json?: JSONValue;
}

/** 
 * Account Data Structure Type - Stake account information 
 */
export interface AccountData {
  stakeaddress: string;
  active: boolean;
  activeEpoch: number;
  controlledAmount: string;
  rewardsSum: string;
  withdrawalsSum: string;
  reservesSum: string;
  treasurySum: string;
  withdrawableAmount: string;
  poolId: string | null;
  drepId: string | null;
  addresses: Address[];
}

/** 
 * Pool Data Structure Type - Pool information 
 */
export interface PoolData {
  poolId: string;
  vrfKeyHash: string;
  blocksMinted: number;
  blocksEpoch: number;
  liveStake: string;
  liveSize: number;
  liveSaturation: number;
  liveDelegators: number;
  activeStake: string;
  activeSize: number;
  pledge: string;
  margin: number;
  fixedCost: string;
  rewardAccount: string;
}

/** 
 * Drep Data Structure Type - Drep information 
 */
export interface DrepData {
  drepId: string;
  hex: string;
  amount: string;
  hasScript: boolean;
  lastActiveEpoch: number;
  retired: boolean;
  expired: boolean;
}

/** 
 * Ledger Protocol Parameters Data Structure Type - Current protocol parameters 
 */
export type LedgerProtocolParameters = {
  network: string;     // mainnet | preprod | preview (dein ODATANO-Konzept)
  epoch: number;
  // --- Fees / Sizes ---
  minFeeA: number;       // txFeePerByte Mapping
  minFeeB: number;       // txFeeFixed Mapping
  maxBlockSize: number;
  maxTxSize: number;
  maxBlockHeaderSize: number;
  // --- Deposits / Pools ---
  keyDeposit: string;           // Lovelace
  poolDeposit: string;           // Lovelace
  eMax: number;              // poolRetireMaxEpoch Mapping
  nOpt: number;              // stakePoolTargetNum Mapping
  a0: number;      // poolPledgeInfluence Mapping
  rho: number;      // monetaryExpansion Mapping
  tau: number;      // treasuryCut Mapping
  minPoolCost: string;
  // --- Legacy / Misc ---
  decentralisationParam: number; // legacy / pre-conway
  extraEntropy: string | null;
  protocolMajorVer: number;
  protocolMinorVer: number;
  minUtxo: string;      // legacy
  nonce: string;
  // --- Plutus / Execution units ---
  costModels: string;        // JSON blob (map)
  priceMem: number | null;
  priceStep: number | null;
  maxTxExMem: string | null;
  maxTxExSteps: string | null;
  maxBlockExMem: string | null;
  maxBlockExSteps: string | null;
  // --- Babbage+ UTxO cost / Collateral ---
  maxValSize: string | null;
  collateralPercent: number | null;
  maxCollateralInputs: number | null;
  coinsPerUtxoSize: string | null;  // babbage+
  // -- Hauskeeping ---
  fetchedAt: string;
  source: string;              // "blockfrost/koios/direct"
}

/**
 * Mint/Burn Asset Action Type
 */
export type MintAction = {
  /** Asset unit to mint/burn (policyId + assetName) */
  assetUnit: string;
  /** Quantity to mint (positive) or burn (negative) */
  quantity: bigint;
  /** Optional redeemer data (integer). Defaults to 0 if not specified. */
  redeemer?: number;
};

/**
 * Plutus Script Execution Type - For spending from script addresses
 */
export type PlutusScriptExecution = {
  /** Validator script (CBOR hex) */
  validatorScript: string;
  /** The UTxO at the script address to consume */
  scriptUtxo: {
    txHash: string;
    outputIndex: number;
  };
  /** Redeemer data (JSON value that will be converted to PlutusData) */
  redeemer: JSONValue;
  /** Datum data (JSON value, optional - required for hash-based datums) */
  datum?: JSONValue;
  /** Execution units budget for script execution */
  executionUnits?: {
    mem: number;
    cpu: number;
  };
};

/** 
 * Transaction Build Request Type - Parameters for building a transaction, including optional minting and Plutus execution details
 */
export type TxBuildRequest = {
  network: 'mainnet' | 'preprod' | 'preview';
  senderAddress: string;
  recipientAddress: string;
  lovelaceAmount: number;
  changeAddress?: string;
  feeLovelace?: string;
  metadataJson?: JSONValue;
  /** Multi-asset amounts to send (optional) */
  assets?: Amount[];
  /** Mint/Burn actions (optional) */
  mintActions?: MintAction[];
  /** Minting policy script (CBOR hex, required if mintActions specified) */
  mintingPolicyScript?: string;
  /** Plutus script execution (optional) - for spending from script addresses */
  plutusScriptExecution?: PlutusScriptExecution;
  /** Inline datum to attach to the recipient output (optional) - for locking at script addresses */
  outputDatum?: JSONValue;
  /** Required signers - Ed25519 key hashes (hex, 28 bytes each) */
  requiredSigners?: string[];
  /** Script parameters — PlutusData JSON array applied to script before building */
  scriptParams?: JSONValue[];
  /** Optional inline datum for minted token output (PlutusData JSON, parsed) */
  inlineDatum?: JSONValue;
  /** Optional custom redeemer for the minting policy (PlutusData JSON, parsed) */
  mintRedeemer?: JSONValue;
  /** When true, route output to enterprise script address derived from applied script hash */
  lockOnScript?: boolean;
  /**
   * Optional UTxOs that MUST be consumed as inputs. Resolved and added to the TxBuilder
   * BEFORE coin selection runs. Coin selection then only covers the remaining shortfall.
   * Deduplicated against plutusScriptExecution.scriptUtxo in spend transactions.
   * Primary use case: one-shot minting seeds (policy parameterized with a specific TxOutRef).
   */
  forceInputs?: Array<{ txHash: string; outputIndex: number }>;
};

/**
 * Transaction Build Request for Mint/Burn operations - requires mintActions and mintingPolicyScript
 */
export type TxBuildMintRequest = TxBuildRequest & {
  mintActions: MintAction[];
  mintingPolicyScript: string;
};

/**
 * Transaction Build Request for Plutus spending - requires plutusScriptExecution
 */
export type TxBuildPlutusSpendRequest = TxBuildRequest & {
  plutusScriptExecution: PlutusScriptExecution;
};

/**
 * Execution Budget for Plutus scripts
 */
export type ExecutionBudget = {
  memory: number;
  cpu: number;
};

/**
 * Script evaluation result from Ogmios
 */
export type ScriptEvaluationResult = {
  validator: any;
  budget: ExecutionBudget;
};

/**
 * Transaction evaluator function type - evaluates script execution units
 */
export type TxEvaluator = (unsignedTxCbor: string) => Promise<ScriptEvaluationResult[]>;

/**
 * Transaction Build Context Type - Context for building a transaction
 */
export type TxBuildContext = {
  utxos: UTxO[];
  protocolParameters: LedgerProtocolParameter;
  /** Optional evaluator for dynamic script execution unit calculation (requires Ogmios) */
  evaluateTransaction?: TxEvaluator;
};

/**
 *  Transaction Build Result Type 
 */
export type TxBuildResult = {
  senderAddress?: string;
  network?: 'mainnet' | 'preprod' | 'preview';
  builderEngine?: string;
  unsignedTxCbor: string;
  txBodyHash: string;
  feeLovelace: string;
  sizeBytes?: number;
  inputs: Array<{ txHash: string; index: number; lovelace: string }>;
  outputs: Array<{ address: string; lovelace: string }>;
  metaDataCborHex?: string;
  changeOutput?: { address: string; lovelace: string };
  warnings: string[];
  /** Blake2b-224 hash of the script (= policy ID for minting), if a script was provided */
  scriptHash?: string;
  /** Enterprise script address derived from applied script hash (bech32). Set when lockOnScript=true. */
  scriptAddress?: string;
  /** Number of forced inputs actually included in the built transaction (0 if forceInputs was not used). */
  forcedInputsUsed?: number;
};

/**
 * Supported external signer types
 */
export enum ExternalSignerType {
  /** Cardano CLI - Reference implementation for signing */
  CARDANO_CLI = 'cardano-cli',
  /** Browser wallets (Nami, Eternl, Flint, etc.) */
  BROWSER_WALLET = 'browser-wallet',
  /** Hardware wallets (Ledger, Trezor) */
  HARDWARE_WALLET = 'hardware-wallet',
  /** Custom/Unknown signer */
  CUSTOM = 'custom',
  /** Hardware Security Module (server-side PKCS#11) */
  HSM = 'hsm',
}

/**
 * Signing request status
 */
export enum SigningStatus {
  /** Request created, awaiting signing */
  PENDING = 'pending',
  /** Transaction has been signed */
  SIGNED = 'signed',
  /** Signature verified, ready for submission */
  VERIFIED = 'verified',
  /** Transaction submitted to network */
  SUBMITTED = 'submitted',
  /** Signing or verification failed */
  FAILED = 'failed',
  /** Request expired (not signed within TTL) */
  EXPIRED = 'expired',
}

/**
 * Instructions for external signers
 */
export interface SigningInstructions {
  /** Signer type hint (which tool/wallet to use) */
  signerTypeHint: ExternalSignerType;
  /** Human-readable message to display */
  message: string;
  /** Cardano network */
  network: string;
  /** CIP-30 signing request format (for browser wallets) */
  cip30SigningRequest?: {
    /** Transaction CBOR to sign */
    txCbor: string;
    /** Whether to include partial witnesses */
    partialSign: boolean;
  };
}

/**
 * Unsigned transaction export payload for external signers
 *
 * This is the standardized format returned by BuildTransaction actions.
 * External signers use this payload to sign the transaction.
 */
export interface UnsignedTxExportPayload {
  /** Unique identifier for this signing request */
  signingRequestId: string;
  /** Deterministic reference ID linking to the build */
  buildId: string;
  /** Transaction body hash (the data to be signed) */
  txBodyHash: string;
  /** Unsigned transaction CBOR in hex format */
  unsignedTxCbor: string;
  /** Cardano network (mainnet | preprod | preview) */
  network: string;
  /** Timestamp when the request was created (ISO 8601) */
  createdAt: string;
  /** Timestamp when the request expires (ISO 8601) */
  expiresAt: string;
  /** Required signers (public key hashes) if known */
  requiredSigners?: string[];
  /** Signing instructions for the external signer */
  signingInstructions: SigningInstructions;
}

/**
 * Signed transaction submission payload
 */
export interface SignedTxPayload {
  /** Original signing request ID */
  signingRequestId: string;
  /** Build ID from the original build */
  buildId: string;
  /** Signed transaction CBOR */
  signedTxCbor: string;
  /** Signer type used */
  signerType: ExternalSignerType;
  /** Optional: Signer identification (wallet name, etc.) */
  signerInfo?: string;
}

/**
 * Signing workflow state
 */
export interface SigningWorkflowState {
  /** Current status of the signing workflow */
  status: SigningStatus;
  /** Signing request details */
  request: UnsignedTxExportPayload;
  /** Signed transaction (if available) */
  signedTxCbor?: string;
  /** Verification result (if verified) */
  verificationResult?: SignatureVerificationResult;
  /** Transaction hash after submission */
  txHash?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Timestamps for tracking */
  timestamps: {
    created: string;
    signed?: string;
    verified?: string;
    submitted?: string;
    failed?: string;
  };
}

/**
 * Result of signature verification
 */
export interface SignatureVerificationResult {
  /** Whether the signature is valid */
  isValid: boolean;
  /** Transaction body hash from the signed transaction */
  txBodyHash: string;
  /** Number of witnesses (signatures) found */
  witnessCount: number;
  /** List of public key hashes that signed the transaction */
  signerKeyHashes: string[];
  /** Any warnings during verification */
  warnings: string[];
  /** Error message if verification failed */
  errorMessage?: string;
}

/**
 * Options for signature verification
 */
export interface VerificationOptions {
  /** Expected transaction body hash (from the build) */
  expectedTxBodyHash?: string;
  /** Whether to require at least one signature */
  requireSignature?: boolean;
  /** List of required signer key hashes (public key hashes) */
  requiredSigners?: string[];
}

/**
 * HSM Configuration for PKCS#11 integration
 */
export interface HsmConfig {
  /** Whether HSM signing is enabled */
  enabled: boolean;
  /** Path to the PKCS#11 shared library (.so/.dll) */
  pkcs11Module: string;
  /** PKCS#11 slot index */
  slot: number;
  /** PKCS#11 user PIN */
  pin: string;
  /** Key identifier (hex string, e.g., "0x0001") */
  keyId?: string;
  /** Key label for CKA_LABEL lookup */
  keyLabel?: string;
  /** Optional CDS role required for HSM actions (SignWithHsm, SignAndSubmitWithHsm, GetHsmStatus). When set, only users with this role can invoke HSM operations. */
  requiresRole?: string;
}

/**
 * HSM signing result
 */
export interface HsmSignResult {
  /** Ed25519 signature (64 bytes, hex) */
  signatureHex: string;
  /** Ed25519 public key (32 bytes, hex) */
  publicKeyHex: string;
  /** Public key hash (blake2b-224, 28 bytes, hex) */
  publicKeyHash: string;
}