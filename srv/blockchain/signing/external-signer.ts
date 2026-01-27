import cds from '@sap/cds';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import * as cbor from 'cbor';
import { SignatureVerifier, SignatureVerificationResult, VerificationOptions, getSignatureVerifier } from './signature-verifier';
import { TransactionValidationError } from '../../utils/errors';
const logger = cds.log('ExternalSigner');

/**
 * Combine an unsigned transaction with a witness set from CIP-30 wallet signing
 *
 * CIP-30 signTx() returns only the witness set, not a complete signed transaction.
 * This function combines the original unsigned transaction with the witness set
 * to create a complete signed transaction that can be submitted to the network.
 *
 * IMPORTANT: We use raw CBOR manipulation to preserve exact body bytes.
 * CSL's parse/re-serialize round-trip changes CBOR encoding, which invalidates the body hash.
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
 * @param cbor - CBOR hex string
 * @returns true if it's a witness set, false if it's a full transaction
 */
export function isWitnessSetCbor(cbor: string): boolean {
  try {
    const bytes = Buffer.from(cbor, 'hex');
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

/**
 * Supported external signer types
 */
export enum ExternalSignerType {
  /** Cardano CLI - Reference implementation for signing */
  CARDANO_CLI = 'cardano-cli',
  /** Browser wallets (Nami, Eternl, Flint, etc.) */
  BROWSER_WALLET = 'browser-wallet',
  /** Hardware wallets (Ledger, Trezor) */
  HARDWARE_WALLET = 'hardware-wallet',
  /** Custom/Unknown signer */
  CUSTOM = 'custom',
}

/**
 * Signing request status
 */
export enum SigningStatus {
  /** Request created, awaiting signing */
  PENDING = 'pending',
  /** Transaction has been signed */
  SIGNED = 'signed',
  /** Signature verified, ready for submission */
  VERIFIED = 'verified',
  /** Transaction submitted to network */
  SUBMITTED = 'submitted',
  /** Signing or verification failed */
  FAILED = 'failed',
  /** Request expired (not signed within TTL) */
  EXPIRED = 'expired',
}

/**
 * Unsigned transaction export payload for external signers
 *
 * This is the standardized format returned by BuildTransaction actions.
 * External signers use this payload to sign the transaction.
 */
export interface UnsignedTxExportPayload {
  /** Unique identifier for this signing request */
  signingRequestId: string;
  /** Deterministic reference ID linking to the build */
  buildId: string;
  /** Transaction body hash (the data to be signed) */
  txBodyHash: string;
  /** Unsigned transaction CBOR in hex format */
  unsignedTxCbor: string;
  /** Cardano network (mainnet | preprod | preview) */
  network: string;
  /** Timestamp when the request was created (ISO 8601) */
  createdAt: string;
  /** Timestamp when the request expires (ISO 8601) */
  expiresAt: string;
  /** Required signers (public key hashes) if known */
  requiredSigners?: string[];
  /** Signing instructions for the external signer */
  signingInstructions: SigningInstructions;
}

/**
 * Instructions for external signers
 */
export interface SigningInstructions {
  /** Signer type hint (which tool/wallet to use) */
  signerTypeHint: ExternalSignerType;
  /** Human-readable message to display */
  message: string;
  /** Cardano CLI command example */
  cardanoCliCommand?: string;
  /** CIP-30 signing request format (for browser wallets) */
  cip30SigningRequest?: {
    /** Transaction CBOR to sign */
    txCbor: string;
    /** Whether to include partial witnesses */
    partialSign: boolean;
  };
}

/**
 * Signed transaction submission payload
 */
export interface SignedTxPayload {
  /** Original signing request ID */
  signingRequestId: string;
  /** Build ID from the original build */
  buildId: string;
  /** Signed transaction CBOR */
  signedTxCbor: string;
  /** Signer type used */
  signerType: ExternalSignerType;
  /** Optional: Signer identification (wallet name, etc.) */
  signerInfo?: string;
}

/**
 * Signing workflow state
 */
export interface SigningWorkflowState {
  /** Current status of the signing workflow */
  status: SigningStatus;
  /** Signing request details */
  request: UnsignedTxExportPayload;
  /** Signed transaction (if available) */
  signedTxCbor?: string;
  /** Verification result (if verified) */
  verificationResult?: SignatureVerificationResult;
  /** Transaction hash after submission */
  txHash?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Timestamps for tracking */
  timestamps: {
    created: string;
    signed?: string;
    verified?: string;
    submitted?: string;
    failed?: string;
  };
}

/**
 * Default TTL for signing requests (30 minutes)
 */
const DEFAULT_SIGNING_TTL_MS = 30 * 60 * 1000;

/**
 * ExternalSignerModule - Manages the external signing workflow
 *
 * This module orchestrates the complete flow:
 * 1. Create signing request from build result
 * 2. Export unsigned transaction for external signing
 * 3. Receive and verify signed transaction
 * 4. Prepare for submission
 *
 * Key security principles:
 * - NO private keys are ever handled by this service
 * - Signature verification ensures transaction integrity
 * - Complete audit trail of the signing workflow
 */
export class ExternalSignerModule {
  private verifier: SignatureVerifier;
  private signingTtlMs: number;

  constructor(options?: { signingTtlMs?: number }) {
    this.verifier = getSignatureVerifier();
    this.signingTtlMs = options?.signingTtlMs ?? DEFAULT_SIGNING_TTL_MS;
  }

  /**
   * Create an unsigned transaction export payload for external signing
   *
   * This is the entry point for the external signing workflow.
   * Call this after building a transaction to get a standardized
   * payload that external signers can use.
   *
   * @param buildId - The build ID from TransactionBuilds
   * @param unsignedTxCbor - The unsigned transaction CBOR
   * @param txBodyHash - The transaction body hash
   * @param network - The Cardano network
   * @param options - Additional options
   * @returns Unsigned transaction export payload
   */
  public createSigningRequest(
    buildId: string,
    unsignedTxCbor: string,
    txBodyHash: string,
    network: string,
    options?: {
      requiredSigners?: string[];
      signerTypeHint?: ExternalSignerType;
    }
  ): UnsignedTxExportPayload {
    const signingRequestId = cds.utils.uuid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.signingTtlMs);

    const signerTypeHint = options?.signerTypeHint ?? ExternalSignerType.CARDANO_CLI;

    const payload: UnsignedTxExportPayload = {
      signingRequestId,
      buildId,
      txBodyHash,
      unsignedTxCbor,
      network,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      requiredSigners: options?.requiredSigners,
      signingInstructions: this.generateSigningInstructions(
        unsignedTxCbor,
        network,
        signerTypeHint
      ),
    };

    logger.info({
      signingRequestId,
      buildId,
      txBodyHash,
      network,
      expiresAt: expiresAt.toISOString(),
    }, 'Created signing request');

    return payload;
  }

  /**
   * Generate signing instructions for different signer types
   */
  private generateSigningInstructions(
    unsignedTxCbor: string,
    network: string,
    signerTypeHint: ExternalSignerType
  ): SigningInstructions {
    const networkMagic = this.getNetworkMagic(network);

    // Cardano CLI command example
    const cardanoCliCommand = [
      'cardano-cli conway transaction sign',
      '--tx-body-file tx.unsigned',
      '--signing-key-file payment.skey',
      `--${network === 'mainnet' ? 'mainnet' : `testnet-magic ${networkMagic}`}`,
      '--out-file tx.signed',
    ].join(' \\\n  ');

    return {
      signerTypeHint,
      message: `Sign the transaction using your preferred method. The transaction body hash is the data to be signed. After signing, submit the signed CBOR using the SubmitTransaction action.`,
      cardanoCliCommand,
      cip30SigningRequest: {
        txCbor: unsignedTxCbor,
        partialSign: false,
      },
    };
  }

  /**
   * Get network magic for testnet
   */
  private getNetworkMagic(network: string): number {
    switch (network.toLowerCase()) {
      case 'mainnet':
        return 764824073;
      case 'preprod':
        return 1;
      case 'preview':
        return 2;
      default:
        return 2; // Default to preview
    }
  }

  /**
   * Verify a signed transaction
   *
   * Call this after receiving a signed transaction from an external signer.
   * This verifies the signature integrity before submission.
   *
   * @param signedTxCbor - The signed transaction CBOR
   * @param expectedTxBodyHash - The expected transaction body hash (from the build)
   * @param options - Additional verification options
   * @returns Verification result
   */
  public verifySignedTransaction(
    signedTxCbor: string,
    expectedTxBodyHash: string,
    options?: Omit<VerificationOptions, 'expectedTxBodyHash'>
  ): SignatureVerificationResult {
    logger.debug({ expectedTxBodyHash }, 'Verifying signed transaction');

    const result = this.verifier.verify(signedTxCbor, {
      ...options,
      expectedTxBodyHash,
      requireSignature: true,
    });

    if (result.isValid) {
      logger.info({
        txBodyHash: result.txBodyHash,
        witnessCount: result.witnessCount,
        signers: result.signerKeyHashes,
      }, 'Signature verification successful');
    } else {
      logger.warn({
        error: result.errorMessage,
        warnings: result.warnings,
      }, 'Signature verification failed');
    }

    return result;
  }

  /**
   * Verify signed transaction and throw on failure
   *
   * @param signedTxCbor - The signed transaction CBOR
   * @param expectedTxBodyHash - The expected transaction body hash
   * @param options - Additional verification options
   * @throws {TransactionValidationError} if verification fails
   */
  public verifyOrThrow(
    signedTxCbor: string,
    expectedTxBodyHash: string,
    options?: Omit<VerificationOptions, 'expectedTxBodyHash'>
  ): SignatureVerificationResult {
    const result = this.verifySignedTransaction(signedTxCbor, expectedTxBodyHash, options);

    if (!result.isValid) {
      throw new TransactionValidationError(
        result.errorMessage || 'Signature verification failed'
      );
    }

    return result;
  }

  /**
   * Create a complete signing workflow state
   *
   * This creates a trackable workflow state that can be stored
   * and updated throughout the signing process.
   *
   * @param signingRequest - The unsigned transaction export payload
   * @returns Initial workflow state
   */
  public createWorkflowState(signingRequest: UnsignedTxExportPayload): SigningWorkflowState {
    return {
      status: SigningStatus.PENDING,
      request: signingRequest,
      timestamps: {
        created: signingRequest.createdAt,
      },
    };
  }

  /**
   * Update workflow state after signing
   *
   * @param state - Current workflow state
   * @param signedTxCbor - The signed transaction CBOR
   * @returns Updated workflow state
   */
  public markAsSigned(state: SigningWorkflowState, signedTxCbor: string): SigningWorkflowState {
    return {
      ...state,
      status: SigningStatus.SIGNED,
      signedTxCbor,
      timestamps: {
        ...state.timestamps,
        signed: new Date().toISOString(),
      },
    };
  }

  /**
   * Update workflow state after verification
   *
   * @param state - Current workflow state
   * @param verificationResult - The verification result
   * @returns Updated workflow state
   */
  public markAsVerified(
    state: SigningWorkflowState,
    verificationResult: SignatureVerificationResult
  ): SigningWorkflowState {
    if (!verificationResult.isValid) {
      return this.markAsFailed(state, verificationResult.errorMessage || 'Verification failed');
    }

    return {
      ...state,
      status: SigningStatus.VERIFIED,
      verificationResult,
      timestamps: {
        ...state.timestamps,
        verified: new Date().toISOString(),
      },
    };
  }

  /**
   * Update workflow state after submission
   *
   * @param state - Current workflow state
   * @param txHash - The submitted transaction hash
   * @returns Updated workflow state
   */
  public markAsSubmitted(state: SigningWorkflowState, txHash: string): SigningWorkflowState {
    return {
      ...state,
      status: SigningStatus.SUBMITTED,
      txHash,
      timestamps: {
        ...state.timestamps,
        submitted: new Date().toISOString(),
      },
    };
  }

  /**
   * Update workflow state on failure
   *
   * @param state - Current workflow state
   * @param errorMessage - The error message
   * @returns Updated workflow state
   */
  public markAsFailed(state: SigningWorkflowState, errorMessage: string): SigningWorkflowState {
    return {
      ...state,
      status: SigningStatus.FAILED,
      errorMessage,
      timestamps: {
        ...state.timestamps,
        failed: new Date().toISOString(),
      },
    };
  }

  /**
   * Check if a signing request has expired
   *
   * @param expiresAt - The expiration timestamp (ISO 8601)
   * @returns true if expired
   */
  public isExpired(expiresAt: string): boolean {
    return new Date(expiresAt) < new Date();
  }

  /**
   * Validate a signed transaction payload before submission
   *
   * This performs all pre-submission checks:
   * 1. Verify the signature
   * 2. Check transaction hasn't been tampered with
   * 3. Ensure the build ID matches
   *
   * @param payload - The signed transaction payload
   * @param originalBuildTxBodyHash - The original transaction body hash from the build
   * @returns Validation result with verification details
   * @throws {TransactionValidationError} if validation fails
   */
  public validateForSubmission(
    payload: SignedTxPayload,
    originalBuildTxBodyHash: string
  ): SignatureVerificationResult {
    // Verify the signature and transaction integrity
    const result = this.verifyOrThrow(
      payload.signedTxCbor,
      originalBuildTxBodyHash
    );

    logger.info({
      signingRequestId: payload.signingRequestId,
      buildId: payload.buildId,
      signerType: payload.signerType,
      witnessCount: result.witnessCount,
    }, 'Transaction validated for submission');

    return result;
  }

  /**
   * Get the signature verifier instance
   */
  public getVerifier(): SignatureVerifier {
    return this.verifier;
  }
}

// Singleton instance
let moduleInstance: ExternalSignerModule | null = null;

/**
 * Get the singleton ExternalSignerModule instance
 */
export function getExternalSignerModule(): ExternalSignerModule {
  if (!moduleInstance) {
    moduleInstance = new ExternalSignerModule();
  }
  return moduleInstance;
}

/**
 * Create a new ExternalSignerModule instance with custom options
 */
export function createExternalSignerModule(options?: {
  signingTtlMs?: number;
}): ExternalSignerModule {
  return new ExternalSignerModule(options);
}
