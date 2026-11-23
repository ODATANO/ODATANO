import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { timestamp } from './row-values';

const { SELECT, UPDATE } = cds.ql;

// A lease is a pair of columns `leaseOwner` and `leaseUntil` on one row. One owner at a time may
// write under it. Every change is a compare-and-swap on the owner, verified by reading the row back,
// because the affected-row result differs per database.

/** The row that holds a lease. */
export interface LeaseRow {
  entity: unknown;
  key: Record<string, unknown>;
  /** Column values every acquire and renewal requires in its WHERE. */
  requires?: Record<string, unknown>;
  /** The same requirement on a row read back, for the adapters' own value forms. */
  holds?: (row: Record<string, unknown>) => boolean;
}

export interface LeaseTiming {
  now?: Date;
  ttlMs: number;
}

interface StoredLease {
  leaseOwner: string | null;
  leaseUntil: string | null;
  row: Record<string, unknown>;
}

async function readLease(db: CapTransaction, lease: LeaseRow): Promise<StoredLease | null> {
  const row = await db.run(SELECT.one.from(lease.entity as never).where(lease.key)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { leaseOwner: (row.leaseOwner as string) ?? null, leaseUntil: timestamp(row.leaseUntil), row };
}

// True when `owner` holds the lease until at least `expectedMs`. One second of tolerance covers
// adapters that store the timestamp with less precision.
function heldUntil(stored: StoredLease | null, lease: LeaseRow, owner: string, expectedMs: number): boolean {
  if (!stored || stored.leaseOwner !== owner || !stored.leaseUntil) return false;
  if (lease.holds && !lease.holds(stored.row)) return false;
  const actualMs = Date.parse(stored.leaseUntil);
  return Number.isFinite(actualMs) && actualMs >= expectedMs - 1_000;
}

// Takes a free or expired lease, or renews the caller's own. A foreign lease is taken only when the
// UPDATE itself still sees it expired, so a renewal that commits first wins. `admit` can refuse the row.
export async function tryAcquireLease(
  db: CapTransaction,
  lease: LeaseRow,
  owner: string,
  timing: LeaseTiming,
  admit?: (row: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const now = timing.now ?? new Date();
  const stored = await readLease(db, lease);
  if (!stored) return false;
  if ((lease.holds && !lease.holds(stored.row)) || (admit && !admit(stored.row))) return false;
  const deadline = stored.leaseUntil ? Date.parse(stored.leaseUntil) : Number.NEGATIVE_INFINITY;
  const foreign = stored.leaseOwner != null && stored.leaseOwner !== owner;
  if (foreign && deadline > now.getTime()) return false;

  const where: Record<string, unknown> = { ...lease.key, ...lease.requires, leaseOwner: stored.leaseOwner };
  if (foreign) where.leaseUntil = stored.leaseUntil == null ? null : { '<': now.toISOString() };
  const until = now.getTime() + timing.ttlMs;
  await db.run(UPDATE.entity(lease.entity as never).set({ leaseOwner: owner, leaseUntil: new Date(until).toISOString() }).where(where));
  return heldUntil(await readLease(db, lease), lease, owner, until);
}

/** Extends the caller's lease, with `set` written in the same statement. False when it is lost. */
export async function renewLease(
  db: CapTransaction,
  lease: LeaseRow,
  owner: string,
  timing: LeaseTiming,
  set: Record<string, unknown> = {},
): Promise<boolean> {
  const until = (timing.now ?? new Date()).getTime() + timing.ttlMs;
  await db.run(UPDATE.entity(lease.entity as never)
    .set({ ...set, leaseUntil: new Date(until).toISOString() })
    .where({ ...lease.key, ...lease.requires, leaseOwner: owner }));
  return heldUntil(await readLease(db, lease), lease, owner, until);
}

/** Gives up only the caller's lease, so a former owner never clears its successor. */
export async function releaseLease(db: CapTransaction, lease: LeaseRow, owner: string, set: Record<string, unknown> = {}): Promise<void> {
  await db.run(UPDATE.entity(lease.entity as never)
    .set({ ...set, leaseOwner: null, leaseUntil: null })
    .where({ ...lease.key, leaseOwner: owner }));
}
