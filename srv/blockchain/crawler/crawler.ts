import cds from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import type { ChainSyncBackend, ChainSyncHandle, ChainPoint, PaginatingBackend } from '../backends/cardano-backend';
import type { BlockData, Transaction } from '../../utils/types';
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

/** Split an array into chunks — keeps CQL IN-lists below driver bind-variable limits. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
 * Lifecycle is fire-and-forget: start() launches the ingest pipeline detached so the HTTP
 * server binds immediately; catch-up can run long. All per-block writes are atomic.
 * The crawler NEVER crawls from genesis implicitly — it requires an explicit configured
 * start point or an existing cursor.
 */
export class CardanoCrawler {
  /** Max bind variables per IN-list (well below SQLite's 32766 / older 999 caps). */
  private static readonly IN_CHUNK = 500;
  /** Transient-failure retries per block before giving up. */
  private static readonly PERSIST_RETRIES = 3;
  /** Timeout for direct backend calls (the crawler bypasses the client's resilience layer). */
  private static readonly CALL_TIMEOUT_MS = 60_000;

  private running = false;
  private chainSyncHandle: ChainSyncHandle | null = null;

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

    void this.runIngestPipeline().catch((err) => {
      logger.error('Ingest pipeline crashed:', err);
    });
  }

  /** Stop crawling: close the chain-sync stream (if any) and record the final status. */
  async stop(finalStatus: CrawlSyncStatusValue = 'stopped'): Promise<void> {
    if (!this.running && !this.chainSyncHandle) return;
    this.running = false;
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
      await this.stop('error');
      return;
    }
    await this.runPagination();
  }

  /** Bound a direct backend call — these bypass the client's timeout/breaker layer. */
  private withTimeout<T>(p: Promise<T>, label: string, ms = CardanoCrawler.CALL_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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
      await this.stop('error');
      return;
    }

    const handle = await backend.openChainSync(from, {
      rollForward: async (block, txs, tip) => {
        if (!this.running) return;
        await this.persistBlock(block, txs, tip);
      },
      rollBackward: async (point) => {
        if (!this.running) return;
        await this.handleReorg(point);
      },
      onError: async (err) => {
        // The stream is stalled (mapping/callback failure) — record and stop cleanly
        // so the cursor status shows 'error' instead of a healthy-looking hang.
        await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
        logger.error('Chain-sync stream error — stopping crawler:', err);
        await this.stop('error');
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
      await this.stop('error');
      return;
    }
    logger.info('Crawler running (pagination)');

    while (this.running) {
      try {
        const cursor = await cds.tx((tx) => readCursor(tx));
        if (!cursor?.lastBlockHash) {
          logger.error('Pagination refused: cursor has no resume block hash.');
          await this.stop('error');
          return;
        }

        const tip = await this.withTimeout(this.client.getLatestBlock(), 'getLatestBlock');
        const tipHeight = tip.height ?? 0;
        const target = tipHeight - this.config.confirmationDepth;

        if (cursor.lastHeight >= target) {
          await cds.tx((tx) => setSyncStatus(tx, 'synced'));
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        const blocks = await this.withTimeout(
          backend.getNextBlocks(cursor.lastBlockHash, this.config.batchSize),
          'getNextBlocks',
        );
        if (!blocks.length) { await this.sleep(this.config.pollIntervalMs); continue; }

        for (const block of blocks) {
          if (!this.running) break;
          if ((block.height ?? 0) > target) break; // stay behind the confirmation window
          const txs = await this.withTimeout(backend.getBlockTransactions(block.hash), 'getBlockTransactions');
          const ok = await this.persistBlock(block, txs, { slot: tip.slot ?? 0, hash: tip.hash, height: tipHeight });
          if (!ok) return; // persistBlock already recorded + stopped
        }
      } catch (err) {
        // A failure walking forward from lastBlockHash may mean it was orphaned (reorg).
        const recovered = await this.tryReorgRecovery(backend).catch(() => false);
        if (recovered) continue;

        const streak = await cds.tx((tx) => recordError(tx, err)).catch(() => 0);
        logger.error(`pagination round failed (error streak ${streak}):`, err);
        if (streak >= MAX_CONSECUTIVE_ERRORS) { await this.stop('error'); return; }
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
        await this.stop('error');
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

      for (const blockChunk of chunk(blockHashes, CardanoCrawler.IN_CHUNK)) {
        // Only transactions of the rolled-back blocks — resolved via blockHash, so
        // lazily-indexed txs of unrelated blocks are not collateral damage.
        const staleTxs = await tx.run(
          SELECT.from(Transactions).columns('hash').where({ blockHash: { in: blockChunk } })
        ) as Array<{ hash: string }>;
        const txHashes = staleTxs.map((t) => t.hash);
        txsRolledBack += txHashes.length;

        for (const txChunk of chunk(txHashes, CardanoCrawler.IN_CHUNK)) {
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
        blocksReindexed: 0,
        status: 'completed',
      }));
    });

    logger.warn(`Reorg handled: rolled back ${blocksRolledBack} blocks (${txsRolledBack} txs) to slot ${forkSlot}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
