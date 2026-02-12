import cds from '@sap/cds';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { fromHex } from '@harmoniclabs/uint8array-utils';
import { BackendError, TransactionValidationError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { SignatureVerificationResult, VerificationOptions } from '../../utils/types';

const logger = cds.log('SignatureVerifier');

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
      // Parse the signed transaction CBOR using harmoniclabs.
      const txBytesHarmonic = fromHex(signedTxCbor);
      const txHarmonic = Tx.fromCbor(txBytesHarmonic);
      const computedHash = txHarmonic.hash.toString();
      result.txBodyHash = computedHash;

      logger.debug(`Computed transaction body hash (harmoniclabs): ${computedHash}`);

      // Also parse with CSL for witness extraction and Ed25519 verification
      const txBytes = Buffer.from(signedTxCbor, 'hex');
      const tx = CSL.Transaction.from_bytes(txBytes);

      // verify transaction body hash matches expected
      if (options.expectedTxBodyHash) {
        if (computedHash.toLowerCase() !== options.expectedTxBodyHash.toLowerCase()) {
          result.errorMessage = `Transaction body hash mismatch. Expected: ${options.expectedTxBodyHash}, Got: ${computedHash}. The transaction may have been tampered with.`;
          logger.warn(result.errorMessage);
          return result;
        }
        logger.debug('Transaction body hash verified successfully');
      }

      // Extract witness set
      const witnessSet = tx.witness_set();
      const vkeyWitnesses = witnessSet.vkeys();

      if (vkeyWitnesses) {
        result.witnessCount = vkeyWitnesses.len();

        // extract signer public key hashes
        for (let i = 0; i < vkeyWitnesses.len(); i++) {
          const witness = vkeyWitnesses.get(i);
          const vkey = witness.vkey();
          const pubKeyHash = vkey.public_key().hash();
          result.signerKeyHashes.push(Buffer.from(pubKeyHash.to_bytes()).toString('hex'));
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

      // verify each signature cryptographically
      if (vkeyWitnesses && vkeyWitnesses.len() > 0) {
        const bodyHash = CSL.TransactionHash.from_bytes(Buffer.from(computedHash, 'hex'));

        for (let i = 0; i < vkeyWitnesses.len(); i++) {
          const witness = vkeyWitnesses.get(i);
          const vkey = witness.vkey();
          const signature = witness.signature();
          const publicKey = vkey.public_key();

          // verify the signature against the transaction body hash
          const isValidSig = publicKey.verify(bodyHash.to_bytes(), signature);

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

    } catch (error: any) {
      result.errorMessage = `Failed to verify signature: ${error.message}`;
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
      const txBytes = fromHex(txCbor);
      const tx = Tx.fromCbor(txBytes);
      return tx.hash.toString();
    } catch (error: any) {
      throw new BackendError(
        `Failed to extract transaction body hash: ${error.message}`,
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
      const txBytes = Buffer.from(txCbor, 'hex');
      const tx = CSL.Transaction.from_bytes(txBytes);
      const witnessSet = tx.witness_set();
      const vkeyWitnesses = witnessSet.vkeys();
      return vkeyWitnesses !== undefined && vkeyWitnesses.len() > 0;
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
      const txBytes = Buffer.from(txCbor, 'hex');
      const tx = CSL.Transaction.from_bytes(txBytes);
      const witnessSet = tx.witness_set();
      const vkeyWitnesses = witnessSet.vkeys();
      return vkeyWitnesses ? vkeyWitnesses.len() : 0;
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
