import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors } from './utils/errors';
import { validateTransactionInputs } from './utils/validators';
import { getTxHashFromCbor } from './utils/tx-build-helper';
import indexer from './blockchain/cardano-indexer';
import cardanoClient from './blockchain/cardano-client';
const { SELECT } = cds.ql;

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
   * @returns Transaction build details
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
      return await indexer.indexSimpleBuildResult(db, req.data);
    });
  });
  /**
   * Build a transaction with metadata
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, metadataJson, changeAddress)
   * @returns Transaction build details
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
      return await indexer.indexMetadataBuildResult(db, { ...req.data, metadataJson: parsedMetadata });
    });
  });

  /**
   * Build a multi-asset transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, assetsJson, changeAddress)
   * @returns Transaction build details
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

      const result = await indexer.indexMultiAssetBuildResult(db, { ...cleanData, assets: parsedAssets });
      logger.info({ result }, 'Multi-asset transaction build result');
      return result;
    });
  });

  /**
   * Build a minting transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, changeAddress)
   * @returns Transaction build details
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

      return await indexer.indexMintBuildResult(db, {
        ...cleanData,
        mintActions: parsedMintActions,
        mintingPolicyScript
      });
    });
  });

  /**
   * Get build details for previously built transaction
   * @param req - CDS request object (with buildId)
   * @returns Transaction build details
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
   * @param req - CDS request object (with buildId, signedTxCbor)
   * @returns Transaction submission details
   */
  srv.on('SubmitTransaction', async (req: Request) => {
    logger.debug('SubmitTransaction Action handler called');
    const { buildId, signedTxCbor } = req.data;

    // Validate inputs (includes CBOR format validation)
    const errors = validateTransactionInputs({ buildId, signedTxCbor }, ['buildId', 'signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitTransaction', errors);

    // handle the request / submitting the transaction / indexing the submission / returning submission details
    return handleRequest(req, async (db) => {
      logger.debug({ buildId }, 'Submitting signed transaction');

      // Validate build exists
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) rejectInvalid(req, 'SubmitTransaction', 'Build not found', 'buildId');

      // Use txBodyHash from build instead of parsing signed CBOR
      const txHash = existing.txBodyHash;

      // submit to blockchain via configured backends (Ogmios/Blockfrost/Koios)
      // Error mapping happens in normalizeBackendError (called by handleBackendRequest)
      await cardanoClient.submitTransaction(signedTxCbor);
      logger.info({ txHash }, 'Transaction submitted to blockchain');

      // index submission record
      const indexSubmission = await indexer.indexTransactionSubmission(signedTxCbor, txHash);
      logger.debug('Transaction indexed');

      // store submission record with txHash
      const submissionRecord = {
        ...indexSubmission,
        build_id: buildId,
        backendResponse: `Submitted successfully`,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
      await db.run(UPDATE.entity(TransactionBuilds).set({ wasSubmitted: true }).where({ id: buildId }));

      return submissionRecord;
    });
  });

  /**
   * Submit signed transaction without prior build
   * @param req - CDS request object (with signedTxCbor, network)
   * @returns Transaction submission details
   */
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    logger.info('SubmitSignedTransaction Action handler called');
    const { signedTxCbor } = req.data;

    // validate inputs (includes CBOR format validation)
    const errors = validateTransactionInputs({ signedTxCbor }, ['signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitSignedTransaction', errors);

    // handle the request / submitting the transaction / indexing the submission / returning submission details
    return handleRequest(req, async (db) => {
      // extract txHash from signed CBOR (before submission)
      const txHash = getTxHashFromCbor(signedTxCbor);

      // submit to blockchain
      // Error mapping happens in normalizeBackendError (called by handleBackendRequest)
      await cardanoClient.submitTransaction(signedTxCbor);
      logger.debug({ txHash }, 'External transaction submitted');

      // index submission record
      const indexSubmission = await indexer.indexTransactionSubmission(signedTxCbor, txHash);
      logger.debug('External transaction indexed');

      // store submission record with null buildId
      const submissionRecord = {
        ...indexSubmission,
        build_id: null,
        backendResponse: `Submitted successfully`,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));

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
};