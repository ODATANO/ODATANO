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

/** Default TTL for signing requests (30 minutes). */
const DEFAULT_SIGNING_TTL_MS = 30 * 60 * 1000;

/** Network flag for cardano-cli (mainnet vs testnet-magic). */
const CLI_NETWORK_FLAG: Record<string, string> = {
  mainnet: '--mainnet',
  preprod: '--testnet-magic 1',
  preview: '--testnet-magic 2',
};

/**
 * Copy-pasteable cardano-cli signing recipe for the unsigned tx (network flag and CBOR
 * filled in; the caller supplies the signing key file).
 */
function buildCardanoCliCommand(network: string, unsignedTxCbor: string): string {
  const netFlag = CLI_NETWORK_FLAG[network] ?? '--testnet-magic <MAGIC>';
  return [
    '# 1) Save the unsigned transaction to a file:',
    `echo '{"type":"Unwitnessed Tx ConwayEra","description":"","cborHex":"${unsignedTxCbor}"}' > tx.unsigned`,
    '# 2) Sign it with your payment key:',
    `cardano-cli conway transaction sign --tx-file tx.unsigned --signing-key-file payment.skey ${netFlag} --out-file tx.signed`,
    '# 3) Submit the cborHex from tx.signed via SubmitSignedTransaction / SubmitVerifiedTransaction',
  ].join('\n');
}

/**
 * External signing workflow: create signing request → export unsigned tx → verify the
 * signed tx → prepare submission. No private keys are ever handled here.
 */
export class ExternalSignerModule {
  private verifier: SignatureVerifier;
  private signingTtlMs: number;

  constructor(options?: { signingTtlMs?: number }) {
    this.verifier = getSignatureVerifier();
    this.signingTtlMs = options?.signingTtlMs ?? DEFAULT_SIGNING_TTL_MS;
  }

  /** Create the unsigned-tx export payload that starts a signing request (workflow entry point). */
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

  /** Signing instructions for the different signer types (CIP-30 request + cardano-cli recipe). */
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
      cardanoCliCommand: buildCardanoCliCommand(network, unsignedTxCbor),
    };
  }

  /** Verify a signed tx against the build's body hash; enforces the signing TTL when `expiresAt` is given. */
  public verifySignedTransaction(
    signedTxCbor: string,
    expectedTxBodyHash: string,
    options?: Omit<VerificationOptions, 'expectedTxBodyHash'> & { expiresAt?: string }
  ): SignatureVerificationResult {
    logger.debug({ expectedTxBodyHash }, 'Verifying signed transaction');

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

  /** Like verifySignedTransaction, but throws TransactionValidationError on failure. */
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

  /** Initial (pending) workflow state for a signing request. */
  public createWorkflowState(signingRequest: UnsignedTxExportPayload): SigningWorkflowState {
    return {
      status: SigningStatus.PENDING,
      request: signingRequest,
      timestamps: {
        created: signingRequest.createdAt,
      },
    };
  }

  /** Workflow state → signed. */
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

  /** Workflow state → verified, or → failed when the verification result is invalid. */
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

  /** Workflow state → submitted. */
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

  /** Workflow state → failed. */
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

  /** True when the ISO-8601 `expiresAt` lies in the past. */
  public isExpired(expiresAt: string): boolean {
    return new Date(expiresAt) < new Date();
  }

  /** Pre-submission check: signature + body-hash integrity against the build; throws TransactionValidationError. */
  public validateForSubmission(
    payload: SignedTxPayload,
    originalBuildTxBodyHash: string
  ): SignatureVerificationResult {
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

  /** The underlying signature verifier. */
  public getVerifier(): SignatureVerifier {
    return this.verifier;
  }
}

// Singleton instance
let moduleInstance: ExternalSignerModule | null = null;

/** Singleton ExternalSignerModule. */
export function getExternalSignerModule(): ExternalSignerModule {
  if (!moduleInstance) {
    moduleInstance = new ExternalSignerModule();
  }
  return moduleInstance;
}

/** New ExternalSignerModule with custom options (not the singleton). */
export function createExternalSignerModule(options?: {
  signingTtlMs?: number;
}): ExternalSignerModule {
  return new ExternalSignerModule(options);
}
