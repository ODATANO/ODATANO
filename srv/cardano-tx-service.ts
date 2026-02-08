import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address } from './utils/validators';
import { getTxHashFromCbor, getLovelace, applyScriptParameters } from './utils/tx-build-helper';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { computeCip14Fingerprint } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoTxService');

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
    const { senderAddress, recipientAddress, lovelaceAmount, outputDatumJson } = req.data;

    // validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount']
    );
    throwIfValidationErrors(req, 'BuildSimpleAdaTransaction', errors);

    // parse optional output datum
    const cleanData = { ...req.data };
    if (outputDatumJson) {
      try {
        cleanData.outputDatum = JSON.parse(outputDatumJson);
      } catch {
        return req.reject(400, 'Invalid outputDatumJson: must be valid JSON');
      }
    }

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info({ senderAddress, recipientAddress, lovelaceAmount, hasDatum: !!outputDatumJson }, 'Building simple ADA transaction');
      return await getCardanoIndexer().indexSimpleBuildResult(db, cleanData);
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

    // Parse assetsJson (already validated as valid JSON by validateTransactionInputs)
    const parsedAssets = JSON.parse(assetsJson);
    if (!Array.isArray(parsedAssets)) {
      rejectInvalid(req, 'BuildMultiAssetTransaction', 'assetsJson must be a JSON array', 'assetsJson');
    }

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
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, requiredSignersJson, scriptParamsJson, inlineDatumJson, mintRedeemerJson } = req.data;

    // validate inputs (includes JSON and CBOR validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, mintActionsJson, mintingPolicyScript },
      ['senderAddress', 'recipientAddress', 'mintActionsJson', 'mintingPolicyScript']
    );
    throwIfValidationErrors(req, 'BuildMintTransaction', errors);

    // Parse mintActionsJson and convert quantity strings to bigint
    const parsedMintActionsRaw = JSON.parse(mintActionsJson);
    if (!Array.isArray(parsedMintActionsRaw)) {
      rejectInvalid(req, 'BuildMintTransaction', 'mintActionsJson must be a JSON array', 'mintActionsJson');
    }
    const parsedMintActions = parsedMintActionsRaw.map((action: { assetUnit: string; quantity: string }) => ({
      ...action,
      quantity: BigInt(action.quantity)
    }));

    // Parse and validate optional requiredSignersJson
    let requiredSigners: string[] | undefined;
    if (requiredSignersJson) {
      try {
        requiredSigners = JSON.parse(requiredSignersJson);
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', 'requiredSignersJson must be valid JSON', 'requiredSignersJson');
      }
      if (!Array.isArray(requiredSigners)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'requiredSignersJson must be a JSON array', 'requiredSignersJson');
      }
      for (const signer of requiredSigners) {
        if (typeof signer !== 'string' || !/^[a-f0-9]{56}$/i.test(signer)) {
          return rejectInvalid(req, 'BuildMintTransaction', 'Invalid Ed25519 key hash: must be 56 hex chars', 'requiredSignersJson');
        }
      }
    }

    // Parse and validate optional scriptParamsJson
    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      try {
        scriptParams = JSON.parse(scriptParamsJson);
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', 'scriptParamsJson must be valid JSON', 'scriptParamsJson');
      }
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // Parse and validate optional inlineDatumJson
    let inlineDatum: any | undefined;
    if (inlineDatumJson) {
      try {
        inlineDatum = JSON.parse(inlineDatumJson);
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', 'inlineDatumJson must be valid JSON', 'inlineDatumJson');
      }
    }

    // Parse and validate optional mintRedeemerJson
    let mintRedeemer: any | undefined;
    if (mintRedeemerJson) {
      try {
        mintRedeemer = JSON.parse(mintRedeemerJson);
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', 'mintRedeemerJson must be valid JSON', 'mintRedeemerJson');
      }
    }

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info(
        { senderAddress, recipientAddress, lovelaceAmount, mintActions: parsedMintActions },
        'Building minting transaction'
      );
      // Create clean request object with parsed mintActions (remove mintActionsJson, add mintActions)
      const cleanData = { ...req.data };
      delete cleanData.mintActionsJson;
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;
      delete cleanData.inlineDatumJson;
      delete cleanData.mintRedeemerJson;

      // Apply script parameters if provided (for parameterized validators)
      let finalMintingPolicyScript = mintingPolicyScript;
      if (scriptParams && scriptParams.length > 0) {
        finalMintingPolicyScript = applyScriptParameters(mintingPolicyScript, scriptParams);

        // BUG 7 fix: expand assetName-only entries to full assetUnit using the applied script's policyId.
        // A full assetUnit is >= 57 chars (56 hex policyId + at least 1 hex assetName). Shorter = assetName-only.
        const appliedScript = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex'));
        const appliedPolicyId = appliedScript.hash.toString();
        for (const action of parsedMintActions) {
          if (action.assetUnit.length < 57) {
            action.assetUnit = appliedPolicyId + action.assetUnit;
          }
        }
      }

      const buildResult = await getCardanoIndexer().indexMintBuildResult(db, {
        ...cleanData,
        mintActions: parsedMintActions,
        mintingPolicyScript: finalMintingPolicyScript,
        requiredSigners,
        inlineDatum,
        mintRedeemer
      });

      // Compute CIP-14 asset fingerprint for the first minted asset
      if (buildResult.scriptHash && parsedMintActions.length > 0) {
        const policyId = buildResult.scriptHash;
        const firstAssetUnit = parsedMintActions[0].assetUnit;
        const assetNameHex = firstAssetUnit.length >= 57 ? firstAssetUnit.slice(56) : firstAssetUnit;
        buildResult.fingerprint = computeCip14Fingerprint(policyId, assetNameHex);

        const { TransactionBuilds } = cds.entities('CardanoTransactionService');
        await db.run(UPDATE.entity(TransactionBuilds).set({ fingerprint: buildResult.fingerprint }).where({ id: buildResult.id }));
      }

      return buildResult;
    });
  });

  /**
   * Build a Plutus spending transaction (consume UTxO at script address)
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildPlutusSpendTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, requiredSignersJson, scriptParamsJson } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson },
      ['senderAddress', 'recipientAddress', 'validatorScript', 'scriptTxHash', 'redeemerJson']
    );
    throwIfValidationErrors(req, 'BuildPlutusSpendTransaction', errors);

    // Validate scriptOutputIndex separately (it's a number, not caught by required-fields check for empty string)
    if (scriptOutputIndex === undefined || scriptOutputIndex === null) {
      rejectMissing(req, 'BuildPlutusSpendTransaction', 'scriptOutputIndex');
    }

    // Parse redeemer JSON
    const parsedRedeemer = JSON.parse(redeemerJson);

    // Parse optional datum JSON
    const parsedDatum = datumJson ? JSON.parse(datumJson) : undefined;

    // Parse and validate optional requiredSignersJson
    let requiredSigners: string[] | undefined;
    if (requiredSignersJson) {
      try {
        requiredSigners = JSON.parse(requiredSignersJson);
      } catch {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'requiredSignersJson must be valid JSON', 'requiredSignersJson');
      }
      if (!Array.isArray(requiredSigners)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'requiredSignersJson must be a JSON array', 'requiredSignersJson');
      }
      for (const signer of requiredSigners) {
        if (typeof signer !== 'string' || !/^[a-f0-9]{56}$/i.test(signer)) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Invalid Ed25519 key hash: must be 56 hex chars', 'requiredSignersJson');
        }
      }
    }

    // Parse and validate optional scriptParamsJson
    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      try {
        scriptParams = JSON.parse(scriptParamsJson);
      } catch {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'scriptParamsJson must be valid JSON', 'scriptParamsJson');
      }
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    return handleRequest(req, async (db) => {
      logger.info(
        { senderAddress, recipientAddress, lovelaceAmount, scriptTxHash, scriptOutputIndex },
        'Building Plutus spending transaction'
      );

      // Apply script parameters if provided (for parameterized validators)
      let finalValidatorScript = validatorScript;
      if (scriptParams && scriptParams.length > 0) {
        finalValidatorScript = applyScriptParameters(validatorScript, scriptParams);
      }

      const cleanData = {
        ...req.data,
        plutusScriptExecution: {
          validatorScript: finalValidatorScript,
          scriptUtxo: {
            txHash: scriptTxHash,
            outputIndex: scriptOutputIndex,
          },
          redeemer: parsedRedeemer,
          datum: parsedDatum,
        },
        requiredSigners
      };
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;

      return await getCardanoIndexer().indexPlutusSpendBuildResult(db, cleanData);
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
    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');
      return existing;
    });
  });

  /**
   * Set up a collateral UTxO for Plutus transactions.
   * Checks if the address already has >= 2 UTxOs with >= 5 ADA each.
   * If not, builds a self-send transaction to create a 5 ADA collateral UTxO.
   * @param req - CDS request object (with address)
   * @returns {TransactionBuild} Transaction build details for the collateral setup
   */
  srv.on('SetCollateral', async (req: Request) => {
    const { address } = req.data;

    if (!address || !isValidBech32Address(address)) {
      return req.reject(400, 'SetCollateral: Invalid or missing Bech32 address');
    }

    const COLLATERAL_LOVELACE = 5_000_000n;
    const FEE_BUFFER_LOVELACE = 1_000_000n;

    // Fetch UTxOs and validate before entering handleRequest (req.reject inside handleRequest gets wrapped as 500)
    const utxos = await getCardanoClient().getAddressUtxos(address);

    if (utxos.length === 0) {
      return req.reject(400, 'SetCollateral: No UTxOs found at address');
    }

    const qualifyingUtxos = utxos.filter(u => getLovelace(u) >= COLLATERAL_LOVELACE);

    if (qualifyingUtxos.length >= 2) {
      return req.reject(409, `SetCollateral: Collateral already available — found ${qualifyingUtxos.length} UTxOs with >= 5 ADA`);
    }

    const totalLovelace = utxos.reduce((sum, u) => sum + getLovelace(u), 0n);

    if (totalLovelace < COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) {
      return req.reject(400, `SetCollateral: Insufficient funds — need at least ${Number(COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) / 1_000_000} ADA, have ${Number(totalLovelace) / 1_000_000} ADA`);
    }

    // Build self-send transaction: address → address, 5 ADA
    logger.info({ address, existingQualifying: qualifyingUtxos.length }, 'Building collateral setup transaction');
    return handleRequest(req, async (db) => {
      return await getCardanoIndexer().indexSimpleBuildResult(db, {
        network: getCardanoClient().network,
        senderAddress: address,
        recipientAddress: address,
        lovelaceAmount: Number(COLLATERAL_LOVELACE),
        changeAddress: address,
      });
    });
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

      // Two-phase submit: persist with 'pending', then submit to blockchain
      const submissionRecord = await getCardanoIndexer().persistTransactionSubmission(db, {
        signedTxCbor,
        txHash,
        buildId,
      });

      try {
        await getCardanoClient().submitTransaction(signedTxCbor);
        logger.info({ txHash }, 'Transaction submitted to blockchain');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'submitted');
        submissionRecord.status = 'submitted';
      } catch (err: any) {
        logger.error({ txHash, error: err.message }, 'Transaction submission failed');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'failed', err.message);
        throw err;
      }

      return submissionRecord;
    });
  });

  /**
   * Submit signed transaction without prior build
   * Handler validates, submits to blockchain, delegates persistence to indexer
   * Two-phase: persist with 'pending' first, then update to 'submitted' or 'failed'
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

      // Two-phase submit: persist with 'pending', then submit to blockchain
      const submissionRecord = await getCardanoIndexer().persistTransactionSubmission(db, {
        signedTxCbor,
        txHash,
        buildId: null,
      });

      try {
        await getCardanoClient().submitTransaction(signedTxCbor);
        logger.info({ txHash }, 'External transaction submitted');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'submitted');
        submissionRecord.status = 'submitted';
      } catch (err: any) {
        logger.error({ txHash, error: err.message }, 'External transaction submission failed');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'failed', err.message);
        throw err;
      }

      return submissionRecord;
    });
  });

  /**
   * Check submission status (bound action on TransactionSubmissions)
   * @flow.status validates @from: [#submitted] automatically (409 if wrong state)
   * Queries blockchain for transaction confirmation and updates status accordingly
   * @param req - CDS request with entity key in params
   * @returns {TransactionSubmission} The updated transaction submission status
   */
  srv.on('CheckSubmissionStatus', async (req: Request) => {
    logger.debug('CheckSubmissionStatus Action handler called');
    const { id: submissionId } = req.params[0] as { id: string };

    // @from: [#submitted] validated by framework — no manual status check needed

    return handleRequest(req, async (db) => {
      const submission = await db.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId }));
      if (!submission) rejectInvalid(req, 'CheckSubmissionStatus', 'Submission not found', 'submissionId');

      // Query blockchain for confirmation
      try {
        const txDetails = await getCardanoClient().getTransaction(submission.txHash);
        if (txDetails) {
          await db.run(
            UPDATE.entity(TransactionSubmissions)
              .set({ status: 'confirmed' })
              .where({ id: submissionId })
          );
          submission.status = 'confirmed';
          logger.info({ submissionId, txHash: submission.txHash }, 'Transaction confirmed on chain');
        }
      } catch {
        // Transaction not yet confirmed on chain — status stays 'submitted'
        logger.debug({ submissionId, txHash: submission.txHash }, 'Transaction not yet confirmed on chain');
      }

      return submission;
    });
  });

  // ---------------------------------------------------------------------------
  // M3 - External Signing Workflow Actions
  // ---------------------------------------------------------------------------

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
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressTransactionBuilds).where({ address_address: address }));
    });
  });

};