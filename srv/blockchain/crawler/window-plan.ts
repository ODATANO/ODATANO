import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { TX_SEQ_SLOT_FACTOR } from '../../utils/mappers';
import { connectedDbKind } from '../../utils/db-kind';

const { SELECT } = cds.ql;

/** Planner settings of a slot window walk on PostgreSQL. They end with the transaction. */
export const KEY_LOOKUPS_ONLY =
  "SELECT set_config('enable_seqscan', 'off', true), set_config('enable_hashjoin', 'off', true), set_config('enable_mergejoin', 'off', true)";
/** Window rows found through an index, joined to a value list by hash; never a scan of the table. */
export const INDEXED_JOIN = "SELECT set_config('enable_seqscan', 'off', true)";

/** How a window statement reaches its rows; `join` for a statement that matches window rows against a list. */
export type WindowPlan = 'keys' | 'join';

// node:sqlite answers synchronously, so a loop of database statements alone never lets the server
// read its sockets. Awaiting this between steps keeps requests and cancelMaintenance served.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Slots per window unless the caller names another size. */
export const DEFAULT_SLOT_WINDOW = 20_000;

// A window statement touches the rows of a few slots and finds each by key. From its row estimate
// PostgreSQL may still plan to read a whole table for every window. This rules that plan out.
export async function lookupsByKey(tx: CapTransaction, plan: WindowPlan = 'keys'): Promise<void> {
  if (connectedDbKind() === 'postgres') await tx.run(plan === 'join' ? INDEXED_JOIN : KEY_LOOKUPS_ONLY);
}

/** First and last slot of a walk, both included. */
export interface SlotRange {
  from: number;
  to: number;
}

// The asked slots cut to the slots of the rows `entity` holds, read from its txSeq column.
// Null when there is nothing to walk.
export async function slotRangeOf(entity: unknown, asked: { fromSlot?: number | null; toSlot?: number | null } = {}): Promise<SlotRange | null> {
  const stored = (await cds.tx((tx: CapTransaction) => tx.run(
    SELECT.one.from(entity as never).columns('min(txSeq) as lo', 'max(txSeq) as hi')
  ))) as { lo?: number | string | null; hi?: number | string | null } | undefined;
  if (stored?.lo == null || stored.hi == null) return null;
  const from = Math.max(asked.fromSlot ?? 0, Math.floor(Number(stored.lo) / TX_SEQ_SLOT_FACTOR));
  const to = Math.min(asked.toSlot ?? Number.MAX_SAFE_INTEGER, Math.floor(Number(stored.hi) / TX_SEQ_SLOT_FACTOR));
  return from <= to ? { from, to } : null;
}

export interface SlotWalkOptions {
  slotWindow?: number;
  /** Stops the walk before the next window. */
  shouldStop?: () => boolean;
  /** Called after each window is committed, with its last slot. */
  afterWindow?: (atSlot: number) => void;
  /** Planner settings per window; default `keys`. */
  plan?: WindowPlan;
}

// Calls `step` with the txSeq bounds [lo, hi) of each slot window of `range`, each window in a
// transaction of its own that finds rows by key. Returns false when `shouldStop` ended the walk.
export async function walkSlotWindows(
  range: SlotRange,
  opts: SlotWalkOptions,
  step: (tx: CapTransaction, window: [lo: number, hi: number]) => Promise<void>,
): Promise<boolean> {
  const slotWindow = opts.slotWindow ?? DEFAULT_SLOT_WINDOW;
  for (let slot = range.from; slot <= range.to; slot += slotWindow) {
    await yieldToEventLoop();
    if (opts.shouldStop?.()) return false;
    const window: [number, number] = [slot * TX_SEQ_SLOT_FACTOR, Math.min(slot + slotWindow, range.to + 1) * TX_SEQ_SLOT_FACTOR];
    await cds.tx(async (tx: CapTransaction) => {
      await lookupsByKey(tx, opts.plan);
      await step(tx, window);
    });
    opts.afterWindow?.(Math.min(slot + slotWindow - 1, range.to));
  }
  return true;
}
