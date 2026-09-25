import type { Network } from '../blockchain/cardano-client';

/**
 * Dependency-free holder for the active network, so leaf utilities (validators) can read it
 * without importing `server.ts`. Set by `initializeAppContext`, `null` before bootstrap.
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
