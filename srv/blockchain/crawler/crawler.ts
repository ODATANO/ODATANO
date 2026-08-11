import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { ChainSyncBackend, ChainSyncHandle, ChainPoint, PaginatingBackend } from '../backends/cardano-backend';
import type { BlockData, Transaction } from '../../utils/types';
import { ProviderUnavailableError } from '../../utils/errors';
import { chunk, IN_CHUNK } from '../../utils/collections';
import { emitBlockIndexed, emitReorg } from './hooks';
import {
  Blocks,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  AddressTransactions,
  AddressUTxOs,
  UTxOAssets,
  AssetHistory_ as AssetHistory,
  // the entity name is already plural-ish, so the typer's plural (array) class
  // carries a trailing underscore — that's the CQL-target class, like Blocks/Transactions
  TransactionMetadata_ as TransactionMetadata,
  CardanoReorgLog,
} from '#cds-models/odatano/cardano';
import {
  ensureSyncStateSingleton,
  readCursor,
  advanceCursor,
  resetCursorTo,
  setSyncStatus,
  recordError,
  tryAcquireCrawlerLease,
  renewCrawlerLease,
  releaseCrawlerLease,
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
}

/**
 * CardanoCrawler — pre-sync engine (v2.0). Streams the chain forward from a configured
 * start block and bulk-indexes Blocks + Transactions (+ inputs/outputs/assets) into the
 * DB, so consumers can query local data instead of hitting a backend per request.
 *
 * Two sources (see CRAWLER_DESIGN.md):
 *  - **Ogmios chain-sync** (primary): ordered rollForward + native rollBackward (reorg).
 *  - **Blockfrost/Koios pagination** (fallback): forward walk + parent-hash reorg recovery.
 *
 * Lifecycle: start() launches the ingest pipeline detached so the HTTP server binds
 * immediately, but the pipeline promise is retained — stop() halts the loops (waking
 * any pending poll sleep) and AWAITS the pipeline, so shutdown never races in-flight
 * block writes. All per-block writes are atomic. The crawler NEVER crawls from genesis
 * implicitly — it requires an explicit configured start point or an existing cursor.
 */
export class CardanoCrawler {
  /** Transient-failure retries per block before giving up. */
  private static readonly PERSIST_RETRIES = 3;
  /** Timeout for direct backend calls (the crawler bypasses the client's resilience layer). */
  private static readonly CALL_TIMEOUT_MS = 60_000;

  private running = false;
  private chainSyncHandle: ChainSyncHandle | null = null;
  /** The detached ingest pipeline — awaited by stop() so teardown never races it. */
  private pipeline: Promise<void> | null = null;
  /** Resolver that cancels a pending poll sleep (set while sleeping). */
  private wake: (() => void) | null = null;
  /** Cancellers for backend waits, so shutdown is not held hostage by their timeout. */
  private readonly callCancels = new Set<() => void>();
  /** Chain-sync callback promises outlive openChainSync(); stop() explicitly drains them. */
  private readonly inFlightCallbacks = new Set<Promise<unknown>>();
  private haltPromise: Promise<void> | null = null;
  private finalStatus: CrawlSyncStatusValue = 'stopped';
  /** Set only by an unrecoverable halt — clears desiredRunning so restarts stay down. */
  private latchOnHalt = false;
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
   * Stop crawling and WAIT for the pipeline to finish its in-flight step: halts the
   * loops (waking any pending poll sleep), closes the chain-sync stream, records the
   * final status, then awaits the detached pipeline so callers (shutdownAppContext)
   * can safely tear down backends/DB afterwards.
   */
  async stop(finalStatus: CrawlSyncStatusValue = 'stopped'): Promise<void> {
    this.beginHalt(finalStatus);
    if (this.haltPromise) await this.haltPromise;
    this.pipeline = null;
  }

