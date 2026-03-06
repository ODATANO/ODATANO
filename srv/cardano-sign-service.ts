import cds, { Request } from '@sap/cds';
import { handleRequest} from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address } from './utils/validators';
import { getCardanoIndexer, getCardanoClient } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { getHsmSigner } from './blockchain/signing/hsm-signer';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoSignService');

/**
 * Verify that a build's senderAddress matches the caller-provided address.
 * Defense-in-depth: when address is provided, reject if it doesn't match the build owner.
 */
async function verifyBuildOwnership(
  req: Request, db: any, buildId: string, address: string | undefined, TransactionBuilds: any, actionName: string
): Promise<any> {
  const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
  if (!build) rejectInvalid(req, actionName, 'Build not found', 'buildId');
  if (address && build.senderAddress !== address) {
    rejectInvalid(req, actionName, 'Address does not match build owner', 'address');
  }
  return build;
}

/**
 * Check if a signing request has expired and update its status.
 * @returns true if expired, false otherwise
 */
async function checkAndExpireSigningRequest(
  db: any, signingRequest: any, SigningRequests: any
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.run(
    UPDATE.entity(SigningRequests)
      .set({ status: 'expired' })
      .where({ id: signingRequest.id, expiresAt: { '<=': now } })
  );
  if (result > 0) {
    signingRequest.status = 'expired';
    return true;
  }
  return false;
}

/**
 * Cardano Sign Service Implementation
 * Handles transaction signing operations & some additional data queries.
 */
