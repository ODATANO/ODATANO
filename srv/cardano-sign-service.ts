import cds, { Request } from '@sap/cds';
import { handleRequest, passthroughRead } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address } from './utils/validators';
import { getCardanoIndexer, getCardanoClient } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoSignService');

/**
 * Check if a signing request has expired and update its status.
 * @returns true if expired, false otherwise
 */
async function checkAndExpireSigningRequest(
  db: any, signingRequest: any, SigningRequests: any
): Promise<boolean> {
  if (new Date(signingRequest.expiresAt) < new Date()) {
    await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequest.id }));
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
      SignatureVerifications,
      AddressSigningRequests,
      TransactionBuilds,
  } = require('#cds-models/CardanoSignService');

  /**
   * before-READ handler for SigningRequests: lazy expiration check
   * Updates status to 'expired' if expiresAt has passed (for pending requests)
   */
  srv.before('READ', SigningRequests, async (req: Request) => {
    // Expiration check runs on single-entity reads (where ID is provided)
    if (req.params && req.params.length > 0) {
      const { id } = req.params[0] as { id: string };
      if (id) {
        const db = await cds.connect.to('db');
        const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id }));
        if (signingRequest && signingRequest.status === 'pending') {
          await checkAndExpireSigningRequest(db, signingRequest, SigningRequests);
        }
      }
    }
  });

  // M3 passthrough READ handlers
  const m3ReadEntities = [SigningRequests, SignatureVerifications, AddressSigningRequests, TransactionBuilds];
  m3ReadEntities.forEach(entity => srv.on('READ', entity, passthroughRead()));

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
   * Verify signature of a signed transaction (bound action on SigningRequests)
   * @flow.status validates @from: [#pending] automatically (409 if wrong state)
   * @param req - CDS request with entity key in params, action data in data
   * @returns {SignatureVerification} Persisted signature verification entity
   */
  srv.on('VerifySignature', async (req: Request) => {
    logger.debug('VerifySignature Action handler called');
    const { id: signingRequestId } = req.params[0] as { id: string };
    const { signedTxCbor, signerType, signerInfo } = req.data;

    // Validate inputs (signingRequestId no longer needed — comes from URL)
    const errors = validateTransactionInputs(
      { signedTxCbor },
      ['signedTxCbor']
    );
    throwIfValidationErrors(req, 'VerifySignature', errors);

    return handleRequest(req, async (db) => {
      // Fetch the signing request (@from already validated by framework)
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'VerifySignature', 'Signing request not found', 'signingRequestId');

      // Check if expired (time-based, not covered by @flow.status)
      if (await checkAndExpireSigningRequest(db, signingRequest, SigningRequests)) {
        rejectInvalid(req, 'VerifySignature', 'Signing request has expired', 'signingRequestId');
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
   * Verify and submit a signed transaction in one step (bound action on SigningRequests)
   * @flow.status validates @from: [#pending, #verified] and sets @to: #submitted automatically
   * @param req - CDS request with entity key in params, action data in data
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitVerifiedTransaction', async (req: Request) => {
    logger.debug('SubmitVerifiedTransaction Action handler called');
    const { id: signingRequestId } = req.params[0] as { id: string };
    const { signedTxCbor, signerType, signerInfo } = req.data;

    // Validate inputs (signingRequestId no longer needed — comes from URL)
    const errors = validateTransactionInputs(
      { signedTxCbor },
      ['signedTxCbor']
    );
    throwIfValidationErrors(req, 'SubmitVerifiedTransaction', errors);

    return handleRequest(req, async (db) => {
      // Fetch the signing request (@from already validated by framework)
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request not found', 'signingRequestId');

      // Check if expired (time-based, not covered by @flow.status)
      if (await checkAndExpireSigningRequest(db, signingRequest, SigningRequests)) {
        rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
      }

      // STATUS CHECKS REMOVED — @flow.status handles @from: [#pending, #verified]
      // Previously: manual checks for 'submitted', 'expired', 'failed' states

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
};