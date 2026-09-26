import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { ChainSyncBackend, ChainSyncHandle, ChainPoint, PaginatingBackend } from '../backends/cardano-backend';
import type { BlockData, Transaction } from '../../utils/types';
import { ChainSyncFrameError, ProviderUnavailableError } from '../../utils/errors';
import { chunk, IN_CHUNK } from '../../utils/collections';
import { EPOCH_CONFIG_BY_NETWORK } from '../../utils/const';
import { emitBlockIndexed, emitReorg } from './hooks';
import { undoLedgerForTransactions } from '../ledger-state';
import { deleteTransactionRows, type TxKey } from '../transaction-rows';
import {
  Blocks,
  Transactions,
  AddressTransactions,
  AddressUTxOs,
  UTxOAssets,
  // the entity name is already plural-ish, so the typer's plural (array) class
  // carries a trailing underscore — that's the CQL-target class, like Blocks/Transactions
  AssetHistory_ as AssetHistory,
  CardanoReorgLog,
  PoolEpochSnapshots,
} from '#cds-models/odatano/cardano';
import {
  ensureSyncStateSingleton,
  readCursor,
  setUtxoSetState,
  advanceCursor,
  resetCursorTo,
  setSyncStatus,
  recordError,
  tryAcquireCrawlerLease,
  renewCrawlerLease,
  releaseCrawlerLease,
  latchPoisonBlock,
  CRAWLER_LEASE_TTL_MS,
  MAX_CONSECUTIVE_ERRORS,
  type CrawlPoint,
  type CrawlSyncStatusValue,
} from './sync-state';

const { SELECT, DELETE, INSERT } = cds.ql;
const logger = cds.log('CardanoCrawler');

const CHAIN_POINT_MISMATCH_PREFIX = 'CHAIN_POINT_MISMATCH:';

class CrawlerStoppedError extends Error {
  constructor() { super('Crawler stopped'); this.name = 'CrawlerStoppedError'; }
}

class CrawlerLeaseLostError extends Error {
  constructor() { super('Crawler DB lease lost'); this.name = 'CrawlerLeaseLostError'; }
}

/** The source a running crawler is currently ingesting from. */
export type CrawlSource = 'chain-sync' | 'pagination';

/** Runtime configuration for the chain crawler (loaded from cds.requires by the server). */
export interface CrawlerConfig {
  enabled: boolean;
  /** Pre-sync origin. Required (slot+hash) when enabled; the crawler resumes from here on a fresh DB. */
  startSlot?: number;
  startBlockHash?: string;
  startHeight?: number;
  /** 'ogmios' = chain-sync only, 'pagination' = Blockfrost/Koios only, 'auto' = chain-sync if available else pagination. */
  source: 'ogmios' | 'pagination' | 'auto';
  /** Blocks fetched per catch-up round (pagination path). */
  batchSize: number;
  /** Stay this many blocks behind the tip to avoid the volatile chain edge. */
  confirmationDepth: number;
  /** Poll cadence when caught up / on transient errors (pagination path). */
  pollIntervalMs: number;
  /** Write mint/burn rows into AssetHistory. Free — no provider call. */
  assetHistory: boolean;
  /**
   * `off` — nothing; `bare` — one Assets row per unit from block data alone (free);
   * `enrich` — additionally resolve supply/registry data in the background, rate limited.
   */
  assetCatalogue: 'off' | 'bare' | 'enrich';
  /** Units per second the background enrichment resolves (`assetCatalogue: 'enrich'` only). */
  assetEnrichRate: number;
  /** Snapshot every pool and DRep at each epoch boundary. Requires an enumerating backend (Koios). */
  epochSnapshots: boolean;
  /**
   * Write TransactionCertificates + TransactionWithdrawals per block (ledger-state
   * coverage). Free on Ogmios chain-sync and Koios; Blockfrost does not report them.
   */
  certificates: boolean;
  /**
   * Maintain the crawler-fed UTxO set (`LedgerUTxOs` / `LedgerAddresses` / `LedgerAccounts`).
   * Needs a one-off snapshot import (`importUtxoSet`) to become active.
   */
  utxoSet: boolean;
}

/**
 * Pre-sync engine: streams the chain forward from a start block and bulk-indexes it. Sources:
 * Ogmios chain-sync (primary, native rollBackward) or Blockfrost/Koios pagination (fallback).
 * Per-block writes are atomic; stop() awaits the detached pipeline; no implicit genesis crawl.
 */
export class CardanoCrawler {
  /** Transient-failure retries per block before giving up. */
  private static readonly PERSIST_RETRIES = 3;
  /** Final persist failures for the same block across restarts before the crawler latches off (poison block). */
  private static readonly POISON_BLOCK_THRESHOLD = 5;
  /** Process-wide, survives instance restarts: the block currently failing and how often. */
  private static poison: { hash: string; failures: number } | null = null;
  /**
   * Errors deterministic for the block's data — only these count towards the poison latch.
   * Outages, statement timeouts and exhausted pools are fixed by a restart and must not latch.
   */
  private static readonly DATA_REJECTION_PATTERNS: readonly RegExp[] = [
    /unsupported unicode escape sequence/i, // PostgreSQL: U+0000 inside a JSON document
    /invalid byte sequence for encoding/i,  // PostgreSQL: bytes that are not valid UTF-8
    /out of range for type/i,               // PostgreSQL: bigint / integer overflow
    /invalid input syntax for type/i,       // PostgreSQL: NaN or text in a numeric column
    /value too long for type/i,             // PostgreSQL: varchar(n) exceeded
    /numeric value out of range/i,          // HANA / SQL-92
    /inserted value too large for column/i, // HANA
    /string or blob too big/i,              // SQLite
    /datatype mismatch/i,                   // SQLite
  ];
  /** Timeout for direct backend calls (the crawler bypasses the client's resilience layer). */
  private static readonly CALL_TIMEOUT_MS = 60_000;
  /** Epoch snapshots are ~100 batched provider requests on mainnet; wider bound, cancelled by beginHalt. */
  private static readonly SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
  /** Backoff after a failed snapshot attempt, doubling up to the cap; the marker is only set on success. */
  private static readonly SNAPSHOT_RETRY_BASE_MS = 30_000;
  private static readonly SNAPSHOT_RETRY_MAX_MS = 10 * 60_000;
  /** Retry cadence for a chain-sync backend's init while the crawl runs on pagination. */
  private static readonly CHAIN_SYNC_RETRY_MS = 30_000;