module.exports = (srv: cds.Service) => {
  logger.info('Module loaded - registering handlers');

  const {
    SigningRequests,
      AddressSigningRequests,
      TransactionBuilds,
  } = require('#cds-models/CardanoSignService');

  /**
   * before-READ handler for SigningRequests: bulk expiration check
   * Atomically expires all pending requests past their TTL (handles both single and collection reads)
   * Throttled to run at most once per 60 seconds to avoid write amplification on every READ.
   */
  let lastExpiryCheck = 0;
  const EXPIRY_CHECK_INTERVAL_MS = 60_000;

  srv.before('READ', SigningRequests, async () => {
    const now = Date.now();
    if (now - lastExpiryCheck < EXPIRY_CHECK_INTERVAL_MS) return;
    lastExpiryCheck = now;

    const db = await cds.connect.to('db');
    await db.run(
      UPDATE.entity(SigningRequests)
        .set({ status: 'expired' })
        .where({ status: 'pending', expiresAt: { '<=': new Date().toISOString() } })
    );
  });


  /**
   * Create a new signing request for external signing
   * Persists the request for audit trail and workflow tracking
   * @param req - CDS request object (with buildId)
   * @returns {SigningRequest} Signing request entity
   */
  srv.on('CreateSigningRequest', async (req: Request) => {
    logger.debug('CreateSigningRequest Action handler called');
    const { buildId , message } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'CreateSigningRequest', errors);

    return handleRequest(req, async (db) => {
      // Fetch the build
      const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!build) rejectInvalid(req, 'CreateSigningRequest', 'Build not found', 'buildId');

      // Check if signing request already exists for this build
      const existingRequest = await db.run(
        SELECT.one.from(SigningRequests).where({ build_id: buildId, status: 'pending' })
      );
      if (existingRequest) {
        logger.info({ buildId, signingRequestId: existingRequest.id }, 'Returning existing signing request');
        return existingRequest;
      }

      // Create signing request using external signer module
      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id,
        build.unsignedTxCbor,
        build.txBodyHash,
        build.network, 
        message
      );

      // Delegate persistence to indexer
      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      logger.info({ buildId, signingRequestId: signingRequestRecord.id }, 'Created signing request');

      return signingRequestRecord;
    });
  });

  /**
   * Get an existing signing request by ID
   * @param req - CDS request object (with signingRequestId)
   * @returns {SigningRequest} signing request entity
   */
  srv.on('GetSigningRequest', async (req: Request) => {
    logger.debug('GetSigningRequest Action handler called');
    const { signingRequestId } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs({ signingRequestId }, ['signingRequestId']);
    throwIfValidationErrors(req, 'GetSigningRequest', errors);

    // Fetch the signing request within transaction context
    return handleRequest(req, async (db) => {
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'GetSigningRequest', 'Signing request not found', 'signingRequestId');

      // Check if expired and update status if needed
      if (signingRequest.status === 'pending') {
        await checkAndExpireSigningRequest(db, signingRequest, SigningRequests);
      }

      return signingRequest;
    });
  });

  /**
   * Verify signature of a signed transaction (unbound action)
   * @param req - CDS request with signingRequestId + signedTxCbor in data
   * @returns {SignatureVerification} Persisted signature verification entity
   */
  srv.on('VerifySignature', async (req: Request) => {
    logger.debug('VerifySignature Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo, address } = req.data;

    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'VerifySignature', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'VerifySignature', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      // Fetch the signing request (@from already validated by framework)
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'VerifySignature', 'Signing request not found', 'signingRequestId');

      // Ownership check: verify address matches build owner (defense-in-depth)
      if (address && signingRequest.build_id) {
        await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'VerifySignature');
      }

      // Check if expired
      if (await checkAndExpireSigningRequest(db, signingRequest, SigningRequests)) {
        rejectInvalid(req, 'VerifySignature', 'Signing request has expired', 'signingRequestId');
      }

      // Status check: only pending requests can be verified
      if (signingRequest.status !== 'pending') {
        rejectInvalid(req, 'VerifySignature', `Signing request status is '${signingRequest.status}', expected 'pending'`, 'signingRequestId');
      }

      // Detect if signedTxCbor is a witness set (CIP-30) or a full signed transaction (cardano-cli)
      let fullSignedTxCbor: string;
      if (isWitnessSetCbor(signedTxCbor)) {
        // CIP-30 wallet returns only witness set — combine with unsigned tx
        fullSignedTxCbor = combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor);
        logger.debug({ signingRequestId }, 'Combined witness set with unsigned transaction for verification');
      } else {
        // Full signed transaction provided (e.g., from cardano-cli)
        fullSignedTxCbor = signedTxCbor;
      }

      // Verify the signature
      const signerModule = getExternalSignerModule();
      const result = signerModule.verifySignedTransaction(fullSignedTxCbor, signingRequest.txBodyHash);

      // Delegate persistence to indexer (store full signed tx for later submission)
      const verificationRecord = await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId,
        signedTxCbor: fullSignedTxCbor,
        verificationResult: result,
        signerType,
        signerInfo,
      });

      logger.info({
        signingRequestId,
        verificationId: verificationRecord.id,
        isValid: result.isValid,
        witnessCount: result.witnessCount,
      }, 'Signature verification completed');

      return verificationRecord;
    });
  });

  /**
   * Verify and submit a signed transaction in one step (unbound action)
   * @param req - CDS request with signingRequestId + signedTxCbor in data
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitVerifiedTransaction', async (req: Request) => {
    logger.debug('SubmitVerifiedTransaction Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo, address } = req.data;

    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'SubmitVerifiedTransaction', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request not found', 'signingRequestId');

      // Ownership check: verify address matches build owner (defense-in-depth)
      if (address && signingRequest.build_id) {
        await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'SubmitVerifiedTransaction');
      }

      // Check if expired
      if (await checkAndExpireSigningRequest(db, signingRequest, SigningRequests)) {
        rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
      }

      // Status check: only pending or verified requests can be submitted
      if (signingRequest.status !== 'pending' && signingRequest.status !== 'verified') {
        rejectInvalid(req, 'SubmitVerifiedTransaction', `Signing request status is '${signingRequest.status}', expected 'pending' or 'verified'`, 'signingRequestId');
      }

      // Check if build association exists
      if (!signingRequest.build_id) {
        rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has no associated build', 'signingRequestId');
      }

      // Detect if signedTxCbor is a witness set (CIP-30) or a full signed transaction (cardano-cli)
      let fullSignedTxCbor: string;
      if (isWitnessSetCbor(signedTxCbor)) {
        // CIP-30 wallet returns only witness set - combine with unsigned tx
        fullSignedTxCbor = combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor);
        logger.debug({ signingRequestId }, 'Combined witness set with unsigned transaction');
      } else {
        // Full signed transaction provided (e.g., from cardano-cli)
        fullSignedTxCbor = signedTxCbor;
        logger.debug({ signingRequestId }, 'Using full signed transaction directly');
      }

      // Verify signature (throws on failure)
      const signerModule = getExternalSignerModule();
      const verificationResult = signerModule.verifyOrThrow(fullSignedTxCbor, signingRequest.txBodyHash);

      logger.info({
        signingRequestId,
        witnessCount: verificationResult.witnessCount,
        signers: verificationResult.signerKeyHashes,
      }, 'Signature verified, proceeding with submission');

      // Submit to blockchain
      const txHash = signingRequest.txBodyHash;
      await getCardanoClient().submitTransaction(fullSignedTxCbor);
      logger.info({ txHash }, 'Verified transaction submitted to blockchain');

      // Delegate all persistence to indexer
      const submissionRecord = await getCardanoIndexer().indexVerifiedTransactionSubmission(db, {
        signingRequestId,
        buildId: signingRequest.build_id,
        fullSignedTxCbor,
        txHash,
        verificationResult,
        signerType,
        signerInfo,
      });

      logger.info({
        signingRequestId,
        submissionId: submissionRecord.id,
        txHash,
      }, 'Transaction submitted and all records updated');

      return submissionRecord;
    });
  });

  /**
   * Get all existing signing requests by address
   * @param req - CDS request object (with address)
   * @returns {AddressSigningRequests} Address signing request associations
   */
  srv.on('GetSigningRequestsByAddress', async (req: Request) => {
    logger.debug('GetSigningRequestsByAddress Action handler called');
    const { address } = req.data;
    // Validate input before business logic
    if (!address) rejectMissing(req, 'GetSigningRequestsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetSigningRequestsByAddress', 'Invalid bech32 address format', 'address');
    // Fetch the address-signing request associations
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressSigningRequests).where({ address_address: address }));
    });
  });

  // ---------------------------------------------------------------------------
  // HSM (Hardware Security Module) Signing Actions
  // ---------------------------------------------------------------------------

  /**
   * Sign a transaction using the configured HSM.
   * Creates signing request, signs with HSM, verifies the signature.
   * @param req - CDS request object (with buildId)
   * @returns {SigningRequest} Signing request with status 'verified'
   */
  srv.on('SignWithHsm', async (req: Request) => {
    logger.debug('SignWithHsm Action handler called');
    const { buildId, address } = req.data;

    // Validate input
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignWithHsm', 'Invalid bech32 address format', 'address');

    // Check HSM is available (before handleRequest — same pattern as validation)
    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    return handleRequest(req, async (db) => {
      // 1. Fetch the build (with ownership check)
      const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignWithHsm');

      // 2. Create signing request internally (reuse external signer module)
      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing'
      );

      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      // 3. Sign with HSM
      const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

      // 4. Verify the HSM signature (same verification path as external signing)
      const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);

      const hsmStatus = hsmSigner!.getStatus();
      const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

      // 5. Persist verification
      await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId: signingRequestRecord.id,
        signedTxCbor,
        verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${hsmKeyIdentifier}`,
      });

      // 6. Update HSM audit field
      await db.run(
        UPDATE.entity(SigningRequests)
          .set({ hsmKeyId: hsmKeyIdentifier })
          .where({ id: signingRequestRecord.id })
      );

      logger.info({
        buildId,
        signingRequestId: signingRequestRecord.id,
        isValid: verificationResult.isValid,
        hsmKey: hsmKeyIdentifier,
      }, 'Transaction signed with HSM');

      // Return updated signing request
      return db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestRecord.id }));
    });
  });

  /**
   * Sign a transaction with HSM and submit to blockchain atomically.
   * Creates signing request, signs, verifies, and submits in one operation.
   * @param req - CDS request object (with buildId)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SignAndSubmitWithHsm', async (req: Request) => {
    logger.debug('SignAndSubmitWithHsm Action handler called');
    const { buildId, address } = req.data;

    // Validate input
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignAndSubmitWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignAndSubmitWithHsm', 'Invalid bech32 address format', 'address');

    // Check HSM is available
    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignAndSubmitWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    return handleRequest(req, async (db) => {
      // 1. Fetch the build (with ownership check)
      const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignAndSubmitWithHsm');

      // 2. Create signing request
      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing + submit'
      );

      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      // 3. Sign with HSM
      const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

      // 4. Verify HSM signature (non-throwing — HSM is server-side trusted)
      const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);

      const hsmStatus = hsmSigner!.getStatus();
      const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

      logger.info({
        signingRequestId: signingRequestRecord.id,
        witnessCount: verificationResult.witnessCount,
        hsmKey: hsmKeyIdentifier,
      }, 'HSM signature verified, proceeding with submission');

      // 5. Submit to blockchain
      const txHash = build.txBodyHash;
      await getCardanoClient().submitTransaction(signedTxCbor);
      logger.info({ txHash }, 'HSM-signed transaction submitted to blockchain');

      // 6. Persist everything atomically via indexer
      const submissionRecord = await getCardanoIndexer().indexVerifiedTransactionSubmission(db, {
        signingRequestId: signingRequestRecord.id,
        buildId,
        fullSignedTxCbor: signedTxCbor,
        txHash,
        verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${hsmKeyIdentifier}`,
      });

      // 7. HSM audit field
      await db.run(
        UPDATE.entity(SigningRequests)
          .set({ hsmKeyId: hsmKeyIdentifier })
          .where({ id: signingRequestRecord.id })
      );

      logger.info({
        signingRequestId: signingRequestRecord.id,
        submissionId: submissionRecord.id,
        txHash,
      }, 'HSM-signed transaction submitted and all records updated');

      return submissionRecord;
    });
  });

  /**
   * Get HSM connection status and key information.
   * Returns null fields if HSM is not configured.
   */
  srv.on('GetHsmStatus', async (_req: Request) => {
    const hsmSigner = getHsmSigner();
    if (!hsmSigner) {
      return {
        connected: false,
        keyId: null,
        keyLabel: null,
        publicKeyHash: null,
        cardanoAddress: null,
      };
    }
    const status = hsmSigner.getStatus();
    return {
      connected: status.connected,
      keyId: status.keyId || null,
      keyLabel: status.keyLabel || null,
      publicKeyHash: status.publicKeyHash || null,
      cardanoAddress: status.address || null,
    };
  });
};