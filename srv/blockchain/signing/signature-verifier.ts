import cds from '@sap/cds';
import { Cbor, CborArray, CborMap, CborTag, CborBytes, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_256, blake2b_224, verifyEd25519Signature_sync } from '@harmoniclabs/crypto';
import { BackendError, TransactionValidationError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { SignatureVerificationResult, VerificationOptions } from '../../utils/types';

const logger = cds.log('SignatureVerifier');

/**
 * blake2b-256 over the ORIGINAL transaction-body bytes (CBOR array index 0).
 * subCborRef preserves the exact received bytes, so the hash matches what was signed
 * and re-serialization can never drift it. Operating at the raw-CBOR level also avoids
 * the @harmoniclabs/cardano-ledger-ts AuxiliaryData.fromCbor bug on metadata-only aux_data.
 */
function computeBodyHash(txBytes: Uint8Array): string {
  const tx = Cbor.parse(txBytes);
  if (!(tx instanceof CborArray) || tx.array.length < 1 || !tx.array[0].subCborRef) {
    throw new Error('Invalid transaction CBOR: missing body');
  }
  return toHex(blake2b_256(tx.array[0].subCborRef.toBuffer()));
}

/**
 * Extract vkey witnesses (raw public key + signature bytes) from a transaction's
 * witness set (CBOR array index 1, map key 0). Conway wraps the witness array in CBOR
 * tag 258 (set) — unwrapped here. Returns [] when the tx has no vkey witnesses.
 */
function extractVkeyWitnesses(txBytes: Uint8Array): { pubKey: Uint8Array; signature: Uint8Array }[] {
  const tx = Cbor.parse(txBytes);
  if (!(tx instanceof CborArray) || !(tx.array[1] instanceof CborMap)) return [];
  const entry = tx.array[1].map.find(e => e.k instanceof CborUInt && Number((e.k as CborUInt).num) === 0);
  if (!entry) return [];
  let arr = entry.v;
  if (arr instanceof CborTag) arr = arr.data;
  if (!(arr instanceof CborArray)) return [];
  return arr.array.map(pair => {
    const [vk, sg] = (pair as CborArray).array;
    return { pubKey: (vk as CborBytes).bytes, signature: (sg as CborBytes).bytes };
  });
}

/**
 * SignatureVerifier - Verifies transaction signatures without accessing private keys
 *
 * This module provides signature verification for externally signed transactions.
 * It ensures:
 * 1. The signed CBOR is valid and parseable
 * 2. The transaction body hash matches the expected hash (integrity check)
 * 3. Required signatures are present (when specified)
 * 4. No tampering occurred between build and sign steps
 */
export class SignatureVerifier {
  /**
   * Verify a signed transaction
   *
   * @param signedTxCbor - The signed transaction in CBOR hex format
   * @param options - Verification options
   * @returns Verification result with details
   */
  public verify(signedTxCbor: string, options: VerificationOptions = {}): SignatureVerificationResult {
    const result: SignatureVerificationResult = {
      isValid: false,
      txBodyHash: '',
      witnessCount: 0,
      signerKeyHashes: [],
      warnings: [],
    };

    try {
      // Compute the body hash over the original CBOR body bytes (no re-serialization),
      // matching exactly what was signed. Raw-CBOR parsing is immune to the
      // @harmoniclabs/cardano-ledger-ts AuxiliaryData.fromCbor bug that rejects
      // metadata-only Conway aux_data.
      const txBytes = fromHex(signedTxCbor);
      const computedHash = computeBodyHash(txBytes);
      result.txBodyHash = computedHash;

      logger.debug(`Computed transaction body hash: ${computedHash}`);

      // verify transaction body hash matches expected
      if (options.expectedTxBodyHash) {
        if (computedHash.toLowerCase() !== options.expectedTxBodyHash.toLowerCase()) {
          result.errorMessage = `Transaction body hash mismatch. Expected: ${options.expectedTxBodyHash}, Got: ${computedHash}. The transaction may have been tampered with.`;
          logger.warn(result.errorMessage);
          return result;
        }
        logger.debug('Transaction body hash verified successfully');
      }

      // Extract vkey witnesses (raw pubkey + signature bytes)
      const vkeyWitnesses = extractVkeyWitnesses(txBytes);
      result.witnessCount = vkeyWitnesses.length;

      if (vkeyWitnesses.length > 0) {
        // signer key hash = blake2b-224 of the Ed25519 public key
        for (const w of vkeyWitnesses) {
          result.signerKeyHashes.push(toHex(blake2b_224(w.pubKey)));
        }
        logger.debug(`Found ${result.witnessCount} witness(es): ${result.signerKeyHashes.join(', ')}`);
      }

      // check if signature is required but missing
      if (options.requireSignature !== false && result.witnessCount === 0) {
        result.errorMessage = 'No signatures found in transaction. The transaction must be signed before submission.';
        logger.warn(result.errorMessage);
        return result;
      }

      // verify required signers (if specified)
      if (options.requiredSigners && options.requiredSigners.length > 0) {
        const missingSigners = options.requiredSigners.filter(
          required => !result.signerKeyHashes.some(
            signer => signer.toLowerCase() === required.toLowerCase()
          )
        );

        if (missingSigners.length > 0) {
          result.errorMessage = `Missing required signatures from: ${missingSigners.join(', ')}`;
          result.warnings.push(result.errorMessage);
          logger.warn(result.errorMessage);
          return result;
        }
      }

      // verify each signature cryptographically against the transaction body hash
      if (vkeyWitnesses.length > 0) {
        const bodyHashBytes = fromHex(computedHash);

        for (let i = 0; i < vkeyWitnesses.length; i++) {
          const { pubKey, signature } = vkeyWitnesses[i];
          const isValidSig = verifyEd25519Signature_sync(signature, bodyHashBytes, pubKey);

          if (!isValidSig) {
            result.errorMessage = `Invalid signature at witness index ${i}. The signature does not match the transaction body.`;
            logger.warn(result.errorMessage);
            return result;
          }
        }

        logger.debug('All signatures verified cryptographically');
      }

      // All checks passed
      result.isValid = true;
      logger.info(`Signature verification successful. ${result.witnessCount} valid signature(s).`);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errorMessage = `Failed to verify signature: ${msg}`;
      logger.error(result.errorMessage);
    }

    return result;
  }

  /**
   * Verify signature and throw on failure
   *
   * @param signedTxCbor - The signed transaction in CBOR hex format
   * @param options - Verification options
   * @throws {TransactionValidationError} if verification fails
   */
  public verifyOrThrow(signedTxCbor: string, options: VerificationOptions = {}): SignatureVerificationResult {
    const result = this.verify(signedTxCbor, options);

    if (!result.isValid) {
      throw new TransactionValidationError(
        result.errorMessage || 'Signature verification failed',
        new Error(result.errorMessage)
      );
    }

    return result;
  }

  /**
   * Extract transaction body hash from unsigned or signed CBOR
   *
   * @param txCbor - Transaction CBOR (signed or unsigned)
   * @returns Transaction body hash as hex string
   * @throws {Error} if CBOR is invalid
   */
  public extractTxBodyHash(txCbor: string): string {
    try {
      return computeBodyHash(fromHex(txCbor));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new BackendError(
        `Failed to extract transaction body hash: ${msg}`,
        400,
        ERROR_CODES.INVALID_INPUT
      );
    }
  }

  /**
   * Check if a transaction is signed (has witnesses)
   *
   * @param txCbor - Transaction CBOR
   * @returns true if transaction has at least one witness
   */
  public isSigned(txCbor: string): boolean {
    try {
      return extractVkeyWitnesses(fromHex(txCbor)).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get witness count from transaction
   *
   * @param txCbor - Transaction CBOR
   * @returns Number of witnesses
   */
  public getWitnessCount(txCbor: string): number {
    try {
      return extractVkeyWitnesses(fromHex(txCbor)).length;
    } catch {
      return 0;
    }
  }
}

// Singleton instance
let verifierInstance: SignatureVerifier | null = null;

/**
 * Get the singleton SignatureVerifier instance
 */
export function getSignatureVerifier(): SignatureVerifier {
  if (!verifierInstance) {
    verifierInstance = new SignatureVerifier();
  }
  return verifierInstance;
}
