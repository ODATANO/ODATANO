import type { UTxO as OdatanoUtxo } from '../utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';
import { MixedAssetsError, InsufficientFundsError } from './errors';

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
 * Extract transaction hash from signed CBOR without submitting
 * @param signedTxCbor signed transaction in CBOR hex format
 * @returns {string} transaction hash (64 character hex string)
 * @throws {Error} if CBOR is invalid or transaction hash cannot be extracted
 */
export function getTxHashFromCbor(signedTxCbor: string): string {
  if (!signedTxCbor || typeof signedTxCbor !== 'string') {
    throw new Error('Invalid input: signedTxCbor must be a non-empty string');
  }

  // Validate hex format
  if (!/^[a-fA-F0-9]+$/.test(signedTxCbor)) {
    throw new Error('Invalid input: signedTxCbor must be a valid hex string');
  }

  let tx;
  try {
    const txBytes = fromHex(signedTxCbor);
    tx = Tx.fromCbor(txBytes);
  } catch {
    throw new Error('Failed to parse transaction CBOR');
  }

  if (!tx?.hash) {
    throw new Error('Failed to extract transaction hash from CBOR');
  }

  return tx.hash.toString();
}

/**
 * Maps builder errors to typed BackendErrors
 * Shared between CSL and Buildooor transaction builders
 * @param err Error from builder
 * @param assetUnit Asset unit that caused the error (default: 'lovelace')
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: any, assetUnit: string = 'lovelace'): never {
  const msg = (err?.message || err?.toString?.() || String(err)).toLowerCase();

  if (msg.includes('not enough') ||
      msg.includes('insufficient') ||
      msg.includes('balance')) {
    throw new InsufficientFundsError(assetUnit, 0n, 0n, err);
  }

  throw err;
}

/**
 * Parse asset unit string into policyId and assetName
 * Format: policyId (56 hex chars) + assetName (remaining hex)
 * Shared between CSL and Buildooor transaction builders
 */
export function parseAssetUnit(assetUnit: string): { policyId: string; assetName: string } {
  return {
    policyId: assetUnit.substring(0, 56),
    assetName: assetUnit.substring(56)
  };
}