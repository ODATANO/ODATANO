import cds, { Request } from '@sap/cds';
import { handleRequest, passthroughRead } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address } from './utils/validators';
import { getTxHashFromCbor, getLovelace, applyScriptParameters } from './utils/tx-build-helper';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { computeCip14Fingerprint, scriptHashToEnterpriseAddress } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import { POLICY_ID_HEX_LENGTH, MIN_FULL_ASSET_UNIT_LENGTH } from './utils/const';
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
    AddressTransactionBuilds
  } = require('#cds-models/CardanoTransactionService');

  // Passthrough READ handlers — these entities are read directly from DB (no index-on-miss)
  const readEntities = [TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionSubmissions, TransactionSubmissionErrors];
  readEntities.forEach(entity => srv.on('READ', entity, passthroughRead()));

  /**
   * Build a simple ADA-only transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, outputDatumJson, assetsJson } = req.data;

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

    // parse optional assets JSON (for locking native assets at script addresses)
    if (assetsJson) {
      try {
        const parsedAssets = JSON.parse(assetsJson);
        if (!Array.isArray(parsedAssets)) {
          return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'assetsJson must be a JSON array', 'assetsJson');
        }
        cleanData.assets = parsedAssets;
      } catch {
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'assetsJson must be valid JSON', 'assetsJson');
      }
      delete cleanData.assetsJson;
    }

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.info({ senderAddress, recipientAddress, lovelaceAmount, hasDatum: !!outputDatumJson, hasAssets: !!assetsJson }, 'Building simple ADA transaction');
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
    const { senderAddress, recipientAddress, lovelaceAmount, assetsJson, outputDatumJson } = req.data;

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
        { senderAddress, recipientAddress, lovelaceAmount, assets: parsedAssets, hasDatum: !!outputDatumJson },
        'Building multi-asset transaction'
      );
      // Create clean request object with parsed assets (remove assetsJson, add assets)
      const cleanData = { ...req.data };
      delete cleanData.assetsJson;

      // parse optional output datum (for locking assets at script addresses)
      if (outputDatumJson) {
        try {
          cleanData.outputDatum = JSON.parse(outputDatumJson);
        } catch {
          return rejectInvalid(req, 'BuildMultiAssetTransaction', 'outputDatumJson must be valid JSON', 'outputDatumJson');
        }
        delete cleanData.outputDatumJson;
      }

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
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, requiredSignersJson, scriptParamsJson, inlineDatumJson, mintRedeemerJson, lockOnScript } = req.data;

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
      delete cleanData.lockOnScript;

      // Apply script parameters if provided (for parameterized validators)
      let finalMintingPolicyScript = mintingPolicyScript;
      if (scriptParams && scriptParams.length > 0) {
        finalMintingPolicyScript = applyScriptParameters(mintingPolicyScript, scriptParams);

        // BUG 7 fix: expand assetName-only entries to full assetUnit using the applied script's policyId.
        const appliedScript = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex'));
        const appliedPolicyId = appliedScript.hash.toString();
        for (const action of parsedMintActions) {
          if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
            action.assetUnit = appliedPolicyId + action.assetUnit;
          }
        }

        // lockOnScript: route output to the enterprise script address derived from applied script hash
        if (lockOnScript) {
          const scriptAddr = scriptHashToEnterpriseAddress(appliedPolicyId, getCardanoClient().network);
          cleanData.recipientAddress = scriptAddr;
          logger.info({ scriptAddress: scriptAddr, scriptHash: appliedPolicyId }, 'lockOnScript: routing output to script address');
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

      // Post-build: compute CIP-14 fingerprint and scriptAddress
      if (buildResult.scriptHash) {
        const policyId = buildResult.scriptHash;
        const updates: Record<string, string> = {};

        // CIP-14 asset fingerprint for the first minted asset
        if (parsedMintActions.length > 0) {
          const firstAssetUnit = parsedMintActions[0].assetUnit;
          const assetNameHex = firstAssetUnit.length >= MIN_FULL_ASSET_UNIT_LENGTH ? firstAssetUnit.slice(POLICY_ID_HEX_LENGTH) : firstAssetUnit;
          buildResult.fingerprint = computeCip14Fingerprint(policyId, assetNameHex);
          updates.fingerprint = buildResult.fingerprint;
        }

        // lockOnScript: persist the derived script address on the build record (only when scriptParams were applied)
        if (lockOnScript && scriptParams && scriptParams.length > 0) {
          buildResult.scriptAddress = scriptHashToEnterpriseAddress(policyId, getCardanoClient().network);
          updates.scriptAddress = buildResult.scriptAddress;
        }

        if (Object.keys(updates).length > 0) {
          const { TransactionBuilds } = cds.entities('CardanoTransactionService');
          await db.run(UPDATE.entity(TransactionBuilds).set(updates).where({ id: buildResult.id }));
        }
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
    const { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, requiredSignersJson, scriptParamsJson, inlineDatumJson, lockOnScript } = req.data;

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

    // Parse and validate optional inlineDatumJson
    let inlineDatum: any | undefined;
    if (inlineDatumJson) {
      try {
        inlineDatum = JSON.parse(inlineDatumJson);
      } catch {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'inlineDatumJson must be valid JSON', 'inlineDatumJson');
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

      const cleanData: any = {
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
        requiredSigners,
        inlineDatum
      };
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;
      delete cleanData.inlineDatumJson;
      delete cleanData.lockOnScript;

      // lockOnScript: route continuing output to enterprise script address
      if (lockOnScript && scriptParams && scriptParams.length > 0) {
        const appliedScript = Script.fromCbor(Buffer.from(finalValidatorScript, 'hex'));
        const derivedScriptHash = appliedScript.hash.toString();
        const scriptAddr = scriptHashToEnterpriseAddress(derivedScriptHash, getCardanoClient().network);
        cleanData.recipientAddress = scriptAddr;
        logger.info({ scriptAddress: scriptAddr, scriptHash: derivedScriptHash }, 'lockOnScript: routing continuing output to script address');
      }

      const buildResult = await getCardanoIndexer().indexPlutusSpendBuildResult(db, cleanData);

      // lockOnScript: persist the derived script address on the build record (only when scriptParams were applied)
      if (lockOnScript && scriptParams && scriptParams.length > 0 && buildResult.scriptHash) {
        const scriptAddr = scriptHashToEnterpriseAddress(buildResult.scriptHash, getCardanoClient().network);
        buildResult.scriptAddress = scriptAddr;
        const { TransactionBuilds } = cds.entities('CardanoTransactionService');
        await db.run(UPDATE.entity(TransactionBuilds).set({ scriptAddress: scriptAddr }).where({ id: buildResult.id }));
      }

      return buildResult;
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