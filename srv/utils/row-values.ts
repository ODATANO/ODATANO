// Database reads return Int64 and Decimal as text and timestamps in the adapter's own form.
// These turn a column value into the type the code works with.

/** The number in `v`, or null when the column is empty or not a number. */
export function optionalNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** The number in `v`, or `fallback` when the column is empty or not a number. */
export function requiredNum(v: unknown, fallback = 0): number {
  return optionalNum(v) ?? fallback;
}

/** A timestamp column as ISO text, or null when empty. */
export function timestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
