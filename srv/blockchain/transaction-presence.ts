import cds from '@sap/cds';
import { isNotFoundOnAllBackends } from '../utils/errors';
import { runWithoutAmbientTx } from '../utils/tx-utils';
import type { CardanoIndexer } from './cardano-indexer';
import type { CardanoClient } from './cardano-client';

export type TransactionLookup = Pick<CardanoClient, 'getTransaction' | 'supports'>;
export type PresenceIndexer = Pick<CardanoIndexer, 'findCrawledTransaction'>;

// Where the chain holds a transaction. scriptFailed: it landed with failing scripts, so only its
// collateral was spent. validityKnown: false when the source did not say whether its scripts passed.
export interface ChainPresence {
  slot: number | null;
  height: number | null;
  scriptFailed: boolean;
  validityKnown: boolean;
}

// The transaction on chain, from the crawled chain first, then the backends. Null when every backend
// answers not found, undefined when no configured backend can look transactions up. Throws when the
// lookup itself fails. A row outside the crawled chain is not evidence: a rollback may have removed it.
export async function findOnChain(indexer: PresenceIndexer, client: TransactionLookup, txHash: string): Promise<ChainPresence | null | undefined> {
  const crawled = await runWithoutAmbientTx(() => cds.tx((t) => indexer.findCrawledTransaction(t, txHash)));
  if (crawled) return { slot: crawled.slot, height: crawled.blockHeight, scriptFailed: crawled.spendsCollaterals, validityKnown: crawled.validityKnown };
  if (!client.supports('getTransaction')) return undefined;
  try {
    const tx = await client.getTransaction(txHash);
    return { slot: tx.slot ?? null, height: tx.blockHeight ?? null, scriptFailed: tx.spendsCollaterals === true, validityKnown: typeof tx.spendsCollaterals === 'boolean' };
  } catch (err) {
    if (isNotFoundOnAllBackends(err)) return null;
    throw err;
  }
}