  private running = false;
  private chainSyncHandle: ChainSyncHandle | null = null;
  /** What the ingest loop is currently reading from; null while stopped. */
  private activeSource: CrawlSource | null = null;
  /** Chain-sync init retry while on pagination: own timer, in-flight probe, outcome. */
  private chainSyncProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private chainSyncProbe: Promise<void> | null = null;
  private chainSyncRecovered = false;
  /** The detached ingest pipeline — awaited by stop() so teardown never races it. */
  private pipeline: Promise<void> | null = null;
  /** Resolver that cancels a pending poll sleep (set while sleeping). */
  private wake: (() => void) | null = null;
  /** Cancellers for backend waits, so shutdown is not held hostage by their timeout. */
  private readonly callCancels = new Set<() => void>();
  /** Chain-sync callback promises outlive openChainSync(); stop() explicitly drains them. */
  private readonly inFlightCallbacks = new Set<Promise<unknown>>();
  private haltPromise: Promise<void> | null = null;
  /** An unparseable chain-sync frame; the ingest loop fetches that block via pagination, then reopens chain-sync. */
  private frameFailure: ChainSyncFrameError | null = null;
  /** Resolves the ingest loop's wait for the current chain-sync stream to end. */
  private streamEnded: (() => void) | null = null;
  private finalStatus: CrawlSyncStatusValue = 'stopped';
  /** Set only by an unrecoverable halt — clears desiredRunning so restarts stay down. */
  private latchOnHalt = false;
  /** Epoch whose pool/DRep snapshot this process has settled, and the in-flight attempt. */
  private snapshotedEpoch: number | null = null;
  private snapshotInFlight: Promise<void> | null = null;
  /** Consecutive snapshot failures and the earliest time the next attempt may run. */
  private snapshotFailures = 0;
  private snapshotRetryAfter = 0;
  private leaseHeld = false;
  private leaseHeartbeat: Promise<void> | null = null;
  private leaseWake: (() => void) | null = null;

