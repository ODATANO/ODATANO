// Readiness body for getReadiness(): whether this instance can serve requests. It names the
// missing part and nothing else, so an anonymous probe learns no configuration detail.

import cds from '@sap/cds';
import { detachedTx } from './tx-utils';

const { SELECT } = cds.ql;

const PROBE_TIMEOUT_MS = 3000;

export interface Readiness {
  status: 'ready' | 'not_ready';
  timestamp: string;
  /** The client, the indexer and the transaction builder exist. */
  context: boolean;
  /** The database answers and holds the schema. */
  database: boolean;
  /** The HSM session is connected; null when no HSM is configured. */
  hsm: boolean | null;
}

async function databaseAnswers(): Promise<boolean> {
  if (!cds.db) return false;
  try {
    await detachedTx('readiness probe', (db) => db.run(SELECT.one.from('odatano.cardano.CardanoSyncState').columns('ID')), PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function buildReadiness(parts: Pick<Readiness, 'context' | 'hsm'>, now: Date = new Date()): Promise<Readiness> {
  const database = await databaseAnswers();
  const ready = parts.context && database && parts.hsm !== false;
  return { status: ready ? 'ready' : 'not_ready', timestamp: now.toISOString(), context: parts.context, database, hsm: parts.hsm };
}
