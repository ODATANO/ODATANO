import { LedgerProtocolParameter } from "#cds-models/odatano/cardano";

export type Hex = string;
export type Lovelace = number;


// ---------------------------------------------------------------------------------------
// JSON Value Type
// ---------------------------------------------------------------------------------------
export type JSONValue =
  | string
  | number
  | boolean
  | { [key: string]: JSONValue }
  | JSONValue[]
  | null;

// ---------------------------------------------------------------------------------------
// Amount Data Structure Type
// -----------------------------------------------------------------------------

export interface Amount {
  unit: string;
  quantity: string;
}

// ---------------------------------------------------------------------------------------
// Transaction Input Data Structure Type
// -----------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// Transaction Output Data Structure Type
// -----------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// Transaction Data Structure Type
// -----------------------------------------------------------------------------

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
// -----------------------------------------------------------------------------
// Address Data Structure Type
// -----------------------------------------------------------------------------
export interface Address {
  address: string;
  stakeAddress: string | null;
  type: string;
  isScript: boolean;
  amount: Amount[];
  utxos: UTxO[];
}
// -----------------------------------------------------------------------------
// UTxO Data Structure Type
// -----------------------------------------------------------------------------
export interface UTxO {
    txHash: Hex;
    outputIndex: number;
    address: string;
    amount: Amount[];
    blockHash?: Hex;
    datumHash?: Hex | null;
    scriptRef?: Hex | null;
}
// -----------------------------------------------------------------------------
// Block Data Structure Type
// ---------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Supply Data Structure Type
// ---------------------------------------------------------------------------
export interface Supply{
    max: string;
    total: string;
    circulating: string;
    locked: string;
    treasury: string;
    reserves: string;
}

// -----------------------------------------------------------------------------
// Stake Data Structure Type
// ---------------------------------------------------------------------------
export interface Stake{
    live: string;
    active: string;
}

// -----------------------------------------------------------------------------
// Network Information Data Structure Type
// ---------------------------------------------------------------------------
export interface Network{
    supply: Supply;
    stake: Stake;
}

// -----------------------------------------------------------------------------
// Epoch Data Structure Type
// ---------------------------------------------------------------------------
export interface EpochData{
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
// ----------------------------------------------------------------------------
// Transaction MetadataLabelTxData Structure Type
// ---------------------------------------------------------------------------
export interface MetadataLabelTx {
  txHash: Hex;
  label: number | string;
  json?: JSONValue;
}

// ---------------------------------------------------------------------------
// Account Data Structure Type
// ---------------------------------------------------------------------------
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
  drepId : string | null;
  addresses: Address[];
}

// ---------------------------------------------------------------------------
// Pool Data Structure Type
// ---------------------------------------------------------------------------
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
  rewardAccount  : string;
}

// ---------------------------------------------------------------------------
// DREP Data Structure Type
// ---------------------------------------------------------------------------
export interface DrepData {
  drepId: string; 
  hex: string; 
  amount: string;
  hasScript: boolean; 
  lastActiveEpoch: number; 
  retired: boolean; 
  expired: boolean; 
}

export type LedgerProtocolParameters = {
  network : string;     // mainnet | preprod | preview (dein ODATANO-Konzept)
  epoch   : number;
  // --- Fees / Sizes ---
  minFeeA            : number;       // txFeePerByte Mapping
  minFeeB            : number;       // txFeeFixed Mapping
  maxBlockSize       : number;
  maxTxSize          : number;
  maxBlockHeaderSize : number;
  // --- Deposits / Pools ---
  keyDeposit  : string;           // Lovelace
  poolDeposit : string;           // Lovelace
  eMax        : number;              // poolRetireMaxEpoch Mapping
  nOpt        : number;              // stakePoolTargetNum Mapping
  a0          : number;      // poolPledgeInfluence Mapping
  rho         : number;      // monetaryExpansion Mapping
  tau         : number;      // treasuryCut Mapping
    minPoolCost : string;
  // --- Legacy / Misc ---
  decentralisationParam : number; // legacy / pre-conway
  extraEntropy          : string | null;
  protocolMajorVer      : number;
  protocolMinorVer      : number;
  minUtxo               : string;      // legacy
  nonce                 : string;
  // --- Plutus / Execution units ---
  costModels     : string;        // JSON blob (map)
  priceMem       : number | null;
  priceStep      : number | null;
  maxTxExMem     : string | null;
  maxTxExSteps   : string | null;
  maxBlockExMem  : string | null;
  maxBlockExSteps: string | null;
  // --- Babbage+ UTxO cost / Collateral ---
  maxValSize          : string | null;
  collateralPercent   : number | null;
  maxCollateralInputs : number | null;
  coinsPerUtxoSize    : string | null;  // babbage+
  // -- Hauskeeping ---
  fetchedAt : string;
  source    : string;              // "blockfrost/koios/direct"
}

export type TxBuildRequest = {
  network: 'mainnet' | 'preprod' | 'preview';
  senderAddress: string;
  recipientAddress: string;
  lovelaceAmount: number;
  changeAddress?: string;
  feeLovelace?: string;
};


export type TxBuildContext = {
  utxos: UTxO[];
  protocolParameters: LedgerProtocolParameter;
};

export type TxBuildResult = {
  senderAddress?: string;
  network?: 'mainnet' | 'preprod' | 'preview';
  builderEngine?: string;
  unsignedTxCbor: string;
  feeLovelace: string;
  sizeBytes?: number;
  inputs: Array<{ txHash: string; index: number; lovelace: string }>;
  outputs: Array<{ address: string; lovelace: string }>;
  metaDataCborHex?: string;
  changeOutput?: { address: string; lovelace: string };
  warnings: string[];
};