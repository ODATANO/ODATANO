import type { Network } from '../blockchain/cardano-client';

/**
 * Module-scoped holder for the active Cardano network.
 *
 * This is a deliberately tiny *leaf* module: it has no runtime dependencies (the
 * `Network` import is type-only and erased at compile), so leaf utilities such as
 * `validators.ts` can read the configured network WITHOUT importing `server.ts`
 * — which would otherwise drag the whole server → indexer graph (and its
 * module-load `cds.ql` access) into every consumer.
 *
 * Set during bootstrap by `initializeAppContext` and cleared on shutdown. Reads
 * before bootstrap return `null`; callers treat that as "not ready" rather than
 * throwing (e.g. network-aware validators return `false`).
 */
let active: Network | null = null;

/** Record the active network. Pass `null` to clear (shutdown/reset). */
export function setActiveNetwork(n: Network | null): void {
  active = n;
}

/** The active network, or `null` if the app context has not been initialized. */
export function getActiveNetwork(): Network | null {
  return active;
}
