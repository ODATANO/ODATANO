import type { Network } from '../blockchain/cardano-client';
import { configuredNetworkName } from '../config';

// Holds the active network so validators can read it without importing server.ts.
let active: Network | null = null;

const NETWORKS: readonly string[] = ['mainnet', 'preview', 'preprod'];

/** Record the active network. Pass `null` to clear (shutdown/reset). */
export function setActiveNetwork(n: Network | null): void {
  active = n;
}

// The network of the running app context, else the configured one. Before the context exists a
// request is still checked against its network; the missing context then answers 503 by itself.
export function getActiveNetwork(): Network | null {
  if (active) return active;
  const configured = configuredNetworkName();
  return NETWORKS.includes(configured) ? configured as Network : null;
}
