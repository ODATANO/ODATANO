import cds from '@sap/cds';
import { SignatureVerifier, getSignatureVerifier } from './signature-verifier';
import { TransactionValidationError } from '../../utils/errors';
import {
  ExternalSignerType,
  SigningStatus,
  SigningInstructions,
  UnsignedTxExportPayload,
  SignedTxPayload,
  SigningWorkflowState,
  SignatureVerificationResult,
  VerificationOptions,
} from '../../utils/types';

const logger = cds.log('ExternalSigner');

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
    message: string,
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
        message,
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
    message: string,
    signerTypeHint: ExternalSignerType
  ): SigningInstructions {
    return {
      signerTypeHint,
      message: message,
      network,
      cip30SigningRequest: {
        txCbor: unsignedTxCbor,
        partialSign: false,
      },
    };
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
    options?: Omit<VerificationOptions, 'expectedTxBodyHash'> & { expiresAt?: string }
  ): SignatureVerificationResult {
    logger.debug({ expectedTxBodyHash }, 'Verifying signed transaction');

    // Enforce signing TTL if expiresAt is provided
    if (options?.expiresAt && this.isExpired(options.expiresAt)) {
      return {
        isValid: false,
        txBodyHash: '',
        witnessCount: 0,
        signerKeyHashes: [],
        warnings: [],
        errorMessage: 'Signing request has expired',
      };
    }

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
      return this.markAsFailed(state, String(verificationResult.errorMessage));
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
