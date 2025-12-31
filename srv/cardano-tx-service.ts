import cds, { Request, __UUID } from '@sap/cds';
import logger from './utils/logger';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing } from './utils/errors';
import { isValidBech32Address } from './utils/validators';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import indexer from './blockchain/cardano-indexer';
const { SELECT, UPSERT } = cds.ql;

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

  srv.on('READ', TransactionBuildMetadata, async (req: Request) => {
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

        const txbuildResult = await txBuilder.buildSimpleAdaTransaction({
            network: network,
            senderAddress: senderAddress,
            recipientAddress: recipientAddress,
            lovelaceAmount: lovelaceAmount
         });

        const buildResult = await indexer.indexBuildResult(db, txbuildResult);
        

      // TODO: Implement transaction building logic
      // 1. Fetch UTxOs for senderAddress
      // 2. Build transaction using txBuilder
      // 3. Store build in database
      // 4. Return build record


      await db.run(INSERT.into(TransactionBuilds).entries(txbuildResult));
      
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

      // TODO: Implement submission logic
      // 1. Validate signed CBOR
      // 2. Extract txHash from signed tx
      // 3. Submit to backend (Blockfrost/Koios)
      // 4. Store submission record
      // 5. Update build.wasSubmitted flag

      const submissionId = cds.utils.uuid();
      const now = Math.floor(Date.now() / 1000);

      const submissionRecord = {
        id: submissionId,
        build_id: buildId,
        signedTxCbor,
        txHash: '', // TODO: Extract from signed tx
        submittedAt: now,
        submittedToBackend: 'blockfrost', // TODO: Dynamic backend selection
        status: 'pending',
        confirmations: 0,
        backendResponse: '',
        lastCheckedAt: now,
        retryCount: 0,
        hasErrors: false,
      };

      await db.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
      await db.run(UPSERT.into(TransactionBuilds).entries({ id: buildId, wasSubmitted: true }));

      return submissionRecord;
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
      logger.info({ network }, '[TxService] Submitting external signed transaction');

      // TODO: Implement external submission
      throw new Error('SubmitSignedTransaction not yet implemented');
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