import cds from '@sap/cds';
import { Cbor, CborArray, CborMap, CborTag, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { TransactionValidationError } from './errors';

const logger = cds.log('SigningHelper');

/**
 * Combine an unsigned transaction with a witness set from CIP-30 wallet signing
 *
 * CIP-30 signTx() returns only the witness set, not a complete signed transaction.
 * This function combines the original unsigned transaction with the witness set
 * to create a complete signed transaction that can be submitted to the network.
 *
 * @param unsignedTxCbor - The unsigned transaction CBOR (hex)
 * @param witnessSetCbor - The witness set CBOR from CIP-30 signTx() (hex)
 * @returns Complete signed transaction CBOR (hex)
 */
export function combineTransactionWithWitnesses(unsignedTxCbor: string, witnessSetCbor: string): string {
  try {
    // Parse at raw CBOR level — no Cardano type validation, preserves all encoding metadata
    const txObj = Cbor.parse(fromHex(unsignedTxCbor));

    if (!(txObj instanceof CborArray) || txObj.array.length < 2) {
      throw new TransactionValidationError('Invalid transaction CBOR structure');
    }

    const walletWsObj = Cbor.parse(fromHex(witnessSetCbor));

    // txObj.array[0] = body, [1] = witness_set, [2] = is_valid, [3] = auxiliary_data
    const origWs = txObj.array[1];

    let witnessCount = 0;

    if (origWs instanceof CborMap && walletWsObj instanceof CborMap) {
      // Find wallet's VKey witnesses (map key 0)
      const walletVkeyEntry = walletWsObj.map.find(
        e => e.k instanceof CborUInt && Number(e.k.num) === 0
      );

      if (walletVkeyEntry) {
        // Merge: keep all original entries (redeemers, datums, scripts at keys 3-7),
        // remove any existing key 0, then add wallet's key 0 (VKey witnesses)
        const mergedEntries = origWs.map
          .filter(e => !(e.k instanceof CborUInt && Number(e.k.num) === 0))
          .concat([walletVkeyEntry]);

        // Construct new witness set CborMap preserving the original's encoding style
        txObj.array[1] = new CborMap(mergedEntries, {
          indefinite: origWs.indefinite,
        });
        // Count VKey witnesses — value may be CborArray or CborTag(258, CborArray) in Conway era
        const vkeyValue = walletVkeyEntry.v;
        if (vkeyValue instanceof CborArray) {
          witnessCount = vkeyValue.array.length;
        } else if (vkeyValue instanceof CborTag && vkeyValue.data instanceof CborArray) {
          witnessCount = vkeyValue.data.array.length;
        } else {
          throw new TransactionValidationError('Unexpected VKey witness format in witness set');
        }
      }
    } else {
      throw new TransactionValidationError('Witness set must be CBOR map per Cardano spec');
    }

    // Re-encode the tx array, preserving encoding metadata on body and all witness values.
    // Construct a new CborArray to avoid stale subCborRef pointing to the old bytes.
    const signedTxCbor = toHex(Cbor.encode(
      new CborArray(txObj.array, { indefinite: txObj.indefinite })
    ));

    logger.info({
      unsignedTxLength: unsignedTxCbor.length,
      witnessSetLength: witnessSetCbor.length,
      signedTxLength: signedTxCbor.length,
      witnessCount,
    }, 'Combined transaction with witness set (harmoniclabs CBOR)');

    return signedTxCbor;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Failed to combine transaction with witnesses');
    throw new TransactionValidationError(
      `Failed to combine transaction with witnesses: ${msg}`
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
    const obj = Cbor.parse(fromHex(cborHex));
    // A full transaction is a CBOR array ([body, witness_set, is_valid, aux_data]);
    // a CIP-30 witness set is a CBOR map. The two shapes are unambiguous.
    if (obj instanceof CborArray) return false;
    return obj instanceof CborMap;
  } catch {
    // Invalid / unparseable CBOR
    return false;
  }
}