  constructor(
    private readonly client: CardanoClient,
    private readonly indexer: CardanoIndexer,
    private readonly network: string,
    private readonly config: CrawlerConfig,
    /** Present for production instances created by index.ts; omitted in engine unit tests. */
    private readonly leaseOwner?: string,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /** True once the crawler halted because of a failure (not via stop() or a lost lease). */
  haltedWithError(): boolean {
    return !this.running && this.finalStatus === 'error';
  }

  /** Source ingested from right now, or null while not running (a crawl degraded to pagination still advances the cursor). */
  getActiveSource(): CrawlSource | null {
    return this.running ? this.activeSource : null;
  }

  /**
   * Start crawling. Does NOT await the ingest pipeline (fire-and-forget).
   * Refuses to start without a resume point: an explicit configured start block or an
   * existing cursor — never an implicit full-chain sync from genesis.
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (this.haltPromise) await this.haltPromise;

    const start: CrawlPoint | undefined =
      this.config.startSlot != null && this.config.startBlockHash
        ? { slot: this.config.startSlot, hash: this.config.startBlockHash, height: this.config.startHeight }
        : undefined;
    // Keep running=false until every DB guard succeeds. A cursor read/config error
    // must never leave a healthy-looking crawler behind.
    const cursor = await cds.tx((tx) => ensureSyncStateSingleton(tx, this.network, start));

    if (!cursor.lastBlockHash && !start) {
      logger.error('Crawler start refused: no start block configured and no existing cursor — set crawler.startSlot + crawler.startBlockHash.');
      return;
    }

    if (this.leaseOwner) {
      const leaseOwner = this.leaseOwner;
      this.leaseHeld = await cds.tx((tx) => tryAcquireCrawlerLease(tx, leaseOwner));
      if (!this.leaseHeld) {
        logger.info('Crawler start skipped: another instance owns the DB lease or the cluster is paused.');
        return;
      }
    }

    this.running = true;
    // Hand the analytics coverage to the indexer before the first block is written.
    this.indexer.configureCrawlCoverage({
      assetHistory: this.config.assetHistory,
      assetCatalogue: this.config.assetCatalogue,
      assetEnrichRate: this.config.assetEnrichRate,
      certificates: this.config.certificates,
      utxoSet: this.config.utxoSet,
    });
    // Ledger state is only ever applied from a known anchor — no snapshot, no writes.
    if (this.config.utxoSet) {
      const u = cursor.utxoSet;
      // Blocks crawled while the mode was off never reached the ledger tables: the cursor is
      // ahead of the last applied slot and the set cannot be caught up — invalidate it.
      const lastApplied = u.appliedSlot ?? u.anchorSlot;
      if (u.status === 'active' && lastApplied != null && cursor.lastSlot > lastApplied) {
        const error = `cursor at slot ${cursor.lastSlot} is past the last ledger-applied slot ${lastApplied} — blocks were crawled without the set; re-import`;
        await cds.tx((tx) => setUtxoSetState(tx, { status: 'invalid', error }));
        u.status = 'invalid';
        u.error = error;
      }
      if (u.status === 'active' && u.anchorSlot != null && u.anchorHash) {
        this.indexer.setUtxoAnchor({ slot: u.anchorSlot, hash: u.anchorHash });
        logger.info(`UTxO set active from anchor ${u.anchorSlot}/${u.anchorHash} — ledger tables are maintained`);
      } else {
        this.indexer.setUtxoAnchor(null);
        logger.error(
          `crawler.utxoSet is enabled but the UTxO set is "${u.status}"${u.error ? ` (${u.error})` : ''} — ` +
          'ledger tables are not maintained until importUtxoSet has run (pause the crawler first)'
        );
      }
    } else {
      this.indexer.setUtxoAnchor(null);
    }
    this.startLeaseHeartbeat();

    // A pipeline crash (e.g. chain-sync intersection not found after downtime) must
    // surface on the cursor — otherwise the crawler looks healthy while doing nothing.
    this.pipeline = this.runIngestPipeline().catch(async (err) => {
      if (err instanceof CrawlerStoppedError || err instanceof CrawlerLeaseLostError) {
        await this.halt('stopped');
        return;
      }
      logger.error('Ingest pipeline crashed:', err);
      const streak = await this.recordCrawlerError(err);
      await this.halt(streak < 0 ? 'stopped' : 'error');
    });
  }

  /**
   * Stop crawling and await the pipeline's in-flight step, so callers can tear down
   * backends/DB afterwards.
   */
  async stop(finalStatus: CrawlSyncStatusValue = 'stopped'): Promise<void> {
    this.beginHalt(finalStatus);
    if (this.haltPromise) await this.haltPromise;
    this.pipeline = null;
  }

  /**
   * Halt without awaiting the pipeline — safe to call from inside it.
   * @param latch clears `desiredRunning` so no restart brings the crawler back; only for failures
   *   a restart cannot fix (misconfiguration, missing resume point), never for runtime outages.
   */
  private async halt(finalStatus: CrawlSyncStatusValue = 'stopped', latch = false): Promise<void> {
    this.beginHalt(finalStatus, latch);
  }

  /** Start teardown without awaiting it, so tracked callbacks can halt from inside themselves. */
  private beginHalt(finalStatus: CrawlSyncStatusValue, latch = false): void {
    if (latch) this.latchOnHalt = true;
    // Once a real failure was observed, a concurrent shutdown must not hide it.
    if (this.finalStatus !== 'error' || finalStatus === 'error') this.finalStatus = finalStatus;
    this.running = false;
    this.activeSource = null;
    // Background asset enrichment belongs to the crawl — it must not outlive it.
    this.indexer.stopAssetEnrichment();
    this.wake?.(); // cancel a pending poll sleep so the loop exits now
    this.stopChainSyncProbing();
    this.streamEnded?.(); // release the ingest loop — beginHalt awaits the pipeline below
    this.leaseWake?.();
    for (const cancel of [...this.callCancels]) cancel();
    if (this.haltPromise) return;

    this.haltPromise = Promise.resolve().then(async () => {
      const handle = this.chainSyncHandle;
      this.chainSyncHandle = null;
      if (handle) {
        try { await handle.close(); } catch (e) { logger.warn('chain-sync close failed:', e); }
      }

      // Pagination work lives in pipeline; streamed work lives in callback promises.
      // Drain both before releasing the lease or reporting the terminal state.
      const pipeline = this.pipeline;
      if (pipeline) await pipeline.catch(() => undefined);
      while (this.inFlightCallbacks.size) {
        await Promise.allSettled([...this.inFlightCallbacks]);
      }
      if (this.leaseHeartbeat) await this.leaseHeartbeat.catch(() => undefined);
      if (this.chainSyncProbe) await this.chainSyncProbe.catch(() => undefined);

      try {
        if (this.leaseOwner && this.leaseHeld) {
          await cds.tx((tx) => releaseCrawlerLease(tx, this.leaseOwner!, this.finalStatus, this.latchOnHalt));
          this.leaseHeld = false;
        } else if (!this.leaseOwner) {
          await cds.tx((tx) => setSyncStatus(tx, this.finalStatus, this.latchOnHalt));
        }
      } catch { /* best effort during teardown */ }
    });
  }

  private async runIngestPipeline(): Promise<void> {
    while (this.running) {
      const chainSync = this.config.source !== 'pagination' ? this.client.getChainSyncBackend() : null;
      if (chainSync) {
        // One pass per chain-sync stream. An unparseable frame ends the stream, not the crawler:
        // pagination fetches that block, then chain-sync takes over again. Other errors halt.
        while (this.running) {
          const streamEnd = new Promise<void>((resolve) => { this.streamEnded = resolve; });
          await this.runChainSync(chainSync);
          if (!this.chainSyncHandle) return; // open refused, halted, or stop() raced us
          await streamEnd;

          const failure = this.takeFrameFailure();
          if (!this.running || failure?.height == null) return;
          logger.warn(
            `chain-sync cannot deliver block ${failure.height} — switching to pagination until it is behind the cursor`
          );
          await this.runPagination({ untilHeight: failure.height + 1 });
        }
        return;
      }
      if (this.config.source === 'ogmios') {
        // 'ogmios' means chain-sync ONLY — never silently degrade to the weaker
        // pagination reorg handling the operator explicitly opted out of.
        logger.error("Crawler source is 'ogmios' but no chain-sync backend is available — crawler not started (use source 'auto' to allow pagination fallback).");
        await this.halt('error', true); // config error: a restart cannot fix it
        return;
      }
      if (this.config.source === 'pagination') {
        await this.runPagination();
        return;
      }
      // 'auto' with no usable chain-sync backend (typical while the node still replays after a
      // restart): crawl on pagination and keep retrying chain-sync.
      logger.warn('No chain-sync backend usable — crawling on pagination and retrying chain-sync periodically');
      await this.runPagination({ untilChainSync: true });
      // Returned because chain-sync came back (or we stopped): the loop reopens it.
    }
  }

  /**
   * Retry the init of a chain-sync backend on its own timer (a poll sleep can be an hour long),
   * one probe at a time. On success `chainSyncRecovered` is set and a pending sleep is cut short;
   * the pagination loop leaves at its next check and the ingest loop reopens chain-sync.
   */
  private startChainSyncProbing(): void {
    this.chainSyncRecovered = false;
    // The startup init has only just failed — give the node a full interval first.
    this.scheduleChainSyncProbe();
  }

  private scheduleChainSyncProbe(): void {
    if (!this.running || this.chainSyncRecovered || this.chainSyncProbeTimer) return;
    const timer = setTimeout(() => {
      this.chainSyncProbeTimer = null;
      if (!this.running || this.chainSyncRecovered) return;
      this.chainSyncProbe = this.client.recoverChainSyncBackend()
        .then((backend) => {
          if (!backend || !this.running) return;
          this.chainSyncRecovered = true;
          this.wake?.(); // a poll sleep must not hold the handover back
        })
        .catch((err) => logger.debug('chain-sync probe failed:', err))
        .finally(() => {
          this.chainSyncProbe = null;
          this.scheduleChainSyncProbe();
        });
    }, CardanoCrawler.CHAIN_SYNC_RETRY_MS);
    timer.unref?.(); // never keep the process alive for a probe
    this.chainSyncProbeTimer = timer;
  }

  private stopChainSyncProbing(): void {
    if (!this.chainSyncProbeTimer) return;
    clearTimeout(this.chainSyncProbeTimer);
    this.chainSyncProbeTimer = null;
  }

  /** Bound a direct backend call — these bypass the client's timeout/breaker layer. */
  private withTimeout<T>(p: Promise<T>, label: string, ms = CardanoCrawler.CALL_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let cancel: () => void;
      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.callCancels.delete(cancel);
        cb();
      };
      timer = setTimeout(
        () => finish(() => reject(new ProviderUnavailableError(`${label} timed out`, 'crawler', ms))),
        ms,
      );
      timer.unref?.(); // never keep the process alive for a watchdog timer
      cancel = () => finish(() => reject(new CrawlerStoppedError()));
      this.callCancels.add(cancel);
      p.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Chain-sync (Ogmios) — primary, reorg-aware
  // ---------------------------------------------------------------------------

  private async runChainSync(backend: ChainSyncBackend): Promise<void> {
    const cursor = await cds.tx((tx) => readCursor(tx));
    const points = await this.buildIntersectionPoints(cursor);
    if (!points.length) {
      // Defense in depth — start() already refuses this state.
      logger.error('Chain-sync refused: no resume point (configured start block or cursor) available.');
      await this.halt('error', true); // config error: a restart cannot fix it
      return;
    }

    const handle = await backend.openChainSync(points, {
      rollForward: (block, txs, tip) => this.trackCallback(async () => {
        if (!this.running) return;
        await this.persistBlock(block, txs, tip);
      }),
      rollBackward: (point) => this.trackCallback(async () => {
        if (!this.running) return;
        // Ogmios ALWAYS opens the stream with a rollBackward to the intersection
        // point — that is the protocol handshake, not a reorg. Only roll back when
        // the point differs from our cursor.
        const current = await cds.tx((tx) => readCursor(tx));
        if (point !== 'origin' && current?.lastBlockHash === point.hash) {
          logger.debug(`chain-sync intersection acknowledged at slot ${point.slot} — no reorg`);
          return;
        }
        await this.handleReorg(point);
      }),
      onError: (err) => this.trackCallback(async () => {
        if (err instanceof CrawlerStoppedError || err instanceof CrawlerLeaseLostError) return;
        // A frame the client's parser cannot handle is a fault of that one block, not of the
        // crawler or the node — pagination can still fetch it, so degrade instead of halting.
        if (err instanceof ChainSyncFrameError && this.canDegradeToPagination(err)) {
          await this.degradeToPagination(err);
          return;
        }
        // The stream is stalled (mapping/callback failure) — record and halt cleanly
        // so the cursor status shows 'error' instead of a healthy-looking hang.
        const streak = await this.recordCrawlerError(err);
        logger.error('Chain-sync stream error — stopping crawler:', err);
        await this.halt(streak < 0 ? 'stopped' : 'error');
      }),
    });

    // stop() may have raced the async open — close the fresh socket instead of leaking it.
    if (!this.running) {
      try { await handle.close(); } catch { /* best effort */ }
      return;
    }
    this.chainSyncHandle = handle;
    this.activeSource = 'chain-sync';
    logger.info(`Crawler running (chain-sync) from ${points[0].hash} (+${points.length - 1} fallback intersection point(s))`);
  }

  /** Read and clear the pending frame failure, so each stream starts from a clean slate. */
  private takeFrameFailure(): ChainSyncFrameError | null {
    const failure = this.frameFailure;
    this.frameFailure = null;
    return failure;
  }

  /**
   * Whether an unparseable frame can be worked around over HTTP: needs a height, a paginating
   * backend, and a source not pinned to 'ogmios' (chain-sync only).
   */
  private canDegradeToPagination(err: ChainSyncFrameError): boolean {
    return err.height != null
      && this.config.source !== 'ogmios'
      && !!this.client.getPaginatingBackend();
  }

  /**
   * End the chain-sync stream and hand back to the ingest loop, which continues on pagination
   * past the offending block. The error is recorded first so `lastError` names the block.
   */
  private async degradeToPagination(err: ChainSyncFrameError): Promise<void> {
    const streak = await this.recordCrawlerError(err);
    if (streak < 0) { await this.halt('stopped'); return; }
    logger.error('Chain-sync frame unusable — continuing on pagination:', err.message);

    this.frameFailure = err;
    const handle = this.chainSyncHandle;
    this.chainSyncHandle = null;
    if (handle) {
      try { await handle.close(); } catch (e) { logger.warn('chain-sync close failed:', e); }
    }
    this.streamEnded?.();
  }

  /**
   * Candidate intersection points, newest first: the cursor, a ladder of already-crawled
   * ancestors, then the configured start block. If the cursor's block was orphaned while the
   * crawler was down, the node intersects at the last common ancestor and reports a rollBackward.
   */
  private async buildIntersectionPoints(cursor: Awaited<ReturnType<typeof readCursor>>): Promise<ChainPoint[]> {
    const points: ChainPoint[] = [];
    const seen = new Set<string>();
    const add = (p: ChainPoint | null | undefined) => {
      if (!p?.hash || seen.has(p.hash)) return;
      seen.add(p.hash);
      points.push(p);
    };

    if (cursor?.lastBlockHash) {
      add({ slot: cursor.lastSlot, hash: cursor.lastBlockHash, height: cursor.lastHeight });

      // Dense over the last DENSE_DEPTH blocks (real rollbacks are shallow and must intersect
      // exactly), doubling after that for deep-reorg reach without hundreds of points.
      const DENSE_DEPTH = 10;
      const heights: number[] = [];
      const pushHeight = (height: number) => { if (height > 0 && !heights.includes(height)) heights.push(height); };
      for (let step = 1; step <= DENSE_DEPTH; step++) pushHeight(cursor.lastHeight - step);
      for (let step = 16; step <= 1 << 14; step *= 2) pushHeight(cursor.lastHeight - step);
      if (heights.length) {
        const rows = await cds.tx((tx) => tx.run(
          SELECT.from(Blocks).columns('height', 'slot', 'hash').where({ height: { in: heights } }),
        )) as Array<{ height?: number; slot?: number; hash?: string }>;
        for (const row of (rows ?? []).sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0))) {
          if (row.hash && row.slot != null) add({ slot: Number(row.slot), hash: row.hash, height: Number(row.height) });
        }
      }
    }

