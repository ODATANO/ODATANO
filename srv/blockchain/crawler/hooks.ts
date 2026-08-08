import cds from '@sap/cds';

const logger = cds.log('CardanoCrawler');

/**
 * Crawler event hooks (v2.1).
 *
 * Small listener registry that lets other subsystems (currently the wallet-worker
 * confirmation tracker) observe crawler progress without the crawler importing
 * them (dependency direction stays crawler ← consumer). The crawler emits:
 *  - `blockIndexed` after each successfully persisted block (with its tx hashes), and
 *  - `reorg` after a completed rollback (with the fork slot).
 *
 * Listener failures are logged and swallowed — a broken consumer must never
 * stop the crawler.
 */

export interface BlockIndexedEvent {
  hash: string;
  slot: number | null;
  height: number | null;
  txHashes: string[];
  /** Latest known chain tip at the time of indexing (when the source reports one). */
  tipSlot: number | null;
  tipHeight: number | null;
}

export interface ReorgEvent {
  /** Absolute slot of the fork point — everything after it was rolled back. */
  forkSlot: number;
  /**
   * Block height of the fork point, when known. Listeners tracking confirmation
   * depth must clamp their tip to this — the pre-fork tip height no longer exists.
   */
  forkHeight: number | null;
}

export type BlockIndexedListener = (event: BlockIndexedEvent) => void;
export type ReorgListener = (event: ReorgEvent) => void;

const blockListeners = new Set<BlockIndexedListener>();
const reorgListeners = new Set<ReorgListener>();

export function registerBlockIndexedListener(listener: BlockIndexedListener): void {
  blockListeners.add(listener);
}

export function unregisterBlockIndexedListener(listener: BlockIndexedListener): void {
  blockListeners.delete(listener);
}

export function registerReorgListener(listener: ReorgListener): void {
  reorgListeners.add(listener);
}

export function unregisterReorgListener(listener: ReorgListener): void {
  reorgListeners.delete(listener);
}

/** True when at least one consumer observes crawler progress. */
export function hasBlockIndexedListeners(): boolean {
  return blockListeners.size > 0;
}

export function emitBlockIndexed(event: BlockIndexedEvent): void {
  for (const listener of blockListeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn('blockIndexed listener failed (ignored):', err);
    }
  }
}

export function emitReorg(event: ReorgEvent): void {
  for (const listener of reorgListeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn('reorg listener failed (ignored):', err);
    }
  }
}
