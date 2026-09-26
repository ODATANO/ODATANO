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

/** Common interface every Cardano backend (Blockfrost, Koios, Ogmios, ...) implements. */
export interface CardanoBackend {

  /** Backend name */
  name: string;

  /**
   * Methods this backend declares as NOT supported; the orchestrator skips it for
   * these without counting a circuit-breaker failure.
   */
  readonly unsupportedMethods?: ReadonlySet<string>;

  /** Initialize the backend */
  init(): Promise<boolean>;

  /** Transaction by hash (hex). */
  getTransaction(txHash: string): Promise<Transaction>;

  /** Address data by bech32 address. */
  getAddress(address: string): Promise<Address>;

  /** UTxOs of a bech32 address. */
  getAddressUtxos(address: string): Promise<UTxO[]>;

  /** Transactions involving a bech32 address (lightweight — hashes and basic info). */
  getAddressTransactions(address: string, limit: number): Promise<Transaction[]>;

  /** Network information (supply, stake). */
  getNetworkInformation(): Promise<NetworkInformation>;

  /** Metadata labels of a transaction (hash hex). */
  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]>;

  /** Block by hash (hex). */
  getBlock(blockHash: string): Promise<BlockData>;

  /** Epoch by number. */
  getEpoch(epochNumber: number): Promise<EpochData>;

  /** Latest epoch. */
  getLatestEpoch(): Promise<EpochData>;

  /** Latest block. */
  getLatestBlock(): Promise<BlockData>;

  /** Latest chain tip slot; throws ProviderUnavailableError when the latest block has no slot. */
  getCurrentSlot(): Promise<number>;

  /**
   * Whether a UTxO is still unspent. `false` for txs that don't exist on chain and
   * for out-of-range output indices.
   * @param txHash 64-char lowercase hex
   */
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean>;

  /** Stake pool by id. */
  getPool(poolId: string): Promise<PoolData>;

  /** DRep by id. */
  getDrep(drepId: string): Promise<DrepData>;

  /** Account by stake address. */
  getAccount(accountId: string): Promise<AccountData>;

  /** Asset info (supply, mint history, CIP-25 + CIP-26 metadata); unit = policyId + assetNameHex. */
  getAssetInfo(unit: string): Promise<AssetInfo>;

  /**
   * Latest mint/burn events for an asset (most recent first; limit default 100).
   * Optional — Ogmios doesn't expose this. Blockfrost lacks block timestamps; Koios has block_time per entry.
   */
  getAssetHistory?(unit: string, limit?: number): Promise<AssetHistoryEntry[]>;

  /** Current protocol parameters. */
  getProtocolParameters(): Promise<LedgerProtocolParameters>;

  /** Submit a signed transaction (CBOR hex); returns the tx hash. */
  submitTransaction(signedTxCbor: string): Promise<string>;

  /**
   * Most recent tx hashes of an address (no details).
   * Optional — falls back to getAddressTransactions() mapped to hashes.
   */
  getAddressTransactionHashes?(address: string, limit: number): Promise<string[]>;

  /**
   * Transactions by hash, as a map txHash -> Transaction.
   * Optional — falls back to individual getTransaction() calls.
   */
  getTransactionsBatch?(txHashes: string[]): Promise<Map<string, Transaction>>;

  /**
   * UTxOs across all bech32 addresses sharing a 28-byte payment credential (key or script
   * hash), each with its owning address. Optional — only Koios has this natively.
   * @param credHash 28-byte payment credential as 56-char lowercase hex
   */
  getCredentialUtxos?(credHash: string): Promise<UTxO[]>;
}

/** Backend that can evaluate script execution units (Ogmios). */
export interface EvaluatingBackend extends CardanoBackend {
  /** Evaluate the script execution units of an unsigned transaction (CBOR hex). */
  evaluateTransaction(unsignedTxCbor: string): Promise<ScriptEvaluationResult[]>;
}

/** Type guard: does this backend support transaction evaluation? */
export function isEvaluatingBackend(backend: CardanoBackend): backend is EvaluatingBackend {
  return typeof (backend as EvaluatingBackend).evaluateTransaction === 'function';
}

// -----------------------------------------------------
// Chain crawler / pre-sync — forward iteration
// -----------------------------------------------------

/** A chain position the crawler can start from, stream to, or roll back to. */
export interface ChainPoint {
  slot: number;
  hash: string;
  height?: number;
}

