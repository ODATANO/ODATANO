import type { UTxO as OdatanoUtxo} from '../utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';

export function getLovelace(u: OdatanoUtxo): bigint {
  const entry = u.amount.find(a => (a.unit ?? "").toLowerCase() === "lovelace");
  return BigInt(entry?.quantity ?? "0");
}

export function assertAdaOnly(u: OdatanoUtxo): void {
  const nonAda = u.amount.filter(a => (a.unit ?? "").toLowerCase() !== "lovelace" && BigInt(a.quantity) !== 0n);
  if (nonAda.length > 0) {
    throw new Error(`UTxO ${u.txHash}#${u.outputIndex} contains non-ADA assets`);
  }
}

/**
 * Extract transaction hash from signed CBOR without submitting
 * Uses @harmoniclabs/cardano-ledger-ts to deserialize and hash the transaction
 */
export function getTxHashFromCbor(signedTxCbor: string): string {
  const txBytes = fromHex(signedTxCbor);
  const tx = Tx.fromCbor(txBytes);
  return tx.hash.toString();
}