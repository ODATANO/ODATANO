import cds from '@sap/cds';
import { Cbor, CborArray, CborMap, CborTag, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { TransactionValidationError } from './errors';

const logger = cds.log('SigningHelper');

/**
 * Combine an unsigned tx with the witness set a CIP-30 `signTx()` returns into a submittable signed tx.
 * @returns complete signed transaction CBOR (hex)
 */
export function combineTransactionWithWitnesses(unsignedTxCbor: string, witnessSetCbor: string): string {
  try {
    // Raw CBOR level: no Cardano type validation, preserves all encoding metadata
    const txObj = Cbor.parse(fromHex(unsignedTxCbor));

    if (!(txObj instanceof CborArray) || txObj.array.length < 2) {
      throw new TransactionValidationError('Invalid transaction CBOR structure');
    }

    const walletWsObj = Cbor.parse(fromHex(witnessSetCbor));

    // txObj.array[0] = body, [1] = witness_set, [2] = is_valid, [3] = auxiliary_data
    const origWs = txObj.array[1];

    let witnessCount = 0;

    if (origWs instanceof CborMap && walletWsObj instanceof CborMap) {
      // Wallet's VKey witnesses (map key 0)
      const walletVkeyEntry = walletWsObj.map.find(
        e => e.k instanceof CborUInt && Number(e.k.num) === 0
      );

      if (walletVkeyEntry) {
        // Keep original entries (redeemers, datums, scripts at keys 3-7), replace key 0 with the wallet's
        const mergedEntries = origWs.map
          .filter(e => !(e.k instanceof CborUInt && Number(e.k.num) === 0))
          .concat([walletVkeyEntry]);

        // New witness set map preserving the original's encoding style
        txObj.array[1] = new CborMap(mergedEntries, {
          indefinite: origWs.indefinite,
        });
        // VKey witnesses: CborArray, or CborTag(258, CborArray) in Conway
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

    // New outer CborArray so the encoder cannot reuse the stale outer subCborRef; the inner
    // subCborRefs are kept so the body bytes (and thus the signed body hash) stay identical.
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

/** True when the CBOR is a CIP-30 witness set (map) rather than a full transaction (array). */
export function isWitnessSetCbor(cborHex: string): boolean {
  try {
    const obj = Cbor.parse(fromHex(cborHex));
    if (obj instanceof CborArray) return false;
    return obj instanceof CborMap;
  } catch {
    return false;
  }
}
