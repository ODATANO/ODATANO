import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData,
  LedgerProtocolParameters
} from '../../utils/types';

/**
 * CardanoBackend - Interface Definition for multiple backends (Blockfrost, Koios, Ogmios, etc.)
 * 
 * Defines the standard methods that any Cardano backend must implement to be used interchangeably.
 */
export interface CardanoBackend {

  /** 
   * Backend name 
   */
  name: string;

  /**
   * Initialize the backend 
   */
  init(): Promise<void>;

  /**
   * Get Transaction Data
   * @param txHash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  getTransaction(txHash: string): Promise<Transaction>;

  /** 
   * Get Address Data
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  getAddress(address: string): Promise<Address>;

  /**
   * Get Address UTxOs
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  getAddressUtxos(address: string): Promise<UTxO[]>;

  /**
   * Get Network Information
   * @returns {Promise<Network>} network information
   */
  getNetworkInformation(): Promise<Network>;

  /**
   * Get Transaction Metadata
   * @param txHash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]>;

  /** 
   * Get Block Data
   * @param blockHash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  getBlock(blockHash: string): Promise<BlockData>;

  /**
   * Get Epoch Data
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  getEpoch(epochNumber: number): Promise<EpochData>;

  /** 
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  getLatestEpoch(): Promise<EpochData>;

  /** 
   * Get Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  getLatestBlock(): Promise<BlockData>;

  /** 
   * Get Pool Data
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  getPool(poolId: string): Promise<PoolData>;

  /** 
   * Get Drep Data
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  getDrep(drepId: string): Promise<DrepData>;

  /**
   * Get Account Data
   * @param accountId account id
   * @returns {Promise<AccountData>} account data
   */
  getAccount(accountId: string): Promise<AccountData>;

  /**
   * Get Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  getProtocolParameters(): Promise<LedgerProtocolParameters>;

  /**
   * Submit a signed transaction to the network
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  submitTransaction(signedTxCbor: string): Promise<string>;
}

/**
 * Extended backend interface for backends that support transaction evaluation (e.g., Ogmios)
 */
export interface EvaluatingBackend extends CardanoBackend {
  /**
   * Evaluate transaction script execution units
   * @param unsignedTxCbor unsigned transaction in CBOR hex format
   * @returns evaluation results with validator and budget
   */
  evaluateTransaction(unsignedTxCbor: string): Promise<Array<{validator: unknown, budget: {memory: number, cpu: number}}>>;
}

/**
 * Type guard to check if a backend supports transaction evaluation
 * @param backend - The backend to check
 * @returns true if the backend supports evaluateTransaction
 */
export function isEvaluatingBackend(backend: CardanoBackend): backend is EvaluatingBackend {
  return typeof (backend as EvaluatingBackend).evaluateTransaction === 'function';
}
