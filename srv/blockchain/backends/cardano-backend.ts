import {
  Transaction,
  Address,
  UTxO,
  NetworkInformation,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData,
  AssetInfo,
  AssetHistoryEntry,
  LedgerProtocolParameters,
  ScriptEvaluationResult
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
  init(): Promise<boolean>;

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
   * Get Address Transactions (lightweight - only tx hashes and basic info)
   * @param address bech32 address
   * @returns {Promise<Transaction[]>} list of transactions involving this address
   */
  getAddressTransactions(address: string, limit: number): Promise<Transaction[]>;

  /**
   * Get Network Information
   * @returns {Promise<NetworkInformation>} network information
   */
  getNetworkInformation(): Promise<NetworkInformation>;

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
   * Get the latest chain tip slot.
   * Throws ProviderUnavailableError when the backend's latest block has no slot.
   * @returns {Promise<number>} current chain slot
   */
  getCurrentSlot(): Promise<number>;

  /**
   * Check whether a UTxO is still unspent. Returns `false` for txs that don't
   * exist on chain and for out-of-range output indices.
   * @param txHash 64-char lowercase hex
   * @param outputIndex non-negative integer
   * @returns {Promise<boolean>} true iff the UTxO exists and is unspent
   */
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean>;

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
   * Get Asset Info (supply, mint history, CIP-25 + CIP-26 metadata)
   * @param unit policyId + assetNameHex (concatenated hex)
   * @returns {Promise<AssetInfo>} canonical asset info
   */
  getAssetInfo(unit: string): Promise<AssetInfo>;

  /**
   * Get latest mint/burn events for an asset (most recent first).
   * Optional — Ogmios doesn't expose this. Blockfrost lacks block timestamps;
   * Koios includes block_time per entry.
   * @param unit policyId + assetNameHex (concatenated hex)
   * @param limit max number of events (default 100)
   * @returns {Promise<AssetHistoryEntry[]>} list of mint/burn events
   */
  getAssetHistory?(unit: string, limit?: number): Promise<AssetHistoryEntry[]>;

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

  /**
   * Get transaction hashes for an address (lightweight — no full tx details).
   * Used by the indexer to separate hash listing from detail fetching.
   * Optional: falls back to getAddressTransactions() + map to hashes if not implemented.
   * @param address bech32 address
   * @param limit maximum number of transaction hashes to return
   * @returns {Promise<string[]>} list of transaction hashes (most recent first)
   */
  getAddressTransactionHashes?(address: string, limit: number): Promise<string[]>;

  /**
   * Batch fetch multiple transactions by hash.
   * Koios implements natively via POST /tx_info; Blockfrost uses concurrency-limited parallel calls.
   * Optional: falls back to individual getTransaction() calls if not implemented.
   * @param txHashes array of transaction hashes (hex)
   * @returns {Promise<Map<string, Transaction>>} map of txHash -> Transaction
   */
  getTransactionsBatch?(txHashes: string[]): Promise<Map<string, Transaction>>;

  /**
   * Get UTxOs across all bech32 addresses sharing a 28-byte payment credential
   * (key hash or script hash). Returns UTxOs with their owning bech32 address.
   * Optional — only Koios implements this natively (`POST /credential_utxos`).
   * @param credHash 28-byte payment credential as 56-char lowercase hex
   * @returns {Promise<UTxO[]>} list of UTxOs across all bech32 forms
   */
  getCredentialUtxos?(credHash: string): Promise<UTxO[]>;
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
  evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]>;
}

/**
 * Type guard to check if a backend supports transaction evaluation
 * @param backend - The backend to check
 * @returns true if the backend supports evaluateTransaction
 */
export function isEvaluatingBackend(backend: CardanoBackend): backend is EvaluatingBackend {
  return typeof (backend as EvaluatingBackend).evaluateTransaction === 'function';
}
