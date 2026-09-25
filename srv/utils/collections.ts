/** Small collection helpers shared across the blockchain layer. */

/**
 * Split an array into fixed-size chunks; keeps CQL IN-lists below driver bind-variable limits
 * (SQLite: 999 on older builds, 32766 on node:sqlite).
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError(`chunk size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Max bind variables per IN-list, below every supported driver's cap. */
export const IN_CHUNK = 500;