    if (this.config.startBlockHash && this.config.startSlot != null) {
      add({ slot: this.config.startSlot, hash: this.config.startBlockHash, height: this.config.startHeight });
    }
    return points;
  }

  /** Track streamed callbacks because closing a socket does not imply DB callbacks finished. */
  private trackCallback<T>(callback: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(callback);
    this.inFlightCallbacks.add(promise);
    void promise.then(
      () => this.inFlightCallbacks.delete(promise),
      () => this.inFlightCallbacks.delete(promise),
    );
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Pagination (Blockfrost/Koios) — fallback
  // ---------------------------------------------------------------------------

  /**
   * @param untilHeight return once the cursor reaches it — walks past a block chain-sync
   *   cannot deliver, then hands back.
   * @param untilChainSync retry a chain-sync backend in the background; return once one is usable.
   */
  private async runPagination(opts: { untilHeight?: number; untilChainSync?: boolean } = {}): Promise<void> {
    if (opts.untilChainSync) this.startChainSyncProbing();
    try {
      await this.paginate(opts);
    } finally {
      this.stopChainSyncProbing();
    }
  }

  private async paginate({ untilHeight, untilChainSync = false }: { untilHeight?: number; untilChainSync?: boolean }): Promise<void> {
    const backend = this.client.getPaginatingBackend();
    if (!backend) {
      logger.error('No paginating backend available — cannot crawl without Ogmios or Blockfrost/Koios');
      await this.halt('error', true); // config error: a restart cannot fix it
      return;
    }
    backend.configureCrawl?.({ certificates: this.config.certificates });
    this.activeSource = 'pagination';
    logger.info('Crawler running (pagination)');

    // Tip cache, refreshed only when the cursor reaches the cached target; during catch-up
    // the exact tip is irrelevant.
    let tip: BlockData | null = null;
    let target = Number.NEGATIVE_INFINITY;

    while (this.running) {
      try {
        if (untilChainSync && this.chainSyncRecovered) {
          logger.info('chain-sync backend usable again — leaving pagination');
          return;
        }

        const cursor = await cds.tx((tx) => readCursor(tx));
        if (!cursor?.lastBlockHash) {
          logger.error('Pagination refused: cursor has no resume block hash.');
          await this.halt('error', true); // broken precondition: a restart cannot fix it
          return;
        }

        if (untilHeight != null && cursor.lastHeight >= untilHeight) {
          logger.info(`pagination reached block ${cursor.lastHeight} — handing back to chain-sync`);
          return;
        }

        if (!tip || cursor.lastHeight >= target) {
          tip = await this.withTimeout(this.client.getLatestBlock(), 'getLatestBlock');
          target = (tip.height ?? 0) - this.config.confirmationDepth;
        }
        const tipHeight = tip.height ?? 0;
        // Unknown tip slot must mean "NOT at tip" — a 0-fallback would mark every
        // block 'synced' (block.slot >= 0 is always true).
        const tipPoint: ChainPoint | undefined = tip.slot != null
          ? { slot: tip.slot, hash: tip.hash, height: tipHeight }
          : undefined;

        if (cursor.lastHeight >= target) {
          const statusWritten = await cds.tx(async (tx) => {
            if (this.leaseOwner && !(await renewCrawlerLease(tx, this.leaseOwner))) return false;
            await setSyncStatus(tx, 'synced');
            return true;
          });
          if (!statusWritten) { await this.halt('stopped'); return; }
          await this.pollPause(untilChainSync);
          continue;
        }

        const blocks = await this.withTimeout(
          // pass the cursor height as anchor hint (>0 only — 0 can mean "unknown"
          // on a fresh start without configured startHeight)
          backend.getNextBlocks(cursor.lastBlockHash, this.config.batchSize, cursor.lastHeight > 0 ? cursor.lastHeight : undefined),
          'getNextBlocks',
        );
        if (!blocks.length) { await this.pollPause(untilChainSync); continue; }

        for (const block of blocks) {
          if (!this.running) break;
          if ((block.height ?? 0) > target) break; // stay behind the confirmation window
          const txs = await this.withTimeout(backend.getBlockTransactions(block.hash), 'getBlockTransactions');
          const ok = await this.persistBlock(block, txs, tipPoint);
          if (!ok) return; // persistBlock already recorded + halted
          // Chain-sync came back mid-batch: the block just written is complete and on the
          // cursor, the rest of the batch is cheaper to stream than to fetch one by one.
          if (untilChainSync && this.chainSyncRecovered) break;
        }
      } catch (err) {
        if (!this.running || err instanceof CrawlerStoppedError) return;

        // Only the backend's explicit anchor/hash mismatch proves that our cursor may
        // be orphaned. Provider outages and partial tx responses must back off instead
        // of launching up to 100 additional provider calls.
        if (err instanceof Error && err.message.startsWith(CHAIN_POINT_MISMATCH_PREFIX)) {
          const recovered = await this.tryReorgRecovery(backend).catch(() => false);
          if (recovered) continue;
          if (!this.running) return;
        }

        const streak = await this.recordCrawlerError(err);
        if (streak < 0) { await this.halt('stopped'); return; }
        logger.error(`pagination round failed (error streak ${streak}):`, err);
        if (streak >= MAX_CONSECUTIVE_ERRORS) { await this.halt('error'); return; }
        await this.pollPause(untilChainSync);
      }
    }
  }

  /**
   * Poll pause between pagination rounds; skipped when a chain-sync handover is already due,
   * since the probe's wake-up only reaches a sleep that has begun.
   */
  private async pollPause(untilChainSync: boolean): Promise<void> {
    if (untilChainSync && this.chainSyncRecovered) return;
    await this.sleep(this.config.pollIntervalMs);
  }

  /**
   * Pagination reorg recovery: walk back by height comparing the on-chain block hash with
   * our stored one until they agree — that height is the fork point. If the last-indexed
   * block still matches on-chain, there is no reorg (returns false → treat as transient).
   */
  private async tryReorgRecovery(backend: PaginatingBackend): Promise<boolean> {
    if (!this.running) return false;
    const cursor = await cds.tx((tx) => readCursor(tx));
    if (!cursor || !cursor.lastBlockHash) return false;

    const MAX_DEPTH = 100;
    const floor = Math.max(0, cursor.lastHeight - MAX_DEPTH);
    for (let h = cursor.lastHeight; h > floor; h--) {
      if (!this.running) return false;
      let onChain: BlockData;
      try {
        onChain = await this.withTimeout(backend.getBlockByHeight(h), `getBlockByHeight(${h})`);
      } catch {
        // One unavailable height means the provider cannot currently prove a fork.
        // Abort this recovery round instead of multiplying a provider outage by 100.
        return false;
      }
      if (!this.running) return false;
      const ours = await cds.tx((tx) => tx.run(SELECT.one.from(Blocks).where({ height: h }))) as { hash?: string } | undefined;
      if (ours?.hash && onChain.hash === ours.hash) {
        if (h === cursor.lastHeight) return false; // tip still matches → not a reorg
        // A null provider slot would make forkSlot 0 and wipe the entire crawled dataset —
        // abort this round instead.
        if (onChain.slot == null) return false;
        await this.handleReorg({ slot: onChain.slot, hash: onChain.hash, height: h });
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Persist + reorg (shared)
  // ---------------------------------------------------------------------------

  /**
   * Persist one block atomically and advance the cursor. Transient failures are retried; the
   * cursor is not advanced on failure, so a resume re-syncs from it. Marks 'synced' at the tip.
   * @returns true when the block was persisted, false when the crawler was stopped
   */
  private async persistBlock(block: BlockData, txs: Transaction[], tip?: ChainPoint): Promise<boolean> {
    if (txs.length !== block.txCount) {
      throw new ProviderUnavailableError(
        `Incomplete block ${block.hash}: backend returned ${txs.length}/${block.txCount} transactions`,
        'crawler',
      );
    }
    const isAtTip = tip != null && block.slot != null && block.slot >= tip.slot;

    // Epoch enrichment needs a backend round-trip on epoch boundaries — do it BEFORE
    // opening the write transaction so the DB lock is never held across network I/O.
    if (block.epoch != null) {
      await this.indexer.prefetchCrawlEpoch(block.epoch);
    }

    for (let attempt = 1; ; attempt++) {
      if (!this.running) return false;
      try {
        await cds.tx(async (tx) => {
          if (this.leaseOwner) {
            const renewed = await renewCrawlerLease(tx, this.leaseOwner);
            if (!renewed) throw new CrawlerLeaseLostError();
          }
          await this.indexer.indexBlockFull(tx, block, txs);
          // Ledger progress marker: written in the same statement as the cursor, so "the
          // cursor is ahead of the marker" always means blocks went by without the set.
          const anchor = this.indexer.getUtxoAnchor();
          const ledgerApplied = anchor != null && (block.slot ?? 0) > anchor.slot;
          await advanceCursor(
            tx,
            { slot: block.slot ?? 0, hash: block.hash, height: block.height ?? 0 },
            tip ? { slot: tip.slot, height: tip.height } : undefined,
            isAtTip ? 'synced' : 'syncing',
            ledgerApplied ? { utxoAppliedSlot: block.slot ?? 0 } : undefined,
          );
        });
        if (CardanoCrawler.poison?.hash === block.hash) CardanoCrawler.poison = null;
        // A ledger invalidation decided inside the block transaction takes effect in memory
        // only now, after the commit that carries it — a rolled-back attempt changes nothing.
        const invalidation = this.indexer.takeLedgerInvalidation();
        if (invalidation) {
          logger.error(`UTxO set invalidated: ${invalidation} — ledger tables stop updating until importUtxoSet runs again`);
        }
        // Notify observers (wallet-worker confirmation tracker) AFTER the commit —
        // listener failures are swallowed inside emitBlockIndexed.
        emitBlockIndexed({
          hash: block.hash,
          slot: block.slot ?? null,
          height: block.height ?? null,
          txHashes: txs.map((t) => t.hash),
          tipSlot: tip?.slot ?? null,
          tipHeight: tip?.height ?? null,
        });
        this.maybeSnapshotEpoch(block, tip);
        return true;
      } catch (err) {
        if (err instanceof CrawlerLeaseLostError) {
          logger.warn('Crawler write fenced because its DB lease is no longer valid.');
          await this.halt('stopped');
          return false;
        }
        const streak = await this.recordCrawlerError(err);
        if (streak < 0) {
          await this.halt('stopped');
          return false;
        }
        if (attempt < CardanoCrawler.PERSIST_RETRIES && streak < MAX_CONSECUTIVE_ERRORS) {
          logger.warn(`persistBlock ${block.hash} failed (attempt ${attempt}/${CardanoCrawler.PERSIST_RETRIES}, streak ${streak}) — retrying:`, err);
          await this.sleep(1000 * attempt);
          continue;
        }
        const dataRejection = CardanoCrawler.isDataRejection(err);
        const failures = dataRejection ? CardanoCrawler.notePersistFailure(block.hash) : 0;
        if (failures >= CardanoCrawler.POISON_BLOCK_THRESHOLD) {
          const cause = err instanceof Error ? err.message : String(err);
          const message = `poison block ${block.hash} @${block.height ?? '?'} failed ${failures}x: ${cause}`;
          logger.error(`persistBlock failed for ${block.hash} (height ${block.height}) ${failures}x across restarts — poison block, latching the crawler off. Fix the cause, then resumeCrawler():`, err);
          // Lease-independent on purpose (see latchPoisonBlock); the memory is only forgotten
          // once the latch is durable, so a failed write is retried after the next restart.
          const latched = await cds.tx((tx) => latchPoisonBlock(tx, message)).then(
            () => true,
            (e: unknown) => { logger.error('poison-block latch could not be written — retried after the next restart:', e); return false; },
          );
          if (latched) CardanoCrawler.poison = null;
          await this.halt('error', true);
          return false;
        }
        const perBlock = dataRejection ? ` (${failures}/${CardanoCrawler.POISON_BLOCK_THRESHOLD} for this block)` : '';
        logger.error(`persistBlock failed for ${block.hash} after ${attempt} attempts${perBlock} — stopping crawler (resume re-syncs from cursor):`, err);
        await this.halt('error');
        return false;
      }
    }
  }

  /** Epoch a slot belongs to, from the network's Shelley anchor (same math as the Ogmios mapper). */
  private epochOfSlot(slot: number): number {
    const cfg = EPOCH_CONFIG_BY_NETWORK[this.network as keyof typeof EPOCH_CONFIG_BY_NETWORK]
      ?? EPOCH_CONFIG_BY_NETWORK.preview;
    return cfg.shelleyStartEpoch + Math.floor((slot - cfg.shelleyStartSlot) / cfg.slotsPerEpoch);
  }

  /**
   * Pool/DRep snapshot once per epoch, detached from the triggering block and ONLY at the tip:
   * the enumerating providers report current state (no epoch parameter), so epochs passed
   * during a backfill are skipped permanently. Authority is the `PoolEpochSnapshots` row.
   */
  private maybeSnapshotEpoch(block: BlockData, tip?: ChainPoint): void {
    if (!this.config.epochSnapshots || block.epoch == null) return;
    if (this.snapshotedEpoch === block.epoch || this.snapshotInFlight) return;

    // No tip reported = we cannot prove we are live, so we do not pretend to be.
    if (tip == null) {
      logger.debug(`epoch ${block.epoch} snapshot skipped: no chain tip reported for this block`);
      return;
    }
    const tipEpoch = this.epochOfSlot(tip.slot);
    if (block.epoch !== tipEpoch) {
      logger.debug(
        `epoch ${block.epoch} snapshot skipped: still backfilling (tip is in epoch ${tipEpoch}) — ` +
        `the pool/DRep set can only be observed as it is now, never as it was`
      );
      return;
    }

    if (Date.now() < this.snapshotRetryAfter) return;

    const epoch = block.epoch;
    const at = { slot: block.slot ?? 0, time: block.time ?? 0 };
    this.snapshotInFlight = this.trackCallback(async () => {
      const existing = await cds.tx((tx) =>
        tx.run(SELECT.one.from(PoolEpochSnapshots).columns('epoch').where({ epoch }))
      );
      if (!existing) {
        await this.withTimeout(
          this.indexer.snapshotEpoch(epoch, at),
          `snapshotEpoch(${epoch})`,
          CardanoCrawler.SNAPSHOT_TIMEOUT_MS,
        );
      }
      this.snapshotedEpoch = epoch;
      this.snapshotFailures = 0;
      this.snapshotRetryAfter = 0;
    })
      .catch((err: unknown) => {
        // Never fatal: the crawl keeps its data, the epoch is retried on a later block —
        // but not on the very next one, or an outage would re-enumerate per block.
        this.snapshotFailures++;
        const backoff = Math.min(
          CardanoCrawler.SNAPSHOT_RETRY_BASE_MS * 2 ** (this.snapshotFailures - 1),
          CardanoCrawler.SNAPSHOT_RETRY_MAX_MS,
        );
        this.snapshotRetryAfter = Date.now() + backoff;
        if (this.running) logger.error(`epoch ${epoch} snapshot failed (retry in ${backoff} ms):`, err);
      })
      .finally(() => { this.snapshotInFlight = null; });
  }

  /**
   * Chain rollback in one transaction: delete blocks with slot > fork (absolute-slot axis, never
   * height), their transactions resolved via blockHash (lazily indexed txs of other blocks are
   * untouched), reset the cursor to the fork and write a CardanoReorgLog row.
   */
  private async handleReorg(point: ChainPoint | 'origin'): Promise<void> {
    const forkSlot = point === 'origin' ? (this.config.startSlot ?? 0) : point.slot;
    let blocksRolledBack = 0;
    let txsRolledBack = 0;
    let emittedForkHeight: number | null = null;
    const rolledBackTxHashes: string[] = [];
    let ledgerInvalidated = false;

    try {
      await cds.tx(async (tx) => {
      if (this.leaseOwner) {
        const renewed = await renewCrawlerLease(tx, this.leaseOwner);
        if (!renewed) throw new CrawlerLeaseLostError();
      }
      // Fork height is metrics/cursor info only — NEVER a delete axis.
      let forkHeight = point === 'origin' ? 0 : point.height;
      if (forkHeight == null && point !== 'origin') {
        const fb = await tx.run(SELECT.one.from(Blocks).where({ hash: point.hash })) as { height?: number | string } | undefined;
        forkHeight = fb ? Number(fb.height) : undefined;
      }
      emittedForkHeight = forkHeight ?? null;

      // Blocks strictly after the fork, cut on the absolute-slot axis. Rows without a
      // slot (pre-v2.0 lazily indexed blocks) are deliberately excluded.
      const staleBlocks = await tx.run(
        SELECT.from(Blocks).columns('hash').where({ slot: { '>': forkSlot } })
      ) as Array<{ hash: string }>;
      const blockHashes = staleBlocks.map((b) => b.hash);
      blocksRolledBack = blockHashes.length;

      for (const blockChunk of chunk(blockHashes, IN_CHUNK)) {
        // Only transactions of the rolled-back blocks — resolved via blockHash, so
        // lazily-indexed txs of unrelated blocks are not collateral damage.
        const staleTxs = await tx.run(
          SELECT.from(Transactions).columns('hash', 'txSeq').where({ blockHash: { in: blockChunk } })
        ) as TxKey[];
        const txHashes = staleTxs.map((t) => t.hash);
        txsRolledBack += txHashes.length;
        rolledBackTxHashes.push(...txHashes);

        for (const txChunk of chunk(txHashes, IN_CHUNK)) {
          // These denormalized/lazy indexes have no generated FK cascades. Remove
          // them before their parent tx/output rows so orphan data cannot leak via OData.
          await tx.run(DELETE.from(UTxOAssets).where({ utxo_hash: { in: txChunk } }));
          await tx.run(DELETE.from(AddressUTxOs).where({ hash: { in: txChunk } }));
          await tx.run(DELETE.from(AddressTransactions).where({ tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(AssetHistory).where({ txHash: { in: txChunk } }));
        }
        await deleteTransactionRows(tx, staleTxs);
        await tx.run(DELETE.from(Blocks).where({ hash: { in: blockChunk } }));
      }

      // Ledger state, driven by the PERSISTED status: a fork after the anchor is undone and the
      // progress marker follows the cursor back; a fork before the anchor invalidates the set.
      const persisted = (await readCursor(tx))?.utxoSet;
      if (persisted?.status === 'active' && persisted.anchorSlot != null) {
        if (forkSlot < persisted.anchorSlot) {
          await setUtxoSetState(tx, {
            status: 'invalid',
            error: `reorg to slot ${forkSlot} before the UTxO set anchor ${persisted.anchorSlot} — re-import the set`,
          });
          ledgerInvalidated = true;
        } else {
          await undoLedgerForTransactions(tx, rolledBackTxHashes);
          if (persisted.appliedSlot != null && persisted.appliedSlot > forkSlot) {
            await setUtxoSetState(tx, { appliedSlot: forkSlot });
          }
        }
      }
      await resetCursorTo(tx, point === 'origin'
        ? { slot: forkSlot, hash: this.config.startBlockHash ?? '', height: 0 }
        : { slot: point.slot, hash: point.hash, height: forkHeight ?? 0 });

        await tx.run(INSERT.into(CardanoReorgLog).entries({
        ID: cds.utils.uuid(),
        detectedAt: new Date().toISOString(),
        forkSlot,
        forkHeight: forkHeight ?? null,
        oldTipHash: null,
        newTipHash: point === 'origin' ? null : point.hash,
        blocksRolledBack,
        status: 'completed',
        }));
      });
    } catch (err) {
      if (err instanceof CrawlerLeaseLostError) {
        await this.halt('stopped');
        throw new CrawlerStoppedError();
      }
      throw err;
    }

    if (ledgerInvalidated) {
      this.indexer.setUtxoAnchor(null);
      logger.error(`UTxO set invalidated: reorg to slot ${forkSlot} reaches behind the anchor — ledger tables stop updating until importUtxoSet runs again`);
    }
    // Notify observers (wallet-worker confirmation tracker + CAP subscribers) AFTER
    // the rollback commit.
    emitReorg({ forkSlot, forkHeight: emittedForkHeight, blocksRolledBack });
    logger.warn(`Reorg handled: rolled back ${blocksRolledBack} blocks (${txsRolledBack} txs) to slot ${forkSlot}`);
  }

  /** Renew the lease while an Ogmios stream is idle; block writes renew it transactionally. */
  private startLeaseHeartbeat(): void {
    if (!this.leaseOwner || this.leaseHeartbeat) return;
    const intervalMs = Math.max(1_000, Math.floor(CRAWLER_LEASE_TTL_MS / 3));
    this.leaseHeartbeat = (async () => {
      while (this.running) {
        await this.leaseSleep(intervalMs);
        if (!this.running) return;
        try {
          const renewed = await cds.tx((tx) => renewCrawlerLease(tx, this.leaseOwner!));
          if (!renewed) {
            logger.warn('Crawler heartbeat lost the DB lease or observed a cluster pause.');
            await this.halt('stopped');
            return;
          }
        } catch (err) {
          logger.error('Crawler lease heartbeat failed:', err);
          const streak = await this.recordCrawlerError(err);
          await this.halt(streak < 0 ? 'stopped' : 'error');
          return;
        }
      }
    })();
  }

  /** Whether a persist error is deterministic for the block's data (see DATA_REJECTION_PATTERNS). */
  static isDataRejection(err: unknown): boolean {
    // RangeError: BigInt / number conversions in the mappers; SyntaxError: JSON of the block
    if (err instanceof RangeError || err instanceof SyntaxError) return true;
    const message = err instanceof Error ? err.message : String(err);
    return CardanoCrawler.DATA_REJECTION_PATTERNS.some((p) => p.test(message));
  }

  /** Count final persist failures per block hash (a different hash resets the count). */
  private static notePersistFailure(hash: string): number {
    const p = CardanoCrawler.poison;
    CardanoCrawler.poison = p && p.hash === hash ? { hash, failures: p.failures + 1 } : { hash, failures: 1 };
    return CardanoCrawler.poison.failures;
  }

  /** Test seam: forget the poison-block memory (process-wide state). */
  static resetPoisonMemory(): void {
    CardanoCrawler.poison = null;
  }

  /** Record state only while this instance still owns the lease. */
  private async recordCrawlerError(err: unknown): Promise<number> {
    if (err instanceof CrawlerStoppedError || err instanceof CrawlerLeaseLostError) {
      return -1;
    }
    return await cds.tx((tx) => recordError(tx, err, this.leaseOwner)).catch(() => 0);
  }

  private leaseSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.leaseWake = null; resolve(); }, ms);
      timer.unref?.();
      this.leaseWake = () => { clearTimeout(timer); this.leaseWake = null; resolve(); };
    });
  }

  /** Cancellable, unref'd delay — halt() wakes it so shutdown never waits out a poll. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      timer.unref?.();
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
}
