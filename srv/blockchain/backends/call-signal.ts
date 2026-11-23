import { AsyncLocalStorage } from 'node:async_hooks';

// The abort signal of the backend call in progress. CardanoClient aborts it when the call times
// out, so the HTTP requests and batch loops the call started stop as well.
const storage = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` as the signal of the backend call. */
export function withCallSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return storage.run(signal, fn);
}

/** Signal of the backend call in progress, if any. */
export function callSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/** Throws the abort reason once the backend call in progress was given up. */
export function throwIfCallAborted(): void {
  callSignal()?.throwIfAborted();
}
