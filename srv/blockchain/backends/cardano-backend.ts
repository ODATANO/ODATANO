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

  name: string;

  /** Methods this backend does not support. The orchestrator skips them without a circuit-breaker failure. */
  readonly unsupportedMethods?: ReadonlySet<string>;

  init(): Promise<boolean>;

  /** Transaction by hash (hex). */
  getTransaction(txHash: string): Promise<Transaction>;

  /** Address data by bech32 address. */
  getAddress(address: string): Promise<Address>;

  /** UTxOs of a bech32 address. */
  getAddressUtxos(address: string): Promise<UTxO[]>;

  /** Transactions involving a bech32 address (hashes and basic info only). */
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

  /** Whether a UTxO is still unspent. `false` for unknown txs and out-of-range output indices. */
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean>;

  /** Stake pool by id. */
  getPool(poolId: string): Promise<PoolData>;

  /** DRep by id. */
  getDrep(drepId: string): Promise<DrepData>;

  /** Account by stake address. */
  getAccount(accountId: string): Promise<AccountData>;

  /** Asset info (supply, mint history, CIP-25 + CIP-26 metadata); unit = policyId + assetNameHex. */
  getAssetInfo(unit: string): Promise<AssetInfo>;

  /** Latest mint and burn events of an asset, newest first. Blockfrost has no block timestamps here. */
  getAssetHistory?(unit: string, limit?: number): Promise<AssetHistoryEntry[]>;

  /** Current protocol parameters. */
  getProtocolParameters(): Promise<LedgerProtocolParameters>;

  /** Submit a signed transaction (CBOR hex); returns the tx hash. */
  submitTransaction(signedTxCbor: string): Promise<string>;

  /** Most recent tx hashes of an address. Callers fall back to getAddressTransactions(). */
  getAddressTransactionHashes?(address: string, limit: number): Promise<string[]>;

  /** Transactions by hash. Callers fall back to single getTransaction() calls. */
  getTransactionsBatch?(txHashes: string[]): Promise<Map<string, Transaction>>;

  /** UTxOs of every address with this payment credential (56 hex chars), each with its address. */
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
// Chain crawler: forward iteration
// -----------------------------------------------------

/** A chain position the crawler can start from, stream to, or roll back to. */
export interface ChainPoint {
  slot: number;
  hash: string;
  height?: number;
}

/** Callbacks driven by a streamed chain-sync (Ogmios). */
export interface ChainSyncCallbacks {
  /** A new block with all its transactions extends the chain. `tip` is the node's tip when known. */
  rollForward(block: BlockData, txs: Transaction[], tip?: ChainPoint): Promise<void>;
  /** The chain rolled back to `point` (or to genesis). All blocks after it are abandoned. */
  rollBackward(point: ChainPoint | 'origin'): Promise<void>;
  /** A handler error stalled the stream. The consumer should record it and restart the stream. */
  onError?(err: unknown): Promise<void>;
}

/** Handle to an open chain-sync stream. */
export interface ChainSyncHandle {
  /** Stop streaming and release the underlying connection. */
  close(): Promise<void>;
}

/** Backend that streams the chain forward with native rollback events (Ogmios chain-sync). */
export interface ChainSyncBackend extends CardanoBackend {
  // Streams from just after the first point of `from` still on the chain. Pass points newest first,
  // with ancestors of the last indexed block, so a reorg while offline still finds an intersection.
  openChainSync(from: ChainPoint[] | 'origin', callbacks: ChainSyncCallbacks): Promise<ChainSyncHandle>;
}

/** Type guard: does this backend support streamed chain-sync? */
export function isChainSyncBackend(backend: CardanoBackend): backend is ChainSyncBackend {
  return typeof (backend as ChainSyncBackend).openChainSync === 'function';
}

// Backend that reads UTxOs from the node's ledger (Ogmios `queryLedgerState/utxo`).
// The whole set needs a point inside the volatile window. Selected outputs are read at the tip.
export interface LedgerStateBackend extends CardanoBackend {
  queryUtxoSetAt(point: ChainPoint): Promise<UTxO[]>;
  /** Outputs among `refs` that are unspent at the tip; spent or unknown references are absent. */
  getUnspentOutputs(refs: Array<{ txHash: string; outputIndex: number }>): Promise<UTxO[]>;
}

export function isLedgerStateBackend(backend: CardanoBackend): backend is LedgerStateBackend {
  return typeof (backend as LedgerStateBackend).queryUtxoSetAt === 'function';
}

// Backend that walks the chain forward by pagination, without a live node.
// It reports no rollbacks. The crawler detects them by a parent-hash mismatch.
export interface PaginatingBackend extends CardanoBackend {
  /** Extra data the crawl wants per block. Payloads that cost extra are only fetched when asked. */
  configureCrawl?(options: { certificates: boolean }): void;
  /** Fetch a block by its height. */
  getBlockByHeight(height: number): Promise<BlockData>;
  /** Up to `count` blocks after `afterHash` in chain order. `afterHeight` saves a height lookup. */
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

// Backend that lists all pools and DReps and resolves them in batches, for epoch snapshots.
// Blockfrost has no batch info endpoint, so it does not implement this.
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

/** Network-wide ledger state read at one block for an epoch snapshot; unreported figures are null. */
export interface EpochLedgerState {
  /** Epoch the ledger was in at the acquired block. */
  epoch: number;
  pools: PoolData[];
  /** Registered DReps only; the two predefined DReps are summed into the stake fields below. */
  dreps: DrepData[];
  treasury: string | null;
  reserves: string | null;
  drepAbstainStake: string | null;
  drepNoConfidenceStake: string | null;
}

// Backend that reads all pools and DReps from the node's ledger at a block (Ogmios).
// The block must be inside the node's volatile window of k blocks.
export interface EpochStateBackend extends CardanoBackend {
  epochStateAt(point: ChainPoint): Promise<EpochLedgerState>;
}

/** Type guard: can this backend read epoch state at a block? */
export function isEpochStateBackend(backend: CardanoBackend): backend is EpochStateBackend {
  return typeof (backend as EpochStateBackend).epochStateAt === 'function';
}

/** Type guard: can this backend enumerate pools and DReps? */
export function isEnumeratingBackend(backend: CardanoBackend): backend is EnumeratingBackend {
  const b = backend as EnumeratingBackend;
  return typeof b.getPoolIds === 'function'
    && typeof b.getPools === 'function'
    && typeof b.getDrepIds === 'function'
    && typeof b.getDreps === 'function';
}