  /**
   * Halt without awaiting the pipeline — the variant safe to call FROM INSIDE the
   * pipeline (persistBlock failure, stream onError), where awaiting the pipeline
   * would deadlock.
   */
  /**
   * @param latch clears `desiredRunning`, so NO restart brings the crawler back —
   *   only an operator's resumeCrawler does. Reserved for failures a restart cannot
   *   fix (misconfiguration, missing resume point). Runtime failures — a dropped
   *   chain-sync socket, a provider outage, a node restart — must leave it false,
   *   otherwise a routine node restart silently disables the pre-sync for good.
   */
  private async halt(finalStatus: CrawlSyncStatusValue = 'stopped', latch = false): Promise<void> {
    this.beginHalt(finalStatus, latch);
  }

  /**
   * Start teardown without awaiting it. Internal callers can therefore halt from
   * inside a tracked callback/pipeline without waiting on their own promise.
   */
  private beginHalt(finalStatus: CrawlSyncStatusValue, latch = false): void {
    if (latch) this.latchOnHalt = true;
    // Once a real failure was observed, a concurrent shutdown must not hide it.
    if (this.finalStatus !== 'error' || finalStatus === 'error') this.finalStatus = finalStatus;
    this.running = false;
    this.wake?.(); // cancel a pending poll sleep so the loop exits now
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
    const chainSync = this.config.source !== 'pagination' ? this.client.getChainSyncBackend() : null;
    if (chainSync) {
      await this.runChainSync(chainSync);
      return;
    }
    if (this.config.source === 'ogmios') {
      // 'ogmios' means chain-sync ONLY — never silently degrade to the weaker
      // pagination reorg handling the operator explicitly opted out of.
      logger.error("Crawler source is 'ogmios' but no chain-sync backend is available — crawler not started (use source 'auto' to allow pagination fallback).");
      await this.halt('error', true); // config error: a restart cannot fix it
      return;
    }
    await this.runPagination();
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
    logger.info(`Crawler running (chain-sync) from ${points[0].hash} (+${points.length - 1} fallback intersection point(s))`);
  }

