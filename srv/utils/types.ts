import { LedgerProtocolParameter } from "#cds-models/odatano/cardano";

/** Hex-encoded string (case depends on source) */
export type Hex = string;

/** Lovelace amount; a string preserves precision above Number.MAX_SAFE_INTEGER (max supply is 4.5e16). */
export type Lovelace = number | string;

/** Any valid JSON value */
export type JSONValue = | string | number | boolean | { [key: string]: JSONValue } | JSONValue[] | null;

/** Multi-asset amount line as returned by common Cardano APIs */
export interface Amount {
  unit: string;
  quantity: string;
}

/** Transaction input */
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

/** Transaction output */
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
 * Normalized certificate kinds; unknown types pass through as the raw source string. A Conway
 * stake+vote delegation is split into `pool_delegation` + `vote_delegation` sharing one `certIndex`.
 */
export type CertificateKind =
  | 'stake_registration'
  | 'stake_deregistration'
  | 'pool_delegation'
  | 'vote_delegation'
  | 'pool_registration'
  | 'pool_retirement'
  | 'drep_registration'
  | 'drep_update'
  | 'drep_retirement'
  | 'committee_hot_auth'
  | 'committee_resign'
  | 'genesis_delegation'
  | 'treasury_mir'
  | 'reserve_mir'
  | 'pot_transfer'
  | 'param_proposal'
  | (string & {});

/** One certificate of a transaction (crawler ledger-state coverage). */
export interface TxCertificate {
  /** Position in the transaction's certificate list as the source reports it. */
  certIndex: number;
  kind: CertificateKind;
  /** Reward account (bech32) the certificate concerns, when it has one. */
  stakeAddress?: string | null;
  /** Stake pool (bech32) for delegation / registration / retirement. */
  poolId?: string | null;
  /** DRep (CIP-129 bech32), or `drep_always_abstain` / `drep_always_no_confidence`. */
  drepId?: string | null;
  /** Deposit paid or refunded, lovelace as string. */
  deposit?: Lovelace | string | null;
  /** Retirement epoch of a pool retirement. */
  epoch?: number | null;
}

/** One reward-account withdrawal of a transaction. */
export interface TxWithdrawal {
  stakeAddress: string;
  /** Lovelace as string. */
  amount: Lovelace | string;
}

/** Normalized transaction */
export interface Transaction {
  hash: Hex;
  blockHash: Hex;
  blockHeight: number;
  slot: number;
  index: number;
  /** What the ledger charged: the declared fee, or on a phase-2 failure the collateral consumed. */
  fee: Lovelace | string;
  deposit: Lovelace | string;
  /**
   * True when phase-2 failed: inputs/outputs not applied, collateral consumed, only the collateral
   * return produced. Ogmios (`spends`) and Blockfrost (`valid_contract`) report it; Koios leaves it undefined.
   */
  spendsCollaterals?: boolean;
  /**
   * `total_collateral` from the body when declared; equals the collateral consumed on a phase-2 failure.
   * Null when omitted, the charge is then derived from the resolved collateral inputs minus the return.
   */
  totalCollateral?: Lovelace | string | null;
  /**
   * Signed net mint/burn per unit (negative = burn), never `lovelace`. Ogmios and Koios report it;
   * Blockfrost leaves it undefined and the indexer derives it from resolved input/output assets.
   */
  mint?: Amount[];
  /** Tx size in bytes; null when the source cannot provide it (Ogmios chain-sync). */
  size: number | null;
  blockTime: number;
  outputAmount?: Amount[];
  inputs: TxInputLine[];
  outputs: TxOutputLine[];
  metadata?: MetadataLabelTx[];
  /** Certificates; `[]` when the tx has none, undefined when the source does not report them (Blockfrost). */
  certificates?: TxCertificate[];
  /** Reward-account withdrawals; same `[]` vs undefined convention as `certificates`. */
  withdrawals?: TxWithdrawal[];
}

/** Address view with current value and known UTxOs */
export interface Address {
  address: string;
  stakeAddress: string | null;
  type: string;
  isScript: boolean;
  amount: Amount[];
  utxos: UTxO[];
  transactions?: Transaction[]; // loaded separately via getAddressTransactions()
}

/** Unspent transaction output */
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

/** Basic block information */
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

/** Network supply */
export interface Supply {
  max: string;
  total: string;
  circulating: string;
  locked: string;
  treasury: string;
  reserves: string;
}

