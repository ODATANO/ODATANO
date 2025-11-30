export type Hex = string;
export type Lovelace = number;

export type JSONValue =
  | string
  | number
  | boolean
  | { [key: string]: JSONValue }
  | JSONValue[]
  | null;
export interface Amount {
  unit: string;
  quantity: string;
}

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

export interface Transaction {
  hash: Hex;
  blockHash: Hex;
  blockHeight: number;
  slot: number;
  index: number;
  fee: Lovelace;
  deposit: Lovelace;
  size: number;
  utxoCount: number;
  withdrawalCount: number;
  mirCertCount: number;
  delegationCount: number;
  stakeCertCount: number;
  poolUpdateCount: number;
  poolRetireCount: number;
  assetMintOrBurnCount: number;
  redeemerCount: number;
  validContract: boolean;
  blockTime: number;
  outputAmount?: Amount[];
  inputs: TxInputLine[];
  outputs: TxOutputLine[];
  metadata?: unknown;
}

export interface Address {
  address: string;
  stakeAddress: string | null;
  type: string;
  isScript: boolean;
  amount: Amount[];
}

export interface UTxO {
    txHash: Hex;
    outputIndex: number;
    address: string;
    amount: Amount[];
    blockHash?: Hex;
    datumHash?: Hex | null;
    scriptRef?: Hex | null;
}

export interface LatestBlock {
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

export interface Supply{
    max: string;
    total: string;
    circulating: string;
    locked: string;
    treasury: string;
    reserves: string;
}

export interface Stake{
    live: string;
    active: string;
}

export interface Network{
    supply: Supply;
    stake: Stake;
}

export interface LatestEpoch{
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

export interface MetadataLabel {
  label: string;
}

export interface MetadataLabelTx {
  label: number | string;
  txHash: Hex;
  json?: JSONValue;
}