/** Callbacks driven by a streamed chain-sync (Ogmios). */
export interface ChainSyncCallbacks {
  /**
   * A new block (with its full transaction list) extends the chain.
   * @param tip the node's current chain tip when the protocol supplies it (sync progress)
   */
  rollForward(block: BlockData, txs: Transaction[], tip?: ChainPoint): Promise<void>;
  /** The chain rolled back to `point` (or to genesis). All blocks after it are abandoned. */
  rollBackward(point: ChainPoint | 'origin'): Promise<void>;
  /**
   * A message-handler error stalled the stream; no further blocks are requested and the
   * consumer should record the error and close/restart. Optional — otherwise only logged.
   */
  onError?(err: unknown): Promise<void>;
}

/** Handle to an open chain-sync stream. */
export interface ChainSyncHandle {
  /** Stop streaming and release the underlying connection. */
  close(): Promise<void>;
}

/**
 * Backend that streams the chain forward from a point, emitting ordered rollForward and
 * native rollBackward (reorg) events — Ogmios chain-synchronization, the crawler's primary source.
 */
export interface ChainSyncBackend extends CardanoBackend {
  /**
   * Open a chain-sync stream starting just after the first of `from` still on the node's chain.
   * @param from intersection candidates NEWEST FIRST (or 'origin'); include ancestors of the
   *   last-indexed point so a reorg during a disconnect resolves via rollBackward instead of "No intersection found"
   */
  openChainSync(from: ChainPoint[] | 'origin', callbacks: ChainSyncCallbacks): Promise<ChainSyncHandle>;
}

/** Type guard: does this backend support streamed chain-sync? */
export function isChainSyncBackend(backend: CardanoBackend): backend is ChainSyncBackend {
  return typeof (backend as ChainSyncBackend).openChainSync === 'function';
}

/**
 * Backend that reads UTxOs straight from the node's ledger (Ogmios `queryLedgerState/utxo`):
 * the whole set as of a chain point inside the volatile window, or selected outputs at the tip.
 */
export interface LedgerStateBackend extends CardanoBackend {
  queryUtxoSetAt(point: ChainPoint): Promise<UTxO[]>;
  /** Outputs among `refs` that are unspent at the tip; spent or unknown references are absent. */
  getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[]>;
}

export function isLedgerStateBackend(backend: CardanoBackend): backend is LedgerStateBackend {
  return typeof (backend as LedgerStateBackend).queryUtxoSetAt === 'function';
}

/**
 * Backend that walks the chain forward by pagination (no live node) — the crawler's fallback
 * source. Reorgs are not delivered natively; the crawler detects them via parent-hash mismatch.
 */
export interface PaginatingBackend extends CardanoBackend {
  /**
   * Optional: what the crawl wants per block beyond inputs/outputs. A backend that pays per
   * payload (Koios `_certs`/`_withdrawals`) only asks when told to.
   */
  configureCrawl?(options: { certificates: boolean }): void;
  /** Fetch a block by its height. */
  getBlockByHeight(height: number): Promise<BlockData>;
  /**
   * Fetch up to `count` blocks immediately following `afterHash`, in chain order.
   * @param afterHeight height of `afterHash` when known — lets height-listing backends skip a hash→height round-trip
   */
  getNextBlocks(afterHash: string, count: number, afterHeight?: number): Promise<BlockData[]>;
  /** Fetch the full transaction list of a block, in block order. */
  getBlockTransactions(blockHash: string): Promise<Transaction[]>;
}

/** Type guard: can this backend be walked forward by pagination? */
export function isPaginatingBackend(backend: CardanoBackend): backend is PaginatingBackend {
  const b = backend as PaginatingBackend;
  return typeof b.getBlockByHeight === 'function'
    && typeof b.getNextBlocks === 'function'
    && typeof b.getBlockTransactions === 'function';
}

/**
 * Backend that enumerates the full stake-pool and DRep set and resolves them in batches
 * (crawler epoch snapshots). Koios only: `/pool_list` + `POST /pool_info` make a mainnet
 * snapshot a handful of requests; Blockfrost has no batch info endpoint (thousands of calls).
 */
export interface EnumeratingBackend extends CardanoBackend {
  /** All known stake-pool ids (bech32). */
  getPoolIds(): Promise<string[]>;
  /** Resolve a batch of pool ids. Ids the backend does not know are omitted, not faked. */
  getPools(poolIds: string[]): Promise<PoolData[]>;
  /** All known DRep ids (bech32). */
  getDrepIds(): Promise<string[]>;
  /** Resolve a batch of DRep ids. Ids the backend does not know are omitted. */
  getDreps(drepIds: string[]): Promise<DrepData[]>;
}

/** Type guard: can this backend enumerate pools and DReps? */
export function isEnumeratingBackend(backend: CardanoBackend): backend is EnumeratingBackend {
  const b = backend as EnumeratingBackend;
  return typeof b.getPoolIds === 'function'
    && typeof b.getPools === 'function'
    && typeof b.getDrepIds === 'function'
    && typeof b.getDreps === 'function';
}
