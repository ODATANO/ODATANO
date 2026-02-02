import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address } from './utils/validators';
import { getTxHashFromCbor } from './utils/tx-build-helper';
import { getCardanoIndexer, getCardanoClient } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoTxService');

/**
 * Cardano Transaction Service Implementation
 * Handles transaction building and submission operations & some additional data queries.
 */
module.exports = (srv: cds.Service) => {
  logger.info('[CardanoTxService] Module loaded - registering handlers');

  const {
    TransactionBuilds,
    TransactionBuildInputs,
    TransactionBuildOutputs,
    TransactionSubmissions,
    TransactionSubmissionErrors,
    SigningRequests,
    SignatureVerifications,
    AddressSigningRequests,
    AddressTransactionBuilds
  } = require('#cds-models/CardanoTransactionService');

  /**
   * READ handler for TransactionBuilds entity
   * @param req - The incoming request data
   * @returns {TransactionBuilds} The transaction builds fitting the request query
   */
  srv.on('READ', TransactionBuilds, async (req: Request) => {
    logger.debug('TransactionBuilds READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /** 
   * READ handler for TransactionBuildInputs entity
   * @param req - The incoming request data
   * @returns {TransactionBuildInputs} The transaction build inputs fitting the request query
   */
  srv.on('READ', TransactionBuildInputs, async (req: Request) => {
    logger.debug('TransactionBuildInputs READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /** 
   * READ handler for TransactionBuildOutputs entity
   * @param req - The incoming request data
   * @returns {TransactionBuildOutputs} The transaction build outputs fitting the request query
   */
  srv.on('READ', TransactionBuildOutputs, async (req: Request) => {
    logger.debug('TransactionBuildOutputs READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });
  /** 
   * READ handler for TransactionSubmissions entity
   * @param req - The incoming request data
   * @returns {TransactionSubmissions} The transaction submissions fitting the request query
   */
  srv.on('READ', TransactionSubmissions, async (req: Request) => {
    logger.debug('TransactionSubmissions READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /** 
   * READ handler for TransactionSubmissionErrors entity
   * @param req - The incoming request data
   * @returns {TransactionSubmissionErrors} The transaction submission errors fitting the request query
   */
  srv.on('READ', TransactionSubmissionErrors, async (req: Request) => {
    logger.debug('TransactionSubmissionErrors READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * Build a simple ADA-only transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount } = req.data;

    // validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount']
    );
    throwIfValidationErrors(req, 'BuildSimpleAdaTransaction', errors);

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info({ senderAddress, recipientAddress, lovelaceAmount }, 'Building simple ADA transaction');
      return await getCardanoIndexer().indexSimpleBuildResult(db, req.data);
    });
  });
  /**
   * Build a transaction with metadata
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, metadataJson, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildTransactionWithMetadata', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, metadataJson } = req.data;

    // validate inputs (includes JSON parsing validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, metadataJson },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
    );
    throwIfValidationErrors(req, 'BuildTransactionWithMetadata', errors);

    // Parse metadataJson (already validated as valid JSON)
    const parsedMetadata = JSON.parse(metadataJson);

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info(
        { senderAddress, recipientAddress, lovelaceAmount, metadataJson: parsedMetadata },
        'Building transaction with metadata'
      );
      return await getCardanoIndexer().indexMetadataBuildResult(db, { ...req.data, metadataJson: parsedMetadata });
    });
  });

  /**
   * Build a multi-asset transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, assetsJson, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildMultiAssetTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, assetsJson } = req.data;

    // validate inputs (includes JSON parsing validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, assetsJson },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']
    );
    throwIfValidationErrors(req, 'BuildMultiAssetTransaction', errors);

    // Parse assetsJson (already validated as valid JSON)
    const parsedAssets = JSON.parse(assetsJson);

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info(
        { senderAddress, recipientAddress, lovelaceAmount, assets: parsedAssets },
        'Building multi-asset transaction'
      );
      // Create clean request object with parsed assets (remove assetsJson, add assets)
      const cleanData = { ...req.data };
      delete cleanData.assetsJson;

      const result = await getCardanoIndexer().indexMultiAssetBuildResult(db, { ...cleanData, assets: parsedAssets });
      logger.info({ result }, 'Multi-asset transaction build result');
      return result;
    });
  });

  /**
   * Build a minting transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildMintTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript } = req.data;

    // validate inputs (includes JSON and CBOR validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, mintActionsJson, mintingPolicyScript },
      ['senderAddress', 'recipientAddress', 'mintActionsJson', 'mintingPolicyScript']
    );
    throwIfValidationErrors(req, 'BuildMintTransaction', errors);

    // Parse mintActionsJson and convert quantity strings to bigint
    const parsedMintActions = JSON.parse(mintActionsJson).map((action: { assetName: string; quantity: string }) => ({
      ...action,
      quantity: BigInt(action.quantity)
    }));

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info(
        { senderAddress, recipientAddress, lovelaceAmount, mintActions: parsedMintActions },
        'Building minting transaction'
      );
      // Create clean request object with parsed mintActions (remove mintActionsJson, add mintActions)
      const cleanData = { ...req.data };
      delete cleanData.mintActionsJson;

      return await getCardanoIndexer().indexMintBuildResult(db, {
        ...cleanData,
        mintActions: parsedMintActions,
        mintingPolicyScript
      });
    });
  });

  /**
   * Get build details for previously built transaction
   * @param req - CDS request object (with buildId)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('GetBuildDetails', async (req: Request) => {
    const { buildId } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'GetBuildDetails', errors);

    // handle the request / fetching the build details
    const existing = await cds.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));

    if (!existing) rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');

    return existing;
  });

  /**
   * Submit signed transaction built previously
   * Handler validates, checks build exists, submits to blockchain, delegates persistence to indexer
   * @param req - CDS request object (with buildId, signedTxCbor)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitTransaction', async (req: Request) => {
    logger.debug('SubmitTransaction Action handler called');
    const { buildId, signedTxCbor } = req.data;

    // Validate inputs (includes CBOR format validation)
    const errors = validateTransactionInputs({ buildId, signedTxCbor }, ['buildId', 'signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitTransaction', errors);

    return handleRequest(req, async (db) => {
      logger.debug({ buildId }, 'Submitting signed transaction');

      // Validate build exists
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) rejectInvalid(req, 'SubmitTransaction', 'Build not found', 'buildId');

      // Use txBodyHash from build
      const txHash = existing.txBodyHash;

      // Submit to blockchain
      await getCardanoClient().submitTransaction(signedTxCbor);
      logger.info({ txHash }, 'Transaction submitted to blockchain');

      // Delegate persistence to indexer
      const submissionRecord = await getCardanoIndexer().persistTransactionSubmission(db, {
        signedTxCbor,
        txHash,
        buildId,
      });

      return submissionRecord;
    });
  });

  /**
   * Submit signed transaction without prior build
   * Handler validates, submits to blockchain, delegates persistence to indexer
   * @param req - CDS request object (with signedTxCbor, network)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    logger.info('SubmitSignedTransaction Action handler called');
    const { signedTxCbor } = req.data;

    // Validate inputs (includes CBOR format validation)
    const errors = validateTransactionInputs({ signedTxCbor }, ['signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitSignedTransaction', errors);

    return handleRequest(req, async (db) => {
      // Extract txHash from signed CBOR
      const txHash = getTxHashFromCbor(signedTxCbor);

      // Submit to blockchain
      await getCardanoClient().submitTransaction(signedTxCbor);
      logger.info({ txHash }, 'External transaction submitted');

      // Delegate persistence to indexer (no build association)
      const submissionRecord = await getCardanoIndexer().persistTransactionSubmission(db, {
        signedTxCbor,
        txHash,
        buildId: null,
      });

      return submissionRecord;
    });
  });

  /**
   * Check submission status
   * @param req - The incoming request data
   * @returns {TransactionSubmission} The transaction submission status
   */
  srv.on('CheckSubmissionStatus', async (req: Request) => {
    logger.debug('CheckSubmissionStatus Action handler called');
    const { submissionId } = req.data;

    // validate inputs
    const errors = validateTransactionInputs({ submissionId }, ['submissionId']);
    throwIfValidationErrors(req, 'CheckSubmissionStatus', errors);

    // handle the request / checking submission status
    return handleRequest(req, async (db) => {
      const submission = await db.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId }));

      if (!submission) rejectInvalid(req, 'CheckSubmissionStatus', 'Submission not found', 'submissionId');

      return submission;
    });
  });

  // ---------------------------------------------------------------------------
  // M3 - External Signing Workflow Actions
  // ---------------------------------------------------------------------------

  /**
   * READ handler for SigningRequests entity
   * @param req - The incoming request data
   * @returns {SigningRequest} The signing requests fitting the request query 
   */
  srv.on('READ', SigningRequests, async (req: Request) => {
    logger.debug('SigningRequests READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /**
   * READ handler for SignatureVerifications entity
   * @param req - The incoming request data
   * @returns {SignatureVerification} The signature verifications fitting the request query
   */
  srv.on('READ', SignatureVerifications, async (req: Request) => {
    logger.debug('SignatureVerifications READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /** 
   * READ handler for AddressSigningRequests entity
   * @param req - The incoming request data
   * @returns {AddressSigningRequest} The address signing requests fitting the request query
   */
  srv.on('READ', AddressSigningRequests, async (req: Request) => {
    logger.debug('AddressSigningRequests READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
  });

  /** 
   * READ handler for AddressTransactionBuilds entity
   * @param req - The incoming request data
   * @returns {AddressTransactionBuild} The address transaction builds fitting the request query
   */
  srv.on('READ', AddressTransactionBuilds, async (req: Request) => {
    logger.debug('AddressTransactionBuilds READ handler called');
    return handleRequest(req, (db) => db.run(req.query));
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

    // Fetch the signing request
    const signingRequest = await cds.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
    if (!signingRequest) rejectInvalid(req, 'GetSigningRequest', 'Signing request not found', 'signingRequestId');

    // Check if expired and update status if needed
    if (signingRequest.status === 'pending' && new Date(signingRequest.expiresAt) < new Date()) {
      await cds.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequestId }));
      signingRequest.status = 'expired';
    }

    return signingRequest;
  });

  /**
   * Verify signature of a signed transaction
   * Handler validates, verifies signature, delegates persistence to indexer
   * @param req - CDS request object (with signingRequestId, signedTxCbor, signerType, signerInfo)
   * @returns {SignatureVerification} Persisted signature verification entity
   */
  srv.on('VerifySignature', async (req: Request) => {
    logger.debug('VerifySignature Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'VerifySignature', errors);

    return handleRequest(req, async (db) => {
      // Fetch the signing request
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'VerifySignature', 'Signing request not found', 'signingRequestId');

      // Check if expired
      if (new Date(signingRequest.expiresAt) < new Date()) {
        await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequestId }));
        rejectInvalid(req, 'VerifySignature', 'Signing request has expired', 'signingRequestId');
      }

      // Verify the signature
      const signerModule = getExternalSignerModule();
      const result = signerModule.verifySignedTransaction(signedTxCbor, signingRequest.txBodyHash);

      // Delegate persistence to indexer
      const verificationRecord = await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId,
        signedTxCbor,
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
   * Verify and submit a signed transaction in one step
   * Handler validates, checks preconditions, and delegates persistence to indexer
   * @param req - CDS request object (with signingRequestId, signedTxCbor, signerType, signerInfo)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitVerifiedTransaction', async (req: Request) => {
    logger.debug('SubmitVerifiedTransaction Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'SubmitVerifiedTransaction', errors);

    return handleRequest(req, async (db) => {
      // Fetch the signing request
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request not found', 'signingRequestId');

      // Check if expired
      if (new Date(signingRequest.expiresAt) < new Date()) {
        await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequestId }));
        rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
      }

      // Check if already submitted
      if (signingRequest.status === 'submitted') {
        rejectInvalid(req, 'SubmitVerifiedTransaction', 'Transaction already submitted', 'signingRequestId');
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
    const signingRequests = await cds.run(SELECT.from(AddressSigningRequests).where({ address_address: address }));
    return signingRequests;
  });

  /**
   * Get all existing transaction builds by address
   * @param req - CDS request object (with address)
   * @returns {AddressTransactionBuilds} Address transaction build associations
   */
  srv.on('GetTransactionBuildsByAddress', async (req: Request) => {
    logger.debug('GetTransactionBuildsByAddress Action handler called');
    const { address } = req.data;
    // Validate inputs
    if (!address) rejectMissing(req, 'GetTransactionBuildsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetTransactionBuildsByAddress', 'Invalid bech32 address format', 'address');
    // Fetch the address-build associations
    const txBuilds = await cds.run(SELECT.from(AddressTransactionBuilds).where({ address_address: address }));
    return txBuilds;
  });

};