import cds from '@sap/cds';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import * as cbor from 'cbor';
import { TransactionValidationError } from './errors';

const logger = cds.log('SigningHelper');

/**
 * Combine an unsigned transaction with a witness set from CIP-30 wallet signing
 *
 * CIP-30 signTx() returns only the witness set, not a complete signed transaction.
 * This function combines the original unsigned transaction with the witness set
 * to create a complete signed transaction that can be submitted to the network.
 *
 * Cardano transaction structure: [body, witness_set, is_valid, auxiliary_data]
 *
 * @param unsignedTxCbor - The unsigned transaction CBOR (hex)
 * @param witnessSetCbor - The witness set CBOR from CIP-30 signTx() (hex)
 * @returns Complete signed transaction CBOR (hex)
 */
export function combineTransactionWithWitnesses(unsignedTxCbor: string, witnessSetCbor: string): string {
  try {
    // Decode the unsigned transaction CBOR (array of 4 elements)
    const unsignedTxBytes = Buffer.from(unsignedTxCbor, 'hex');
    const txArray = cbor.decodeFirstSync(unsignedTxBytes);

    if (!Array.isArray(txArray) || txArray.length < 2) {
      throw new Error('Invalid transaction CBOR structure');
    }

    // Decode the wallet's witness set
    const witnessSetBytes = Buffer.from(witnessSetCbor, 'hex');
    const walletWitnessSet = cbor.decodeFirstSync(witnessSetBytes);

    // txArray[0] = body (preserved exactly as-is)
    // txArray[1] = witness_set (will be replaced with wallet's witness set)
    // txArray[2] = is_valid (boolean, usually true)
    // txArray[3] = auxiliary_data (preserved as-is)

    // Replace the witness set with the wallet's witness set
    txArray[1] = walletWitnessSet;

    // Re-encode to CBOR
    const signedTxBytes = cbor.encodeOne(txArray);
    const signedTxCbor = signedTxBytes.toString('hex');

    // Count witnesses for logging
    let witnessCount = 0;
    if (walletWitnessSet instanceof Map) {
      const vkeys = walletWitnessSet.get(0);
      witnessCount = Array.isArray(vkeys) ? vkeys.length : 0;
    }

    logger.info({
      unsignedTxLength: unsignedTxCbor.length,
      witnessSetLength: witnessSetCbor.length,
      signedTxLength: signedTxCbor.length,
      witnessCount,
    }, 'Combined transaction with witness set (raw CBOR)');

    return signedTxCbor;
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to combine transaction with witnesses');
    throw new TransactionValidationError(
      `Failed to combine transaction with witnesses: ${error.message}`
    );
  }
}

/**
 * Check if a CBOR string is a witness set (vs a full transaction)
 *
 * CIP-30 returns witness sets, not full transactions.
 * This helps detect when we need to call combineTransactionWithWitnesses.
 *
 * @param cborHex - CBOR hex string
 * @returns true if it's a witness set, false if it's a full transaction
 */
export function isWitnessSetCbor(cborHex: string): boolean {
  try {
    const bytes = Buffer.from(cborHex, 'hex');
    // Try to parse as transaction first
    try {
      const tx = CSL.Transaction.from_bytes(bytes);
      // If successful and has a body, it's a full transaction
      tx.body();
      return false;
    } catch {
      // Not a transaction, try as witness set
      CSL.TransactionWitnessSet.from_bytes(bytes);
      return true;
    }
  } catch {
    // Neither - could be invalid CBOR
    return false;
  }
}
