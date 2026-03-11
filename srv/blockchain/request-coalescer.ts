/**
 * RequestCoalescer — Deduplicates concurrent requests for the same resource key.
 *
 * When multiple callers request the same key simultaneously (e.g., same txHash
 * during parallel address indexing), only one backend call is made. All callers
 * receive the same Promise/result.
 */
export class RequestCoalescer<T> {
  private pending = new Map<string, Promise<T>>();

  /**
   * Get a value by key, deduplicating concurrent requests.
   * If a request for this key is already in-flight, returns the existing Promise.
   * Otherwise, calls the fetcher and caches the Promise until it resolves.
   *
   * @param key    Unique identifier (e.g., txHash, bech32 address)
   * @param fetcher Function that performs the actual fetch
   * @returns The fetched value
   */
  async get(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = fetcher()
      .catch((err: unknown) => {
        // Clear on error so subsequent callers retry instead of getting cached rejection
        this.pending.delete(key);
        throw err;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise);
    return promise;
  }

  /** Number of currently in-flight requests */
  get size(): number {
    return this.pending.size;
  }
}
