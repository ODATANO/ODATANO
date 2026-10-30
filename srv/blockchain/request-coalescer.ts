/** Concurrent requests for the same key share one backend call and its result. */
export class RequestCoalescer<T> {
  private pending = new Map<string, Promise<T>>();

  /** Returns the in-flight promise for this key, or starts the fetcher. */
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