  /**
   * Candidate intersection points, NEWEST FIRST: the cursor, then an exponentially
   * spaced ladder of our own already-crawled ancestors, then the configured start
   * block as the deepest anchor.
   *
   * Why more than the cursor: if the cursor's block was orphaned while the crawler
   * was down, a single-point intersection fails outright ("No intersection found")
   * and the stream never opens. With ancestors on the list the node intersects at
   * the last common block and reports it as a rollBackward — the ordinary reorg path
   * that handleReorg already implements. Doubling offsets cover ~32k blocks with 16
   * points; anything deeper is past any realistic rollback and should fail loudly.
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

      // Dense over the last DENSE_DEPTH blocks, doubling after that. Real rollbacks
      // are a handful of blocks deep, and those must intersect EXACTLY — a gap in
      // the ladder is not wrong (rolling back too far only re-crawls), but it costs
      // needless work on the common case. The doubling tail keeps the deep-reorg
      // reach without sending hundreds of points.
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

  private async runPagination(): Promise<void> {
    const backend = this.client.getPaginatingBackend();
    if (!backend) {
      logger.error('No paginating backend available — cannot crawl without Ogmios or Blockfrost/Koios');
      await this.halt('error', true); // config error: a restart cannot fix it
      return;
    }
    logger.info('Crawler running (pagination)');

    // Tip cache: during deep catch-up the exact tip is irrelevant (only "am I still
    // behind the target" matters) — refetching it every round wasted one HTTP call
    // per batch. Refresh only when the cursor reaches the cached target.
    let tip: BlockData | null = null;
    let target = Number.NEGATIVE_INFINITY;

    while (this.running) {
      try {
        const cursor = await cds.tx((tx) => readCursor(tx));
        if (!cursor?.lastBlockHash) {
          logger.error('Pagination refused: cursor has no resume block hash.');
          await this.halt('error', true); // broken precondition: a restart cannot fix it
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
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        const blocks = await this.withTimeout(
          // pass the cursor height as anchor hint (>0 only — 0 can mean "unknown"
          // on a fresh start without configured startHeight)
          backend.getNextBlocks(cursor.lastBlockHash, this.config.batchSize, cursor.lastHeight > 0 ? cursor.lastHeight : undefined),
          'getNextBlocks',
        );
        if (!blocks.length) { await this.sleep(this.config.pollIntervalMs); continue; }

        for (const block of blocks) {
          if (!this.running) break;
          if ((block.height ?? 0) > target) break; // stay behind the confirmation window
          const txs = await this.withTimeout(backend.getBlockTransactions(block.hash), 'getBlockTransactions');
          const ok = await this.persistBlock(block, txs, tipPoint);
          if (!ok) return; // persistBlock already recorded + halted
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
        await this.sleep(this.config.pollIntervalMs);
      }
    }
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
        // handleReorg deletes everything with slot > forkSlot. A null provider slot
        // (BlockData.slot is nullable) would make forkSlot 0 and wipe the ENTIRE
        // crawled dataset — abort this round instead; the next round can retry with
        // a healthy provider response. (Same guard philosophy as the height axis.)
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
   * Persist one block atomically and advance the cursor. Transient failures are retried
   * a few times (recording the error streak); only repeated failure stops the crawler —
   * the cursor is not advanced on failure, so a resume re-syncs cleanly from it.
   * Marks the cursor 'synced' when the block is at the reported tip.
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
          await advanceCursor(
            tx,
            { slot: block.slot ?? 0, hash: block.hash, height: block.height ?? 0 },
            tip ? { slot: tip.slot, height: tip.height } : undefined,
            isAtTip ? 'synced' : 'syncing',
          );
        });
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
        logger.error(`persistBlock failed for ${block.hash} after ${attempt} attempts — stopping crawler (resume re-syncs from cursor):`, err);
        await this.halt('error');
        return false;
      }
    }
  }

  /**
   * Handle a chain rollback: in one transaction, delete every block after the fork point
   * and exactly the transactions belonging to those blocks (plus their child rows), reset
   * the cursor to the fork, and write a CardanoReorgLog audit row.
   *
   * The cut runs on the absolute-slot axis of Blocks (same axis as the fork point), and
   * transactions are resolved via their blockHash — so:
   *  - an unresolvable fork height can never widen the delete (no height-0 fallback), and
   *  - lazily-indexed transactions of blocks the crawler never wrote are left untouched.
   */
  private async handleReorg(point: ChainPoint | 'origin'): Promise<void> {
    const forkSlot = point === 'origin' ? (this.config.startSlot ?? 0) : point.slot;
    let blocksRolledBack = 0;
    let txsRolledBack = 0;
    let emittedForkHeight: number | null = null;

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
          SELECT.from(Transactions).columns('hash').where({ blockHash: { in: blockChunk } })
        ) as Array<{ hash: string }>;
        const txHashes = staleTxs.map((t) => t.hash);
        txsRolledBack += txHashes.length;

        for (const txChunk of chunk(txHashes, IN_CHUNK)) {
          // These denormalized/lazy indexes have no generated FK cascades. Remove
          // them before their parent tx/output rows so orphan data cannot leak via OData.
          await tx.run(DELETE.from(UTxOAssets).where({ utxo_hash: { in: txChunk } }));
          await tx.run(DELETE.from(AddressUTxOs).where({ hash: { in: txChunk } }));
          await tx.run(DELETE.from(AddressTransactions).where({ tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(AssetHistory).where({ txHash: { in: txChunk } }));
          await tx.run(DELETE.from(TransactionInputAssets).where({ input_tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(TransactionOutputAssets).where({ output_tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(TransactionInputs).where({ tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(TransactionOutputs).where({ tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(TransactionMetadata).where({ tx_hash: { in: txChunk } }));
          await tx.run(DELETE.from(Transactions).where({ hash: { in: txChunk } }));
        }
        await tx.run(DELETE.from(Blocks).where({ hash: { in: blockChunk } }));
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