/** Network stake */
export interface Stake {
  live: string;
  active: string;
}

/** Network supply and stake */
export interface NetworkInformation {
  supply: Supply;
  stake: Stake;
}

/** Epoch information */
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

/** Transaction metadata under one label */
export interface MetadataLabelTx {
  txHash: Hex;
  label: number | string;
  json?: JSONValue;
}

/** Stake account information */
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

/** Pool information */
export interface PoolData {
  poolId: string;
  vrfKeyHash: string;
  blocksMinted: number;
  /** Blocks minted in the current epoch; null when the backend has no such figure (Koios). */
  blocksEpoch: number | null;
  liveStake: string;
  liveSize: number;
  /** Fraction of the ideal (saturated) pool size, NOT percent: 0.7542 = 75.42 %. */
  liveSaturation: number;
  liveDelegators: number;
  activeStake: string;
  activeSize: number;
  pledge: string;
  margin: number;
  fixedCost: string;
  rewardAccount: string;
}

/** DRep information */
export interface DrepData {
  drepId: string;
  hex: string;
  amount: string;
  hasScript: boolean;
  lastActiveEpoch: number;
  retired: boolean;
  expired: boolean;
}

/** Normalized native-asset metadata and supply; fields a backend does not expose are null. */
export interface AssetInfo {
  unit: string;
  policyId: string;
  assetNameHex: string;
  assetName: string | null;          // UTF-8 when decodable
  fingerprint: string;
  totalSupply: string;                // BigInt-safe decimal string
  mintOrBurnCount: number;
  initialMintTxHash: string | null;
  initialMintTime: number | null;     // Unix seconds; null on Blockfrost
  onchainMetadata: JSONValue | null;  // CIP-25 on-chain metadata (any shape)
  registryName: string | null;
  registryTicker: string | null;
  registryDecimals: number | null;
  registryDescription: string | null;
  registryUrl: string | null;
  registryLogo: string | null;
}

/** One mint or burn event; `quantity` is absolute, the sign lives in `action`. */
export interface AssetHistoryEntry {
  unit: string;
  txHash: string;
  action: 'mint' | 'burn';
  quantity: string;                   // BigInt-safe decimal string; always positive
  blockTime: number | null;           // Unix seconds; null on Blockfrost
  blockHeight: number | null;
}

/** Current protocol parameters */
export type LedgerProtocolParameters = {
  network: string;     // mainnet | preprod | preview
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
  // --- Housekeeping ---
  fetchedAt: string;
  source: string;              // "blockfrost/koios/direct"
}

/** Mint/burn action */
export type MintAction = {
  /** Asset unit to mint/burn (policyId + assetName) */
  assetUnit: string;
  /** Positive to mint, negative to burn */
  quantity: bigint;
  /** Optional integer redeemer, default 0 */
  redeemer?: number;
  /**
   * Per-action minting policy (CBOR hex, applied as-is) for multi-policy transactions; overrides the
   * top-level mintingPolicyScript. The assetUnit must carry this script's policyId.
   */
  mintingPolicyScript?: string;
  /**
   * Per-action redeemer (parsed PlutusData JSON), only with mintingPolicyScript; falls back to mintRedeemer.
   * Actions on the same policy must agree (one redeemer per policy in the ledger).
   */
  redeemerJson?: JSONValue;
};

/** Plutus script execution for spending from a script address */
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
  /** Datum (JSON value), required for hash-based datums */
  datum?: JSONValue;
};

