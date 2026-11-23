import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { yieldToEventLoop } from './window-plan';

const { SELECT } = cds.ql;

// Keyset paging in primary-key order, so the plan never depends on column statistics.
// The rows of one first key stay together on a page. A first key with more rows than a page holds
// is walked on by its second key. Each page is read in a short transaction of its own.

export interface KeyPageSpec {
  entity: unknown;
  /** Primary key in walk order. */
  keys: [first: string, second: string];
  /** Columns to read; the keys are added. */
  columns: string[];
  chunkSize: number;
  /** Stops the walk before the next page. */
  shouldStop?: () => boolean;
}

/** Where the walk continues: after `first`, or within it after `second`. */
interface Position {
  first: unknown;
  second: unknown;
  within: boolean;
}

// Calls `onPage` with each page, outside the read transaction, so it may call a backend.
// Returns false when `shouldStop` ended the walk.
export async function pageByKey<R extends Record<string, unknown>>(
  spec: KeyPageSpec,
  onPage: (rows: R[]) => Promise<void>,
): Promise<boolean> {
  const [k1, k2] = spec.keys;
  const columns = [...new Set([k1, k2, ...spec.columns])];
  let at: Position | null = null;
  for (;;) {
    await yieldToEventLoop();
    if (spec.shouldStop?.()) return false;
    const where: Record<string, unknown> = {};
    if (at?.within) {
      where[k1] = at.first;
      where[k2] = { '>': at.second };
    } else if (at) {
      where[k1] = { '>': at.first };
    }
    const rows = (await cds.tx((tx: CapTransaction) => tx.run(
      SELECT.from(spec.entity as never).columns(...columns).where(where).orderBy(k1, k2).limit(spec.chunkSize)
    ))) as R[] | undefined ?? [];
    const wasWithin = at?.within ?? false;
    if (!rows.length) {
      if (!wasWithin) return true;
      at = { ...at!, within: false };
      continue;
    }
    const full = rows.length === spec.chunkSize;
    const lastFirst = rows[rows.length - 1][k1];
    const allSame = rows.every((r) => r[k1] === lastFirst);
    // the last first key of a full page may go on, so its rows wait for the next page
    const page = full && !allSame ? rows.filter((r) => r[k1] !== lastFirst) : rows;
    await onPage(page);
    const last = page[page.length - 1];
    at = { first: last[k1], second: last[k2], within: full && allSame };
    if (!full && !wasWithin) return true;
  }
}
