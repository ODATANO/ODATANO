import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import {
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata_ as TransactionMetadata,
  TransactionCertificates,
  TransactionWithdrawals,
} from '#cds-models/odatano/cardano';
import { chunk, IN_CHUNK } from '../utils/collections';

const { SELECT, DELETE } = cds.ql;

export interface TxKey { hash: string; txSeq: number | string | null }

/** `txSeq` as a stable map key: Int64 columns come back as number or string depending on the driver. */
export const seqKey = (txSeq: number | string): string => String(Number(txSeq));

/** Hash and txSeq of the given transactions that are indexed. */
export async function readTxKeys(tx: CapTransaction, hashes: string[]): Promise<TxKey[]> {
  const keys: TxKey[] = [];
  for (const hashChunk of chunk(hashes, IN_CHUNK)) {
    const rows = await tx.run(
      SELECT.from(Transactions).columns('hash', 'txSeq').where({ hash: { in: hashChunk } })
    ) as TxKey[];
    keys.push(...(rows ?? []));
  }
  return keys;
}

/** Delete transactions with their input/output, asset, metadata, certificate and withdrawal rows. */
export async function deleteTransactionRows(tx: CapTransaction, keys: TxKey[]): Promise<void> {
  for (const keyChunk of chunk(keys, IN_CHUNK)) {
    const hashes = keyChunk.map(k => k.hash);
    const seqs = keyChunk.filter(k => k.txSeq != null).map(k => k.txSeq as number | string);
    if (seqs.length) {
      await tx.run(DELETE.from(TransactionInputAssets).where({ input_txSeq: { in: seqs } }));
      await tx.run(DELETE.from(TransactionOutputAssets).where({ output_txSeq: { in: seqs } }));
      await tx.run(DELETE.from(TransactionInputs).where({ txSeq: { in: seqs } }));
      await tx.run(DELETE.from(TransactionOutputs).where({ txSeq: { in: seqs } }));
    }
    await tx.run(DELETE.from(TransactionMetadata).where({ tx_hash: { in: hashes } }));
    await tx.run(DELETE.from(TransactionCertificates).where({ tx_hash: { in: hashes } }));
    await tx.run(DELETE.from(TransactionWithdrawals).where({ tx_hash: { in: hashes } }));
    await tx.run(DELETE.from(Transactions).where({ hash: { in: hashes } }));
  }
}