/** Parameters for building a transaction, with optional minting and Plutus execution */
export type TxBuildRequest = {
  network: 'mainnet' | 'preprod' | 'preview';
  senderAddress: string;
  recipientAddress: string;
  // OData Decimal(20,0) arrives as a string at runtime
  lovelaceAmount: string;
  changeAddress?: string;
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
  /** Script parameters (PlutusData JSON array) applied to the script before building */
  scriptParams?: JSONValue[];
  /** Optional inline datum for minted token output (PlutusData JSON, parsed) */
  inlineDatum?: JSONValue;
  /** Optional custom redeemer for the minting policy (PlutusData JSON, parsed) */
  mintRedeemer?: JSONValue;
  /** When true, route output to enterprise script address derived from applied script hash */
  lockOnScript?: boolean;
  /**
   * UTxOs that must be consumed, added before coin selection (one-shot minting seeds);
   * deduplicated against plutusScriptExecution.scriptUtxo.
   */
  forceInputs?: Array<{ txHash: string; outputIndex: number }>;
  /** CIP-31 reference inputs (read-only, not consumed), passed as readonlyRefInputs to Buildooor. */
  referenceInputs?: Array<{ txHash: string; outputIndex: number }>;
  /** Additional outputs after the primary recipient output, before change; each min-ADA checked. */
  extraOutputs?: Array<{
    address: string;
    lovelaceAmount: string;
    assets?: Array<{ unit: string; quantity: string }>;
    inlineDatum?: JSONValue;
    referenceScript?: string;
  }>;
  /** Plutus V3 validator CBOR hex attached as CIP-33 reference script on the recipient output; raises its min-ADA. */
  referenceScript?: string;
  /** Validity start in Posix ms (`invalidBefore`); builder default `now - 120_000` for script builds. */
  validityStartMs?: string;
  /** Validity end in Posix ms (`invalidAfter`, ledger TTL); builder default `now + 3_600_000` for script builds. */
  validityEndMs?: string;
};

/** Mint/burn build request: mintActions and mintingPolicyScript required */
export type TxBuildMintRequest = TxBuildRequest & {
  mintActions: MintAction[];
  mintingPolicyScript: string;
};

/** Plutus spend build request: plutusScriptExecution required */
export type TxBuildPlutusSpendRequest = TxBuildRequest & {
  plutusScriptExecution: PlutusScriptExecution;
};

/** Execution budget for Plutus scripts */
export type ExecutionBudget = {
  memory: number;
  cpu: number;
};

/** Ogmios validator descriptor: `purpose:index` (e.g. "spend:0") or `{ purpose, index }` depending on version */
export type ScriptValidator =
  | string
  | { purpose: string; index: number };

export type ScriptEvaluationResult = {
  validator: ScriptValidator;
  budget: ExecutionBudget;
};

/** Evaluates script execution units of an unsigned tx */
export type TxEvaluator = (unsignedTxCbor: string) => Promise<ScriptEvaluationResult[]>;

/** Context for building a transaction */
export type TxBuildContext = {
  utxos: UTxO[];
  protocolParameters: LedgerProtocolParameter;
  /** Optional evaluator for dynamic script execution unit calculation (requires Ogmios) */
  evaluateTransaction?: TxEvaluator;
  /** CIP-31 reference input UTxOs (read-only, not consumed). Resolved from referenceInputs refs. */
  referenceInputUtxos?: UTxO[];
};

/** Transaction build result */
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
  /** Blake2b-224 hash of the minting policy script (= policy ID), set in combined spend+mint transactions. */
  mintScriptHash?: string;
  /** Enterprise script address derived from applied script hash (bech32). Set when lockOnScript=true. */
  scriptAddress?: string;
  /** Number of forced inputs actually included in the built transaction (0 if forceInputs was not used). */
  forcedInputsUsed?: number;
  /** Number of CIP-31 reference inputs included in the built transaction (0 if referenceInputs was not used). */
  referenceInputsUsed?: number;
};

/** Supported external signer types */
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

/** Signing request status */
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

/** Instructions for external signers */
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
  /** Copy-pasteable cardano-cli signing recipe (for CLI/hardware signers) */
  cardanoCliCommand?: string;
}

/** Unsigned transaction payload returned by the Build actions for external signers */
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

/** Signed transaction submission payload */
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

/** Signing workflow state */
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

/** Result of signature verification */
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

/** Options for signature verification */
export interface VerificationOptions {
  /** Expected transaction body hash (from the build) */
  expectedTxBodyHash?: string;
  /** Whether to require at least one signature */
  requireSignature?: boolean;
  /** List of required signer key hashes (public key hashes) */
  requiredSigners?: string[];
}

/** HSM configuration for PKCS#11 integration */
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
  /** CDS role required for the HSM actions (SignWithHsm, SignAndSubmitWithHsm, GetHsmStatus) */
  requiresRole?: string;
}

/** HSM signing result */
export interface HsmSignResult {
  /** Ed25519 signature (64 bytes, hex) */
  signatureHex: string;
  /** Ed25519 public key (32 bytes, hex) */
  publicKeyHex: string;
  /** Public key hash (blake2b-224, 28 bytes, hex) */
  publicKeyHash: string;
}