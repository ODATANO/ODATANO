import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { ChainSyncBackend, ChainSyncHandle, ChainPoint, PaginatingBackend } from '../backends/cardano-backend';
import type { BlockData, Transaction } from '../../utils/types';
import { ProviderUnavailableError } from '../../utils/errors';
import { chunk, IN_CHUNK } from '../../utils/collections';
import {
  Blocks,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
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
  MAX_CONSECUTIVE_ERRORS,
  type CrawlPoint,
  type CrawlSyncStatusValue,
} from './sync-state';

const { SELECT, DELETE, INSERT } = cds.ql;
const logger = cds.log('CardanoCrawler');

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

  constructor(
    private readonly client: CardanoClient,
    private readonly indexer: CardanoIndexer,
    private readonly network: string,
    private readonly config: CrawlerConfig,
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
    this.running = true;

    const start: CrawlPoint | undefined =
      this.config.startSlot != null && this.config.startBlockHash
        ? { slot: this.config.startSlot, hash: this.config.startBlockHash, height: this.config.startHeight }
        : undefined;
    const cursor = await cds.tx((tx) => ensureSyncStateSingleton(tx, this.network, start));

    if (!cursor.lastBlockHash && !start) {
      logger.error('Crawler start refused: no start block configured and no existing cursor — set crawler.startSlot + crawler.startBlockHash.');
      this.running = false;
      return;
    }

    // A pipeline crash (e.g. chain-sync intersection not found after downtime) must
    // surface on the cursor — otherwise the crawler looks healthy while doing nothing.
    this.pipeline = this.runIngestPipeline().catch(async (err) => {
      logger.error('Ingest pipeline crashed:', err);
      await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
      await this.halt('error');
    });
  }

  /**
   * Stop crawling and WAIT for the pipeline to finish its in-flight step: halts the
   * loops (waking any pending poll sleep), closes the chain-sync stream, records the
   * final status, then awaits the detached pipeline so callers (shutdownAppContext)
   * can safely tear down backends/DB afterwards.
   */
  async stop(finalStatus: CrawlSyncStatusValue = 'stopped'): Promise<void> {
    await this.halt(finalStatus);
    const pipeline = this.pipeline;
    this.pipeline = null;
    if (pipeline) await pipeline; // exits promptly: loops re-check running, sleeps are woken
  }

  /**
   * Halt without awaiting the pipeline — the variant safe to call FROM INSIDE the
   * pipeline (persistBlock failure, stream onError), where awaiting the pipeline
   * would deadlock.
   */
  private async halt(finalStatus: CrawlSyncStatusValue = 'stopped'): Promise<void> {
    if (!this.running && !this.chainSyncHandle) return;
    this.running = false;
    this.wake?.(); // cancel a pending poll sleep so the loop exits now
    if (this.chainSyncHandle) {
      try { await this.chainSyncHandle.close(); } catch (e) { logger.warn('chain-sync close failed:', e); }
      this.chainSyncHandle = null;
    }
    try { await cds.tx((tx) => setSyncStatus(tx, finalStatus)); } catch { /* best effort */ }
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
      await this.halt('error');
      return;
    }
    await this.runPagination();
  }

  /** Bound a direct backend call — these bypass the client's timeout/breaker layer. */
  private withTimeout<T>(p: Promise<T>, label: string, ms = CardanoCrawler.CALL_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ProviderUnavailableError(`${label} timed out`, 'crawler', ms)),
        ms,
      );
      timer.unref?.(); // never keep the process alive for a watchdog timer
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Chain-sync (Ogmios) — primary, reorg-aware
  // ---------------------------------------------------------------------------

  private async runChainSync(backend: ChainSyncBackend): Promise<void> {
    const cursor = await cds.tx((tx) => readCursor(tx));
    const from: ChainPoint | 'origin' = cursor?.lastBlockHash
      ? { slot: cursor.lastSlot, hash: cursor.lastBlockHash, height: cursor.lastHeight }
      : (this.config.startBlockHash
        ? { slot: this.config.startSlot ?? 0, hash: this.config.startBlockHash, height: this.config.startHeight }
        : 'origin');
    if (from === 'origin') {
      // Defense in depth — start() already refuses this state.
      logger.error('Chain-sync refused: no resume point (configured start block or cursor) available.');
      await this.halt('error');
      return;
    }

    const handle = await backend.openChainSync(from, {
      rollForward: async (block, txs, tip) => {
        if (!this.running) return;
        await this.persistBlock(block, txs, tip);
      },
      rollBackward: async (point) => {
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
      },
      onError: async (err) => {
        // The stream is stalled (mapping/callback failure) — record and halt cleanly
        // so the cursor status shows 'error' instead of a healthy-looking hang.
        await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
        logger.error('Chain-sync stream error — stopping crawler:', err);
        await this.halt('error');
      },
    });

    // stop() may have raced the async open — close the fresh socket instead of leaking it.
    if (!this.running) {
      try { await handle.close(); } catch { /* best effort */ }
      return;
    }
    this.chainSyncHandle = handle;
    logger.info(`Crawler running (chain-sync) from ${from.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Pagination (Blockfrost/Koios) — fallback
  // ---------------------------------------------------------------------------

  private async runPagination(): Promise<void> {
    const backend = this.client.getPaginatingBackend();
    if (!backend) {
      logger.error('No paginating backend available — cannot crawl without Ogmios or Blockfrost/Koios');
      await this.halt('error');
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
          await this.halt('error');
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
          await cds.tx((tx) => setSyncStatus(tx, 'synced'));
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
        // A failure walking forward from lastBlockHash may mean it was orphaned (reorg).
        const recovered = await this.tryReorgRecovery(backend).catch(() => false);
        if (recovered) continue;

        const streak = await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
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
    const cursor = await cds.tx((tx) => readCursor(tx));
    if (!cursor || !cursor.lastBlockHash) return false;

    const MAX_DEPTH = 100;
    const floor = Math.max(0, cursor.lastHeight - MAX_DEPTH);
    for (let h = cursor.lastHeight; h > floor; h--) {
      let onChain: BlockData;
      try {
        onChain = await this.withTimeout(backend.getBlockByHeight(h), `getBlockByHeight(${h})`);
      } catch {
        continue; // height not resolvable right now — keep scanning
      }
      const ours = await cds.tx((tx) => tx.run(SELECT.one.from(Blocks).where({ height: h }))) as { hash?: string } | undefined;
      if (ours?.hash && onChain.hash === ours.hash) {
        if (h === cursor.lastHeight) return false; // tip still matches → not a reorg
        await this.handleReorg({ slot: onChain.slot ?? 0, hash: onChain.hash, height: h });
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
          await this.indexer.indexBlockFull(tx, block, txs);
          await advanceCursor(
            tx,
            { slot: block.slot ?? 0, hash: block.hash, height: block.height ?? 0 },
            tip ? { slot: tip.slot, height: tip.height } : undefined,
            isAtTip ? 'synced' : 'syncing',
          );
        });
        return true;
      } catch (err) {
        const streak = await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
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

    await cds.tx(async (tx) => {
      // Fork height is metrics/cursor info only — NEVER a delete axis.
      let forkHeight = point === 'origin' ? 0 : point.height;
      if (forkHeight == null && point !== 'origin') {
        const fb = await tx.run(SELECT.one.from(Blocks).where({ hash: point.hash })) as { height?: number | string } | undefined;
        forkHeight = fb ? Number(fb.height) : undefined;
      }

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

    logger.warn(`Reorg handled: rolled back ${blocksRolledBack} blocks (${txsRolledBack} txs) to slot ${forkSlot}`);
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
