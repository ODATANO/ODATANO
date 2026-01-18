import type { UTxO as OdatanoUtxo } from '../utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';
import blake2b from 'blake2b';
import * as cbor from 'cbor';

/** 
 * Extract lovelace amount from UTxO
 * @param u UTxO to extract from
 * @returns {bigint} lovelace amount
 */
export function getLovelace(u: OdatanoUtxo): bigint {
  const entry = u.amount.find(a => (a.unit).toLowerCase() === "lovelace");
  return BigInt(entry?.quantity ?? "0");
}

/** 
 * Assert that UTxO contains only ADA (lovelace)
 * @param u UTxO to check
 * @throws {Error} if UTxO contains non-ADA assets
 */
export function assertAdaOnly(u: OdatanoUtxo): void {
  const nonAda = u.amount.filter(a => (a.unit).toLowerCase() !== "lovelace" && BigInt(a.quantity) !== 0n);
  if (nonAda.length > 0) {
    throw new Error(`UTxO ${u.txHash}#${u.outputIndex} contains non-ADA assets`);
  }
}

/** 
 * Extract transaction hash from signed CBOR without submitting
 * @param signedTxCbor signed transaction in CBOR hex format
 * @returns {string} transaction hash (hex)
 */
export function getTxHashFromCbor(signedTxCbor: string): string {
  try {
    // Try with harmoniclabs library first
    const txBytes = fromHex(signedTxCbor);
    const tx = Tx.fromCbor(txBytes);
    return tx.hash.toString();
  } catch (error) {
    // Fallback: Decode CBOR and hash the original body bytes
    try {
      const txBytes = Buffer.from(signedTxCbor, 'hex');
      const txArray = cbor.Decoder.decodeFirstSync(txBytes);
      const bodyBytes = cbor.encode(txArray[0]);
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      return hash;
    } catch (cborError) {
      throw new Error(`Failed to extract tx hash from CBOR: ${error}. CBOR fallback also failed: ${cborError}`);
    }
  }
}