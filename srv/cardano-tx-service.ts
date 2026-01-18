import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, BackendError } from './utils/errors';
import { ERROR_CODES } from './utils/error-codes';
import { isValidBech32Address, isValidCbor } from './utils/validators';
import { getTxHashFromCbor } from './utils/tx-build-helper';
import { JSONValue } from './utils/types';
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
   * @param req - CDS request object (with network, senderAddress, recipientAddress, lovelaceAmount, changeAddress)
   * @returns Transaction build details 
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { network, senderAddress, recipientAddress, lovelaceAmount } = req.data;

    // validate inputs
    if (!network) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'network');
    if (!senderAddress) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'senderAddress');
    if (!recipientAddress) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'recipientAddress');
    if (!isValidBech32Address(senderAddress))
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'Invalid sender address format', 'senderAddress');

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info({ network, senderAddress, recipientAddress, lovelaceAmount }, 'Building simple ADA transaction');
      return await indexer.indexSimpleBuildResult(db, req.data);
    });
  });

  srv.on('BuildTransactionWithMetadata', async (req: Request) => {
    const { network, senderAddress, recipientAddress, lovelaceAmount, metadataJson } = req.data;
    // validate inputs
    if (!network) return rejectMissing(req, 'BuildTransactionWithMetadata', 'network');
    if (!senderAddress) return rejectMissing(req, 'BuildTransactionWithMetadata', 'senderAddress');
    if (!recipientAddress) return rejectMissing(req, 'BuildTransactionWithMetadata', 'recipientAddress');
    if (!isValidBech32Address(senderAddress))
      return rejectInvalid(req, 'BuildTransactionWithMetadata', 'Invalid sender address format', 'senderAddress');
    
    // Parse metadataJson if it's a string
    let parsedMetadata: JSONValue | undefined;
    if (metadataJson) {
      try {
        parsedMetadata = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
      } catch {
        return rejectInvalid(req, 'BuildTransactionWithMetadata', 'Invalid JSON in metadataJson', 'metadataJson');
      }
    }
    
    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info(
        { network, senderAddress, recipientAddress, lovelaceAmount, metadataJson: parsedMetadata },
        'Building transaction with metadata'
      );
      return await indexer.indexMetadataBuildResult(db, { ...req.data, metadataJson: parsedMetadata });
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
    if (!buildId) return rejectMissing(req, 'GetBuildDetails', 'buildId');

    // handle the request / fetching the build details
    const existing = await cds.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));

    if (!existing) return rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');

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

    // Validate inputs
    if (!buildId) return rejectMissing(req, 'SubmitTransaction', 'buildId');
    if (!signedTxCbor) return rejectMissing(req, 'SubmitTransaction', 'signedTxCbor');
    if (!isValidCbor(signedTxCbor))
      return rejectInvalid(req, 'SubmitTransaction', 'Invalid signedTxCbor format', 'signedTxCbor');
    

    // handle the request / submitting the transaction / indexing the submission / returning submission details
    return handleRequest(req, async (db) => {
      logger.debug({ buildId }, 'Submitting signed transaction');

      // Validate build exists
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) return rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');

      // Use txBodyHash from build instead of parsing signed CBOR
      const txHash = existing.txBodyHash;

      // submit to blockchain via backend (Hybrid → Ogmios/Blockfrost)
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
    const { signedTxCbor, network } = req.data;

    // validate inputs
    if (!signedTxCbor) return rejectMissing(req, 'SubmitSignedTransaction', 'signedTxCbor');
    if (!network) return rejectMissing(req, 'SubmitSignedTransaction', 'network');
    if (!isValidCbor(signedTxCbor))
      return rejectInvalid(req, 'SubmitSignedTransaction', 'Invalid signedTxCbor format', 'signedTxCbor');
    // handle the request / submitting the transaction / indexing the submission / returning submission details
    return handleRequest(req, async (db) => {
      // extract txHash from signed CBOR (before submission)
      const txHash = getTxHashFromCbor(signedTxCbor);

      // submit to blockchain
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
    if (!submissionId) return rejectMissing(req, 'CheckSubmissionStatus', 'submissionId');

    // handle the request / checking submission status
    return handleRequest(req, async (db) => {
      const submission = await db.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId }));

      if (!submission) {
        throw new BackendError(
          `Submission with ID ${submissionId} not found`,
          404,
          ERROR_CODES.NOT_FOUND
        );
      }

      return submission;
    });
  });
};