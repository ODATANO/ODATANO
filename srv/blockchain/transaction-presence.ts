import cds from '@sap/cds';
import { isNotFoundOnAllBackends } from '../utils/errors';
import { runWithoutAmbientTx } from '../utils/tx-utils';
import type { CardanoIndexer } from './cardano-indexer';
import type { CardanoClient } from './cardano-client';

export type TransactionLookup = Pick<CardanoClient, 'getTransaction' | 'supports'>;

// True when the transaction is on chain, false when every backend answers not found, null when
// no configured backend can look transactions up. Throws when the lookup itself fails.
export async function isTransactionOnChain(
  indexer: Pick<CardanoIndexer, 'findIndexedTransaction'>,
  client: TransactionLookup,
  txHash: string,
): Promise<boolean | null> {
  // the local index first (filled by the crawler), then the backends
  const indexed = await runWithoutAmbientTx(() => cds.tx((t) => indexer.findIndexedTransaction(t, txHash)));
  if (indexed) return true;
  if (!client.supports('getTransaction')) return null;
  try {
    await client.getTransaction(txHash);
    return true;
  } catch (err) {
    if (isNotFoundOnAllBackends(err)) return false;
    throw err;
  }
}
