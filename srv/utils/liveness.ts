/**
 * Unauthenticated liveness body for CardanoIndexerService.getLiveness(): process facts only,
 * never touches app context, backends or DB, so it answers while those initialize or fail.
 */

import cds from '@sap/cds';
import path from 'path';

export interface Liveness {
  status: 'alive';
  timestamp: string;
  /** Seconds since the process started. */
  uptime: number;
  /** @odatano/core version; '' when package.json is not where the in-place build puts it. */
  version: string;
  /** Configured network (cds.requires.odatano-core.network, NETWORK, default preview). */
  network: string;
}

const processStartedAt = Date.now();

let cachedVersion: string | null = null;

function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    // srv/utils → package root; the in-place build keeps this path in plugin mode too.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.resolve(__dirname, '..', '..', 'package.json')) as { version?: unknown };
    cachedVersion = String(pkg.version ?? '');
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

export function buildLiveness(now: Date = new Date()): Liveness {
  const requires = (cds.env?.requires ?? {}) as Record<string, unknown>;
  const core = (requires['odatano-core'] ?? {}) as { network?: unknown };
  const network = String(core.network || process.env.NETWORK || 'preview');
  return {
    status: 'alive',
    timestamp: now.toISOString(),
    uptime: Math.max(0, Math.floor((now.getTime() - processStartedAt) / 1000)),
    version: packageVersion(),
    network,
  };
}
