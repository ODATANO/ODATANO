import type { Request } from '@sap/cds';
import { rejectInvalid } from './errors';

/** A page of a list operation. The CDS model range-checks `limit` and `skip` before the handler runs. */
export interface Page {
  limit: number;
  skip: number;
}

/** The page a request asks for, with the operation's default limit when none is given. */
export function pageOf(data: { limit?: number | null; skip?: number | null }, defaultLimit: number): Page {
  return { limit: data.limit ?? defaultLimit, skip: data.skip ?? 0 };
}

/** The rows of one page out of a list that is already in its final order. */
export function pageRows<T>(rows: T[], page: Page): T[] {
  return rows.slice(page.skip, page.skip + page.limit);
}

/** Rows sorted by a string key; a fixed order keeps pages stable across calls. */
export function byKey<T>(rows: T[], keyOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** UTxOs in output-reference order: tx hash, then output index. */
export function byOutRef<T extends { hash?: string | null; index?: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(a.hash ?? '').localeCompare(String(b.hash ?? '')) || Number(a.index ?? 0) - Number(b.index ?? 0));
}

/** Newest first. Koios rows carry only a time, Blockfrost rows only a height; the tx hash breaks ties. */
export function sortAssetHistory<T extends { blockHeight?: number | null; blockTime?: number | null; txHash?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    Number(b.blockHeight ?? -1) - Number(a.blockHeight ?? -1)
    || Number(b.blockTime ?? -1) - Number(a.blockTime ?? -1)
    || String(b.txHash ?? '').localeCompare(String(a.txHash ?? '')));
}

/** Operations over a provider's newest rows reach at most this far. */
export const LATEST_WINDOW = 100;

/** Page over the newest LATEST_WINDOW rows; a page reaching past them is a 400. */
export function latestWindowPage(req: Request, ctx: string, defaultLimit: number): Page {
  const page = pageOf(req.data as { limit?: number; skip?: number }, defaultLimit);
  if (page.skip + page.limit > LATEST_WINDOW) {
    rejectInvalid(req, ctx, `skip + limit must not exceed ${LATEST_WINDOW}`, 'skip');
  }
  return page;
}
