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

    if (!(origWs instanceof CborMap) || !(walletWsObj instanceof CborMap)) {
      throw new TransactionValidationError('Witness set must be CBOR map per Cardano spec');
    }

    // The wallet signs with vkey witnesses (map key 0) or, for Byron addresses, bootstrap witnesses (key 2)
    const isSignatureKey = (k: unknown) => k instanceof CborUInt && (Number(k.num) === 0 || Number(k.num) === 2);
    const walletSignatures = walletWsObj.map.filter(e => isSignatureKey(e.k));
    let witnessCount = 0;
    for (const { v } of walletSignatures) {
      // CborArray, or CborTag(258, CborArray) in Conway
      const items = v instanceof CborArray ? v.array : v instanceof CborTag && v.data instanceof CborArray ? v.data.array : undefined;
      if (!items) throw new TransactionValidationError('Unexpected witness format in witness set');
      witnessCount += items.length;
    }
    if (witnessCount === 0) {
      throw new TransactionValidationError('Witness set carries no vkey or bootstrap witness; the wallet did not sign');
    }

    // Keep original entries (redeemers, datums, scripts at keys 3-7), take the signatures from the wallet
    const mergedEntries = origWs.map.filter(e => !isSignatureKey(e.k)).concat(walletSignatures);
    // New witness set map preserving the original's encoding style
    txObj.array[1] = new CborMap(mergedEntries, { indefinite: origWs.indefinite });

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

/**
 * True when the CBOR is a CIP-30 witness set (map) rather than a full transaction (array).
 * Reads the major type of the first byte only; a malformed map fails later in the combine step.
 */
export function isWitnessSetCbor(cborHex: string): boolean {
  if (!/^[0-9a-f]{2}/i.test(cborHex)) return false;
  return parseInt(cborHex.slice(0, 2), 16) >> 5 === 5;
}

/** The signed transaction: as given, or the unsigned one plus a CIP-30 witness set. */
export function toSignedTransaction(unsignedTxCbor: string | null | undefined, signedTxOrWitnessSet: string): string {
  if (!isWitnessSetCbor(signedTxOrWitnessSet)) return signedTxOrWitnessSet;
  if (!unsignedTxCbor) throw new TransactionValidationError('No unsigned transaction to add the witness set to');
  return combineTransactionWithWitnesses(unsignedTxCbor, signedTxOrWitnessSet);
}
