import cds from '@sap/cds';
import { parseTransaction } from '../cbor/parse';
import type { UTxO } from '../utils/types';

const logger = cds.log('PendingSpends');

/** How long a submitted transaction counts as pending when no crawled block confirms it earlier. */
export const PENDING_TX_TTL_MS = 10 * 60_000;

interface PendingTx {
  inputs: string[];
  outputs: UTxO[];
  expiresAt: number;
}

const refKey = (txHash: string, outputIndex: number): string => `${txHash.toLowerCase()}#${outputIndex}`;

// Submitted transactions still in the mempool, whose inputs still look unspent. Builders skip
// those inputs and may spend the pending change. Entries end when crawled or after PENDING_TX_TTL_MS.
export class PendingSpends {
  private readonly txs = new Map<string, PendingTx>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember a submitted transaction; unparseable CBOR is ignored (the submit already succeeded). */
  record(signedTxCbor: string): void {
    try {
      const parsed = parseTransaction(signedTxCbor);
      this.txs.set(parsed.txHash, {
        inputs: parsed.inputs.map((i) => refKey(i.txHash, i.outputIndex)),
        outputs: parsed.outputs.map((o, outputIndex) => ({
          txHash: parsed.txHash,
          outputIndex,
          address: o.address,
          amount: [{ unit: 'lovelace', quantity: o.lovelace }, ...o.assets],
          datumHash: o.datumHash,
          inlineDatum: o.inlineDatumHex,
          scriptRefCbor: o.referenceScriptHex,
        })),
        expiresAt: this.now() + PENDING_TX_TTL_MS,
      });
    } catch (err) {
      logger.warn(`submitted transaction not tracked as pending: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The pending transaction that spends this output, if any. */
  spentBy(txHash: string, outputIndex: number): string | undefined {
    this.prune();
    const key = refKey(txHash, outputIndex);
    for (const [hash, tx] of this.txs) if (tx.inputs.includes(key)) return hash;
    return undefined;
  }

  // The address's UTxOs after the pending transactions. One whose outputs already appear in `utxos`
  // has been crawled and is forgotten.
  apply(address: string, utxos: UTxO[]): UTxO[] {
    this.prune();
    if (this.txs.size === 0) return utxos;
    const listed = new Set(utxos.map((u) => u.txHash.toLowerCase()));
    for (const hash of [...this.txs.keys()]) if (listed.has(hash)) this.txs.delete(hash);

    const spent = new Set([...this.txs.values()].flatMap((t) => t.inputs));
    const keep = utxos.filter((u) => !spent.has(refKey(u.txHash, u.outputIndex)));
    const pendingOut = [...this.txs.values()]
      .flatMap((t) => t.outputs)
      .filter((o) => o.address === address && !spent.has(refKey(o.txHash, o.outputIndex)));
    return [...keep, ...pendingOut];
  }

  get size(): number {
    this.prune();
    return this.txs.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [hash, tx] of this.txs) if (tx.expiresAt <= now) this.txs.delete(hash);
  }
}
