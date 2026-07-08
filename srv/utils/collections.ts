/**
 * Small collection helpers shared across the blockchain layer.
 */

/**
 * Split an array into fixed-size chunks. Used to keep CQL IN-lists below DB driver
 * bind-variable limits (SQLite caps at 999 on older builds / 32766 on node:sqlite).
 * @param arr  source array (not mutated)
 * @param size chunk size (must be > 0; guarded to avoid an infinite loop)
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError(`chunk size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Max bind variables per IN-list — well below every supported driver's cap. */
export const IN_CHUNK = 500;
