import cds, { Request, __UUID } from '@sap/cds';
import logger from './utils/logger';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing } from './utils/errors';
import { isValidBech32Address } from './utils/validators';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import { getTxHashFromCbor } from './utils/tx-build-helper';
import indexer from './blockchain/cardano-indexer';
import cardanoClient from './blockchain/cardano-client';
const { SELECT, UPSERT, UPDATE, INSERT } = cds.ql;

/**
 * Cardano Transaction Service Implementation
 * 
 * Handles transaction building and submission operations.
 */
module.exports = (srv: cds.Service) => {
  logger.info('[CardanoTxService] Module loaded - registering handlers');

  const {
    TransactionBuilds,
    TransactionBuildInputs,
    TransactionBuildOutputs,
    TransactionBuildMetadata,
    TransactionSubmissions,
    TransactionSubmissionErrors,
  } = require('#cds-models/CardanoTransactionService');

  // Initialize transaction builder
  const txBuilder: CardanoTransactionBuilder = new CardanoTransactionBuilder();

  // ---------------------------------------------------------------------------
  // Entity Handlers (READ-only for audit trail)
  // ---------------------------------------------------------------------------

  srv.on('READ', TransactionBuilds, async (req: Request) => {
    return handleRequest(req, (db) => db.run(req.query));
  });

  srv.on('READ', TransactionBuildInputs, async (req: Request) => {
    return handleRequest(req, (db) => db.run(req.query));
  });

  srv.on('READ', TransactionBuildOutputs, async (req: Request) => {
    return handleRequest(req, (db) => db.run(req.query));
  });

  srv.on('READ', TransactionSubmissions, async (req: Request) => {
    return handleRequest(req, (db) => db.run(req.query));
  });

  srv.on('READ', TransactionSubmissionErrors, async (req: Request) => {
    return handleRequest(req, (db) => db.run(req.query));
  });

  // ---------------------------------------------------------------------------
  // Transaction Building Actions
  // ---------------------------------------------------------------------------

  /**
   * Build a simple ADA-only transaction
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { network, senderAddress, recipientAddress, lovelaceAmount } = req.data;

    // Validate inputs
    if (!network) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'network');
    if (!senderAddress) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'senderAddress');
    if (!recipientAddress) return rejectMissing(req, 'BuildSimpleAdaTransaction', 'recipientAddress');
    if (!isValidBech32Address(senderAddress)) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'Invalid sender address format', 'senderAddress');
    }

    return handleRequest(req, async (db) => {
        logger.info({ network, senderAddress, recipientAddress, lovelaceAmount }, '[TxService] Building simple ADA transaction');

        const txbuildResult = await indexer.indexBuildResult(db, req.data);
        
      return txbuildResult;
    });
  });

  /**
   * Get build details
   */
  srv.on('GetBuildDetails', async (req: Request) => {
    const { buildId } = req.data;

    if (!buildId) return rejectMissing(req, 'GetBuildDetails', 'buildId');

    return handleRequest(req, async (db) => {
      const build = await db.run(
        SELECT.one.from(TransactionBuilds).where({ id: buildId })
      );

      if (!build) {
        return rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');
      }

      return build;
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction Submission Actions
  // ---------------------------------------------------------------------------
  /**
   * Submit a signed transaction
   */
  srv.on('SubmitTransaction', async (req: Request) => {
    const { buildId, signedTxCbor } = req.data;

    if (!buildId) return rejectMissing(req, 'SubmitTransaction', 'buildId');
    if (!signedTxCbor) return rejectMissing(req, 'SubmitTransaction', 'signedTxCbor');

    return handleRequest(req, async (db) => {
      logger.info({ buildId }, '[TxService] Submitting signed transaction');

      // Verify build exists
      const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!build) {
        return rejectInvalid(req, 'SubmitTransaction', 'Build not found', 'buildId');
      }

      // extract txHash from signed CBOR
      const txHash = getTxHashFromCbor(signedTxCbor);
      logger.debug({ txHash }, '[TxService] Transaction hash extracted from CBOR');

      // submit to blockchain via backend (Hybrid → Ogmios/Blockfrost)
      await cardanoClient.submitTransaction(signedTxCbor);
      logger.info({ txHash }, '[TxService] Transaction submitted to blockchain');

      // index submission record
      const indexSubmission = await indexer.indexTransactionSubmission(signedTxCbor, txHash);
      logger.debug('[TxService] Transaction indexed');

      // store submission record with txHash
      const submissionRecord = {
        ...indexSubmission,
        build_id: buildId,
        backendResponse: `Submitted successfully`,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
      await db.run(UPDATE.entity(TransactionBuilds).set({ wasSubmitted: true }).where({ id: buildId }));
      logger.info({ buildId, txHash }, '[TxService] Submission record stored');      
      await new Promise(resolve => setTimeout(resolve, 3000));

      // return only txHash
      return { submissionRecord };
    });
  });

  /**
   * Submit signed transaction without prior build
   */
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    const { signedTxCbor, network } = req.data;

    if (!signedTxCbor) return rejectMissing(req, 'SubmitSignedTransaction', 'signedTxCbor');
    if (!network) return rejectMissing(req, 'SubmitSignedTransaction', 'network');

    return handleRequest(req, async (db) => {
      logger.info({ network }, '[TxService] Submitting external build & signed transaction');

      // extract txHash from signed CBOR (before submission)
      const txHash = getTxHashFromCbor(signedTxCbor);
      logger.debug({ txHash }, '[TxService] Transaction hash extracted from CBOR');

      // submit to blockchain
      await cardanoClient.submitTransaction(signedTxCbor);
      logger.info({ txHash }, '[TxService] External transaction submitted');

      // index submission record
      const indexSubmission = await indexer.indexTransactionSubmission(signedTxCbor, txHash);
      logger.debug('[TxService] External transaction indexed');

      // store submission record (without buildId)
      const submissionRecord = {
        ...indexSubmission,
        build_id: null,
        backendResponse: `Submitted successfully`,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));

      // wait 3 seconds before returning
      await new Promise(resolve => setTimeout(resolve, 3000));

      return submissionRecord;
    });
  });

  /**
   * Check submission status
   */
  srv.on('CheckSubmissionStatus', async (req: Request) => {
    const { submissionId } = req.data;
    if (!submissionId) return rejectMissing(req, 'CheckSubmissionStatus', 'submissionId');

    return handleRequest(req, async (db) => {
      logger.info({ submissionId }, '[TxService] Checking submission status');
        
    });
  });

};