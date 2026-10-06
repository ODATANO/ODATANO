import cds from '@sap/cds';
import { Cbor, CborArray, CborMap, CborTag, CborBytes, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_256, blake2b_224, verifyEd25519Signature_sync } from '@harmoniclabs/crypto';
import { BackendError, TransactionValidationError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { SignatureVerificationResult, TxWitnessVerification, VerificationOptions } from '../../utils/types';

const logger = cds.log('SignatureVerifier');

/**
 * blake2b-256 over the ORIGINAL transaction-body bytes (CBOR array index 0). subCborRef
 * preserves the exact received bytes, so the hash matches what was signed.
 */
function computeBodyHash(txBytes: Uint8Array): string {
  const tx = Cbor.parse(txBytes);
  if (!(tx instanceof CborArray) || tx.array.length < 1 || !tx.array[0].subCborRef) {
    throw new Error('Invalid transaction CBOR: missing body');
  }
  return toHex(blake2b_256(tx.array[0].subCborRef.toBuffer()));
}

interface VkeyWitness { index: number; pubKey: Uint8Array; signature: Uint8Array }

/**
 * Read vkey witnesses (raw public key + signature bytes) from a transaction's witness set
 * (CBOR array index 1, map key 0). Conway wraps the witness array in CBOR tag 258 (set),
 * which is unwrapped here. `malformed` counts entries that are not a [vkey, signature] byte pair.
 */
function readVkeyWitnesses(txBytes: Uint8Array): { witnesses: VkeyWitness[]; malformed: number } {
  const tx = Cbor.parse(txBytes);
  if (!(tx instanceof CborArray) || !(tx.array[1] instanceof CborMap)) return { witnesses: [], malformed: 0 };
  const entry = tx.array[1].map.find(e => e.k instanceof CborUInt && Number((e.k as CborUInt).num) === 0);
  if (!entry) return { witnesses: [], malformed: 0 };
  let arr = entry.v;
  if (arr instanceof CborTag) arr = arr.data;
  if (!(arr instanceof CborArray)) return { witnesses: [], malformed: 0 };
  const witnesses: VkeyWitness[] = [];
  let malformed = 0;
  arr.array.forEach((pair, index) => {
    if (!(pair instanceof CborArray) || pair.array.length !== 2) { malformed++; return; }
    const [vk, sg] = pair.array;
    if (!(vk instanceof CborBytes) || !(sg instanceof CborBytes)) { malformed++; return; }
    witnesses.push({ index, pubKey: vk.bytes, signature: sg.bytes });
  });
  return { witnesses, malformed };
}

/** Well-formed vkey witnesses; [] when the tx has none. Malformed entries are skipped with a warning. */
function extractVkeyWitnesses(txBytes: Uint8Array): VkeyWitness[] {
  const { witnesses, malformed } = readVkeyWitnesses(txBytes);
  if (malformed > 0) {
    // not fatal, but a malformed witness in a signed tx is suspicious — surface it
    logger.warn(`Skipped ${malformed} malformed vkey witness entr${malformed === 1 ? 'y' : 'ies'} while verifying (expected [vkey, signature] byte pairs)`);
  }
  return witnesses;
}

/** Ed25519 check of one witness over the body hash; false for a key or signature of the wrong length. */
function signatureValid(w: VkeyWitness, bodyHashBytes: Uint8Array): boolean {
  try {
    return verifyEd25519Signature_sync(w.signature, bodyHashBytes, w.pubKey);
  } catch {
    return false;
  }
}

/**
 * Check every vkey witness of a signed tx against its body hash. Pure, needs no initialize().
 * A tx without vkey witnesses is valid here; which keys had to sign is the caller's check.
 */
export function verifyTxWitnesses(signedTxCbor: string): TxWitnessVerification {
  const errors: string[] = [];
  const signerKeyHashes: string[] = [];
  let txBodyHash: string | null = null;
  try {
    const txBytes = fromHex(signedTxCbor);
    txBodyHash = computeBodyHash(txBytes);
    const bodyHashBytes = fromHex(txBodyHash);
    const { witnesses, malformed } = readVkeyWitnesses(txBytes);
    if (malformed > 0) errors.push(`${malformed} vkey witness entr${malformed === 1 ? 'y is' : 'ies are'} not a [vkey, signature] byte pair`);
    for (const w of witnesses) {
      if (signatureValid(w, bodyHashBytes)) signerKeyHashes.push(toHex(blake2b_224(w.pubKey)));
      else errors.push(`Invalid signature at witness index ${w.index}`);
    }
  } catch (error: unknown) {
    errors.push(`Failed to read transaction: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { valid: errors.length === 0, txBodyHash, signerKeyHashes, errors };
}

/**
 * Verifies externally signed transactions without private keys: CBOR parse, body-hash
 * integrity against the build, required signers present, Ed25519 check per witness.
 */
export class SignatureVerifier {
  /** Verify a signed tx (hex CBOR); all failures are reported in the result, never thrown. */
  public verify(signedTxCbor: string, options: VerificationOptions = {}): SignatureVerificationResult {
    const result: SignatureVerificationResult = {
      isValid: false,
      txBodyHash: '',
      witnessCount: 0,
      signerKeyHashes: [],
      warnings: [],
    };

    try {
      // Body hash over the original body bytes — exactly what was signed.
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

        for (const w of vkeyWitnesses) {
          if (!signatureValid(w, bodyHashBytes)) {
            result.errorMessage = `Invalid signature at witness index ${w.index}. The signature does not match the transaction body.`;
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

  /** Like verify(), but throws TransactionValidationError on failure. */
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

  /** Body hash (hex) of an unsigned or signed tx CBOR; throws BackendError 400 on invalid CBOR. */
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

  /** True when the tx carries at least one vkey witness. */
  public isSigned(txCbor: string): boolean {
    try {
      return extractVkeyWitnesses(fromHex(txCbor)).length > 0;
    } catch {
      return false;
    }
  }

  /** Number of vkey witnesses in the tx (0 on invalid CBOR). */
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

/** Singleton SignatureVerifier. */
export function getSignatureVerifier(): SignatureVerifier {
  if (!verifierInstance) {
    verifierInstance = new SignatureVerifier();
  }
  return verifierInstance;
}
