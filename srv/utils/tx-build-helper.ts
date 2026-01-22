import type { UTxO as OdatanoUtxo } from '../utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';
import { InsufficientFundsError, MixedAssetsError } from './errors';

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
 * @throws {MixedAssetsError} if UTxO contains non-ADA assets
 */
export function assertAdaOnly(u: OdatanoUtxo): void {
  const nonAda = u.amount.filter(a => (a.unit).toLowerCase() !== "lovelace" && BigInt(a.quantity) !== 0n);
  if (nonAda.length > 0) {
    throw new MixedAssetsError(
      `${u.txHash}#${u.outputIndex}`,
      nonAda.map(a => a.unit)
    );
  }
}

/**
 * Get asset quantity from UTxO
 * @param u UTxO to extract from
 * @param assetUnit asset unit (policyId.assetName or "lovelace")
 * @returns {bigint} asset quantity
 */
export function getAssetQuantity(u: OdatanoUtxo, assetUnit: string): bigint {
  const entry = u.amount.find(a => a.unit === assetUnit);
  return BigInt(entry?.quantity ?? "0");
}

/**
 * Select UTxOs containing a specific asset until target amount is reached
 * @param utxos available UTxOs
 * @param assetUnit asset unit to collect (policyId.assetName or "lovelace")
 * @param targetAmount target amount to reach
 * @returns {OdatanoUtxo[]} selected UTxOs containing enough of the asset
 * @throws {Error} if not enough assets available
 */
export function selectUtxosForAsset(
  utxos: OdatanoUtxo[], 
  assetUnit: string, 
  targetAmount: bigint
): OdatanoUtxo[] {
  // Filter UTxOs that contain the asset and sort by quantity (descending)
  const utxosWithAsset = utxos
    .filter(u => getAssetQuantity(u, assetUnit) > 0n)
    .sort((a, b) => {
      const qtyA = getAssetQuantity(a, assetUnit);
      const qtyB = getAssetQuantity(b, assetUnit);
      return qtyB > qtyA ? 1 : qtyB < qtyA ? -1 : 0;
    });

  let accumulated = 0n;
  const selected: OdatanoUtxo[] = [];

  for (const utxo of utxosWithAsset) {
    selected.push(utxo);
    accumulated += getAssetQuantity(utxo, assetUnit);
    
    if (accumulated >= targetAmount) {
      return selected;
    }
  }

  throw new InsufficientFundsError(assetUnit, targetAmount, accumulated);
}


/** 
 * Extract transaction hash from signed CBOR without submitting
 * @param signedTxCbor signed transaction in CBOR hex format
 * @returns {string} transaction hash (hex)
 */
export function getTxHashFromCbor(signedTxCbor: string): string {
    // Try with harmoniclabs library first
    const txBytes = fromHex(signedTxCbor);
    const tx = Tx.fromCbor(txBytes);
    return tx.hash.toString();
  }