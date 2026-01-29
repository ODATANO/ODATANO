import { LedgerProtocolParameter } from "#cds-models/odatano/cardano";

/**
 *  Hex-encoded string (lower/upper-case depending on source) 
 */
export type Hex = string;

/** 
 * Lovelace amount (integer) - usually represented as number of lovelace (1 ADA = 1,000,000 lovelace) 
 */
export type Lovelace = number;

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
  fee: Lovelace;
  deposit: Lovelace;
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
  transactions: Transaction[];
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
export interface Network {
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
  liveStake: Lovelace;
  liveSize: number;
  liveSaturation: number;
  liveDelegators: number;
  activeStake: Lovelace;
  activeSize: number;
  pledge: Lovelace;
  margin: number;
  fixedCost: Lovelace;
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
};

/**
 * Plutus Script Execution Type - For spending from script addresses
 */
export type PlutusScriptExecution = {
  /** Validator script (CBOR hex) */
  validatorScript: string;
  /** Redeemer data (JSON value that will be converted to PlutusData) */
  redeemer: JSONValue;
  /** Datum data (JSON value, optional - for script outputs) */
  datum?: JSONValue;
  /** Execution units budget for script execution */
  executionUnits?: {
    mem: number;
    cpu: number;
  };
};

/** 
 * Transaction Build Request Type - Parameters for building a simple ADA-only transaction 
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
};

/**
 * Transaction Build Request for Mint/Burn operations - requires mintActions and mintingPolicyScript
 */
export type TxBuildMintRequest = TxBuildRequest & {
  mintActions: MintAction[];
  mintingPolicyScript: string;
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
};