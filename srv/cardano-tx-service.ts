import cds, { Request } from '@sap/cds';
import { bech32 } from 'bech32';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors, rejectMissing, NotFoundError } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address, validateJsonWithLimits, isAssetUnit } from './utils/validators';
import { getTxHashFromCbor, getLovelace, applyScriptParameters, extractTxCacheTargets } from './utils/tx-build-helper';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { computeCip14Fingerprint, scriptHashToEnterpriseAddress } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import { POLICY_ID_HEX_LENGTH, MIN_FULL_ASSET_UNIT_LENGTH, COLLATERAL_LOVELACE, FEE_BUFFER_LOVELACE, BECH32_MAX_LENGTH } from './utils/const';
import type { JSONValue, MintAction, TxBuildPlutusSpendRequest } from './utils/types';
import { parseUtxoRefArray, parseRequiredSigners, parseAssetsArray, parseExtraOutputs, parseMintActionPolicyFields } from './utils/tx-request-parsers';

const VALID_DERIVE_NETWORKS = ['mainnet', 'preview', 'preprod'] as const;
type DeriveNetwork = typeof VALID_DERIVE_NETWORKS[number];
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoTxService');


/** CardanoTransactionService handlers: transaction building, submission and script helpers. */
module.exports = (srv: cds.Service) => {
  logger.debug('Module loaded - registering handlers');

  const {
    TransactionBuilds,
    TransactionSubmissions,
    AddressTransactionBuilds
  } = require('#cds-models/CardanoTransactionService');

  // BuildSimpleAdaTransaction — ADA (optionally with assets / datum) to one recipient or a script.
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, outputDatumJson, assetsJson, forceInputsJson, validatorScript, scriptParamsJson, lockOnScript, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount']
    );
    throwIfValidationErrors(req, 'BuildSimpleAdaTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    const cleanData = { ...req.data };

    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildSimpleAdaTransaction', forceInputsResult.error, 'forceInputsJson');
    cleanData.forceInputs = forceInputsResult.parsed;
    delete cleanData.forceInputsJson;
    if (outputDatumJson) {
      const jsonResult = validateJsonWithLimits(outputDatumJson, 'outputDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'outputDatumJson');
      cleanData.outputDatum = jsonResult.parsed;
      delete cleanData.outputDatumJson;
    }

    // Native assets to lock at a script address
    const assetsResult = parseAssetsArray(assetsJson, 'assetsJson');
    if (assetsResult.error) return rejectInvalid(req, 'BuildSimpleAdaTransaction', assetsResult.error, 'assetsJson');
    if (assetsResult.parsed) {
      cleanData.assets = assetsResult.parsed;
      delete cleanData.assetsJson;
    }

    // Parameters for a parameterized validator
    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    if (lockOnScript && !validatorScript) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'lockOnScript requires validatorScript to derive the script address', 'validatorScript');
    }

    // lockOnScript: derive script hash + address and override the recipient before the build.
    let derivedScriptHash: string | undefined;
    let derivedScriptAddress: string | undefined;
    if (lockOnScript && validatorScript) {
      try {
        const finalScript = scriptParams && scriptParams.length > 0
          ? applyScriptParameters(validatorScript, scriptParams)
          : validatorScript;
        derivedScriptHash = Script.fromCbor(Buffer.from(finalScript, 'hex')).hash.toString();
        derivedScriptAddress = scriptHashToEnterpriseAddress(derivedScriptHash, getCardanoClient().network);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', `Failed to derive script address: ${errMsg}`, 'validatorScript');
      }
      cleanData.recipientAddress = derivedScriptAddress;
    }

    delete cleanData.validatorScript;
    delete cleanData.scriptParamsJson;
    delete cleanData.lockOnScript;

    if (referenceScriptHex) {
      cleanData.referenceScript = referenceScriptHex;
    }
    delete cleanData.referenceScriptHex;

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress, recipientAddress: cleanData.recipientAddress, lovelaceAmount, hasDatum: !!outputDatumJson, hasAssets: !!assetsJson, lockOnScript: !!lockOnScript }, 'Building simple ADA transaction');

      const buildResult = await getCardanoIndexer().indexSimpleBuildResult(db, cleanData);

      // Persist the derived script address + hash on the build record
      if (lockOnScript && derivedScriptHash && derivedScriptAddress && buildResult.id) {
        buildResult.scriptHash = derivedScriptHash;
        buildResult.scriptAddress = derivedScriptAddress;
        const { TransactionBuilds } = cds.entities('CardanoTransactionService');
        await db.run(
          UPDATE.entity(TransactionBuilds)
            .set({ scriptHash: derivedScriptHash, scriptAddress: derivedScriptAddress })
            .where({ id: buildResult.id })
        );
      }

      return buildResult;
    });
  });
  // BuildTransactionWithMetadata — ADA transfer with auxiliary metadata.
  srv.on('BuildTransactionWithMetadata', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, metadataJson } = req.data;

    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, metadataJson },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
    );
    throwIfValidationErrors(req, 'BuildTransactionWithMetadata', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildTransactionWithMetadata', 'Invalid changeAddress format', 'changeAddress');
    }

    // Already validated as JSON above
    const parsedMetadata = JSON.parse(metadataJson);

    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, metadataKeyCount: Object.keys(parsedMetadata).length },
        'Building transaction with metadata'
      );

      return await getCardanoIndexer().indexMetadataBuildResult(db, { ...req.data, metadataJson: parsedMetadata });
    });
  });

  // BuildMultiAssetTransaction — ADA plus native assets to one recipient.
  srv.on('BuildMultiAssetTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, assetsJson, outputDatumJson, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, assetsJson, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']
    );
    throwIfValidationErrors(req, 'BuildMultiAssetTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    const assetsResult = parseAssetsArray(assetsJson, 'assetsJson');
    if (assetsResult.error) return rejectInvalid(req, 'BuildMultiAssetTransaction', assetsResult.error, 'assetsJson');
    const parsedAssets = assetsResult.parsed;
    if (!parsedAssets || parsedAssets.length === 0) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'assetsJson must contain at least one asset', 'assetsJson');
    }

    const cleanData = { ...req.data };
    delete cleanData.assetsJson;

    if (outputDatumJson) {
      const jsonResult = validateJsonWithLimits(outputDatumJson, 'outputDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMultiAssetTransaction', jsonResult.error!, 'outputDatumJson');
      cleanData.outputDatum = jsonResult.parsed;
      delete cleanData.outputDatumJson;
    }

    if (referenceScriptHex) {
      cleanData.referenceScript = referenceScriptHex;
    }
    delete cleanData.referenceScriptHex;

    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, assets: parsedAssets, hasDatum: !!outputDatumJson },
        'Building multi-asset transaction'
      );
      const result = await getCardanoIndexer().indexMultiAssetBuildResult(db, { ...cleanData, assets: parsedAssets });
      logger.debug({ id: result.id, fee: result.fee, size: result.size }, 'Multi-asset transaction build result');
      return result;
    });
  });

  // BuildMintTransaction — mint/burn under one or more Plutus policies.
  srv.on('BuildMintTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, requiredSignersJson, scriptParamsJson, inlineDatumJson, mintRedeemerJson, lockOnScript, forceInputsJson, referenceInputsJson, referenceScriptHex, extraOutputsJson, metadataJson, validityStartMs, validityEndMs } = req.data;

    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, referenceScriptHex, metadataJson, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'mintActionsJson', 'mintingPolicyScript']
    );
    throwIfValidationErrors(req, 'BuildMintTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // Mint actions: quantities become bigint; bare asset names are expanded with the policy id.
    const parsedMintActionsRaw = JSON.parse(mintActionsJson);
    if (!Array.isArray(parsedMintActionsRaw)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'mintActionsJson must be a JSON array', 'mintActionsJson');
    }
    const parsedMintActions = parsedMintActionsRaw.map((action: { assetUnit: string; quantity: string }, actionIndex: number) => {
      if (!action || typeof action !== 'object') {
        return rejectInvalid(req, 'BuildMintTransaction', 'Each mint action must be an object with assetUnit and quantity', 'mintActionsJson');
      }
      // Optional per-action mintingPolicyScript + redeemerJson
      const policyFields = parseMintActionPolicyFields(action as unknown as Record<string, unknown>, actionIndex);
      if (policyFields.error) {
        return rejectInvalid(req, 'BuildMintTransaction', policyFields.error, 'mintActionsJson');
      }
      let actionPolicyId: string | undefined;
      if (policyFields.script) {
        try {
          actionPolicyId = Script.fromCbor(Buffer.from(policyFields.script, 'hex')).hash.toString();
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, 'BuildMintTransaction', `mintActions[${actionIndex}].mintingPolicyScript is not a valid Plutus script: ${errMsg}`, 'mintActionsJson');
        }
      }

      const bareAssetNameForExpansion =
        (!!scriptParamsJson || !!actionPolicyId) &&
        typeof action.assetUnit === 'string' &&
        action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH &&
        action.assetUnit.length % 2 === 0 &&
        /^[0-9a-fA-F]*$/.test(action.assetUnit);
      if (typeof action.assetUnit !== 'string' || (!isAssetUnit(action.assetUnit) && !bareAssetNameForExpansion)) {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid assetUnit: "${action.assetUnit}" — must be policyId+assetName hex (or a bare assetName hex when scriptParamsJson or a per-action mintingPolicyScript is set)`, 'mintActionsJson');
      }
      let assetUnit = action.assetUnit;
      if (actionPolicyId) {
        if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
          assetUnit = actionPolicyId + assetUnit;
        } else if (!assetUnit.toLowerCase().startsWith(actionPolicyId)) {
          return rejectInvalid(req, 'BuildMintTransaction', `mintActions[${actionIndex}].assetUnit "${assetUnit}" does not start with its own policy id ${actionPolicyId}`, 'mintActionsJson');
        }
      }
      if (typeof action.quantity !== 'string') {
        return rejectInvalid(req, 'BuildMintTransaction', 'Each mint action must have a string quantity', 'mintActionsJson');
      }
      if (!/^-?\d+$/.test(action.quantity)) {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid quantity format: "${action.quantity}" — must be an integer string`, 'mintActionsJson');
      }
      try {
        return {
          assetUnit,
          quantity: BigInt(action.quantity),
          ...((action as { redeemer?: number }).redeemer !== undefined ? { redeemer: (action as { redeemer?: number }).redeemer } : {}),
          ...(policyFields.script ? { mintingPolicyScript: policyFields.script } : {}),
          ...(policyFields.redeemer !== undefined ? { redeemerJson: policyFields.redeemer } : {})
        };
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid quantity: "${action.quantity}" — cannot parse as integer`, 'mintActionsJson');
      }
    });

    const requiredSignersResult = parseRequiredSigners(requiredSignersJson);
    if (requiredSignersResult.error) return rejectInvalid(req, 'BuildMintTransaction', requiredSignersResult.error, 'requiredSignersJson');
    const requiredSigners = requiredSignersResult.parsed;

    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    let inlineDatum: JSONValue | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed as JSONValue;
    }

    let mintRedeemer: JSONValue | undefined;
    if (mintRedeemerJson) {
      const jsonResult = validateJsonWithLimits(mintRedeemerJson, 'mintRedeemerJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'mintRedeemerJson');
      mintRedeemer = jsonResult.parsed as JSONValue;
    }

    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    // extraOutputsJson: each minted token can sit on its own output with its own inline datum
    const extraOutputsResult = parseExtraOutputs(extraOutputsJson);
    if (extraOutputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', extraOutputsResult.error, 'extraOutputsJson');
    const extraOutputs = extraOutputsResult.parsed;

    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // CIP-31 reference inputs
    const refInputsResult = parseUtxoRefArray(referenceInputsJson, 'referenceInputsJson');
    if (refInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    let parsedMetadata: JSONValue | undefined;
    if (metadataJson) {
      try {
        parsedMetadata = JSON.parse(metadataJson) as JSONValue;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid metadataJson: ${errMsg}`, 'metadataJson');
      }
      if (typeof parsedMetadata !== 'object' || parsedMetadata === null || Array.isArray(parsedMetadata)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'metadataJson must be an object with numeric label keys', 'metadataJson');
      }
    }

    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, mintActions: parsedMintActions, forceInputs: forceInputs?.length ?? 0, referenceInputs: referenceInputs?.length ?? 0, hasMetadata: !!parsedMetadata },
        'Building minting transaction'
      );

      const cleanData = { ...req.data };
      delete cleanData.mintActionsJson;
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;
      delete cleanData.inlineDatumJson;
      delete cleanData.mintRedeemerJson;
      delete cleanData.lockOnScript;
      delete cleanData.forceInputsJson;
      delete cleanData.referenceInputsJson;
      delete cleanData.extraOutputsJson;
      if (parsedMetadata) {
        cleanData.metadataJson = parsedMetadata;
      } else {
        delete cleanData.metadataJson;
      }

      if (referenceScriptHex) {
        cleanData.referenceScript = referenceScriptHex;
      }
      delete cleanData.referenceScriptHex;

      // Parameterized policy: apply params, then expand bare asset names with the applied hash.
      let finalMintingPolicyScript = mintingPolicyScript;
      let effectivePolicyId: string | undefined;
      if (scriptParams && scriptParams.length > 0) {
        try {
          finalMintingPolicyScript = applyScriptParameters(mintingPolicyScript, scriptParams);
          const appliedScript = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex'));
          effectivePolicyId = appliedScript.hash.toString();
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, 'BuildMintTransaction', `Failed to apply script parameters: ${errMsg}`, 'scriptParamsJson');
        }
        for (const action of parsedMintActions) {
          if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
            action.assetUnit = effectivePolicyId + action.assetUnit;
          }
        }

        // lockOnScript: route the output to the enterprise address of the applied script
        if (lockOnScript) {
          const scriptAddr = scriptHashToEnterpriseAddress(effectivePolicyId, getCardanoClient().network);
          cleanData.recipientAddress = scriptAddr;
          logger.debug({ scriptAddress: scriptAddr, scriptHash: effectivePolicyId }, 'lockOnScript: routing output to script address');
        }
      } else {
        try {
          effectivePolicyId = Script.fromCbor(Buffer.from(mintingPolicyScript, 'hex')).hash.toString();
        } catch {
          // Invalid script CBOR: skip the prefix check, the builder rejects it with its own message.
        }
      }

      // Every action without its own policy must carry the top-level policy id prefix.
      if (effectivePolicyId) {
        const policyId = effectivePolicyId;
        const mismatch = parsedMintActions.find(
          (action) => !action.mintingPolicyScript && !action.assetUnit.toLowerCase().startsWith(policyId)
        );
        if (mismatch) {
          return rejectInvalid(
            req,
            'BuildMintTransaction',
            `assetUnit "${mismatch.assetUnit}" does not start with the minting policy id ${policyId} — pass the full unit as policyId+assetName (asset names longer than 28 bytes cannot be passed bare)`,
            'mintActionsJson'
          );
        }
      }

      const buildResult = await getCardanoIndexer().indexMintBuildResult(db, {
        ...cleanData,
        mintActions: parsedMintActions,
        mintingPolicyScript: finalMintingPolicyScript,
        requiredSigners,
        inlineDatum,
        mintRedeemer,
        forceInputs,
        referenceInputs,
        extraOutputs
      });

      // Post-build: CIP-14 fingerprint and scriptAddress
      if (buildResult.scriptHash) {
        const policyId = buildResult.scriptHash;
        const updates: Record<string, string> = {};

        // Fingerprint of the first minted asset. The policy id is taken from the unit, not from
        // buildResult.scriptHash: a per-action policy may differ from the top-level script.
        if (parsedMintActions.length > 0) {
          const firstAssetUnit = parsedMintActions[0].assetUnit;
          const firstPolicyId = firstAssetUnit.slice(0, POLICY_ID_HEX_LENGTH);
          const assetNameHex = firstAssetUnit.slice(POLICY_ID_HEX_LENGTH);
          buildResult.fingerprint = computeCip14Fingerprint(firstPolicyId, assetNameHex);
          updates.fingerprint = buildResult.fingerprint;
        }

        // lockOnScript: persist the derived script address on the build record
        if (lockOnScript && scriptParams && scriptParams.length > 0) {
          buildResult.scriptAddress = scriptHashToEnterpriseAddress(policyId, getCardanoClient().network);
          updates.scriptAddress = buildResult.scriptAddress;
        }

        if (buildResult.id && Object.keys(updates).length > 0) {
          const { TransactionBuilds } = cds.entities('CardanoTransactionService');
          await db.run(UPDATE.entity(TransactionBuilds).set(updates).where({ id: buildResult.id }));
        }
      }

      return buildResult;
    });
  });

  // BuildPlutusSpendTransaction — consume a UTxO at a script address, optionally minting too.
  srv.on('BuildPlutusSpendTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, requiredSignersJson, scriptParamsJson, inlineDatumJson, lockOnScript, forceInputsJson, extraOutputsJson, mintActionsJson, mintingPolicyScript, mintRedeemerJson, referenceInputsJson, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'validatorScript', 'scriptTxHash', 'redeemerJson']
    );
    throwIfValidationErrors(req, 'BuildPlutusSpendTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // A number: not covered by the required-fields check
    if (scriptOutputIndex === undefined || scriptOutputIndex === null) {
      return rejectMissing(req, 'BuildPlutusSpendTransaction', 'scriptOutputIndex');
    }

    const parsedRedeemer = JSON.parse(redeemerJson);
    const parsedDatum = datumJson ? JSON.parse(datumJson) : undefined;

    const requiredSignersResult = parseRequiredSigners(requiredSignersJson);
    if (requiredSignersResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', requiredSignersResult.error, 'requiredSignersJson');
    const requiredSigners = requiredSignersResult.parsed;

    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    let inlineDatum: JSONValue | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed as JSONValue;
    }

    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // CIP-31 reference inputs
    const refInputsResult = parseUtxoRefArray(referenceInputsJson, 'referenceInputsJson');
    if (refInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    const extraOutputsResult = parseExtraOutputs(extraOutputsJson);
    if (extraOutputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', extraOutputsResult.error, 'extraOutputsJson');
    const extraOutputs = extraOutputsResult.parsed;

    // Optional combined spend+mint parameters
    let parsedMintActions: MintAction[] | undefined;
    let parsedMintRedeemer: JSONValue | undefined;
    if (mintActionsJson) {
      if (!mintingPolicyScript) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintActionsJson requires mintingPolicyScript', 'mintingPolicyScript');
      }
      const mintJson = validateJsonWithLimits(mintActionsJson, 'mintActionsJson');
      if (!mintJson.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', mintJson.error!, 'mintActionsJson');
      if (!Array.isArray(mintJson.parsed)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintActionsJson must be a JSON array', 'mintActionsJson');
      }
      parsedMintActions = mintJson.parsed.map((rawAction: unknown, actionIndex: number) => {
        if (!rawAction || typeof rawAction !== 'object') {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Each mint action must be an object with assetUnit and quantity', 'mintActionsJson');
        }
        const action = rawAction as Record<string, unknown>;
        if (typeof action.quantity !== 'string' || !/^-?\d+$/.test(action.quantity)) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Invalid quantity: "${action.quantity}" — must be an integer string`, 'mintActionsJson');
        }
        if (typeof action.assetUnit !== 'string') {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Each mint action must have assetUnit string', 'mintActionsJson');
        }
        // Optional per-action mintingPolicyScript + redeemerJson (same rules as BuildMintTransaction)
        const policyFields = parseMintActionPolicyFields(action, actionIndex);
        if (policyFields.error) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', policyFields.error, 'mintActionsJson');
        }
        let actionPolicyId: string | undefined;
        if (policyFields.script) {
          try {
            actionPolicyId = Script.fromCbor(Buffer.from(policyFields.script, 'hex')).hash.toString();
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return rejectInvalid(req, 'BuildPlutusSpendTransaction', `mintActions[${actionIndex}].mintingPolicyScript is not a valid Plutus script: ${errMsg}`, 'mintActionsJson');
          }
        }

        const bareAssetNameForExpansion =
          ((!!scriptParamsJson && mintingPolicyScript === validatorScript) || !!actionPolicyId) &&
          action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH &&
          action.assetUnit.length % 2 === 0 &&
          /^[0-9a-fA-F]*$/.test(action.assetUnit);
        if (!isAssetUnit(action.assetUnit) && !bareAssetNameForExpansion) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Invalid assetUnit: "${action.assetUnit}" — must be policyId+assetName hex (or a bare assetName hex when a per-action mintingPolicyScript is set, or scriptParamsJson is set and the policy equals the validator)`, 'mintActionsJson');
        }
        let assetUnit = action.assetUnit;
        if (actionPolicyId) {
          if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
            assetUnit = actionPolicyId + assetUnit;
          } else if (!assetUnit.toLowerCase().startsWith(actionPolicyId)) {
            return rejectInvalid(req, 'BuildPlutusSpendTransaction', `mintActions[${actionIndex}].assetUnit "${assetUnit}" does not start with its own policy id ${actionPolicyId}`, 'mintActionsJson');
          }
        }
        return {
          assetUnit,
          quantity: BigInt(action.quantity),
          ...(typeof action.redeemer === 'number' ? { redeemer: action.redeemer } : {}),
          ...(policyFields.script ? { mintingPolicyScript: policyFields.script } : {}),
          ...(policyFields.redeemer !== undefined ? { redeemerJson: policyFields.redeemer } : {})
        };
      });
      if (mintRedeemerJson) {
        const mrJson = validateJsonWithLimits(mintRedeemerJson, 'mintRedeemerJson');
        if (!mrJson.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', mrJson.error!, 'mintRedeemerJson');
        parsedMintRedeemer = mrJson.parsed as JSONValue;
      }
    } else if (mintingPolicyScript || mintRedeemerJson) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintingPolicyScript / mintRedeemerJson require mintActionsJson', 'mintActionsJson');
    }

    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, scriptTxHash, scriptOutputIndex },
        'Building Plutus spending transaction'
      );

      let finalValidatorScript = validatorScript;
      if (scriptParams && scriptParams.length > 0) {
        try {
          finalValidatorScript = applyScriptParameters(validatorScript, scriptParams);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Failed to apply script parameters: ${errMsg}`, 'scriptParamsJson');
        }
      }

      // A mint policy byte-equal to the validator (multi-purpose script) reuses the
      // params-applied validator hex; any other policy passes through unchanged.
      let finalMintingPolicyScript: string | undefined;
      if (parsedMintActions) {
        finalMintingPolicyScript = (mintingPolicyScript === validatorScript)
          ? finalValidatorScript
          : mintingPolicyScript;

        if (finalMintingPolicyScript && scriptParams && scriptParams.length > 0 && mintingPolicyScript === validatorScript) {
          let appliedPolicyId: string;
          try {
            appliedPolicyId = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex')).hash.toString();
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Failed to hash applied script: ${errMsg}`, 'mintingPolicyScript');
          }
          for (const action of parsedMintActions) {
            if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
              action.assetUnit = appliedPolicyId + action.assetUnit;
            }
          }
        }

        // Policy-id prefix check as in BuildMintTransaction: the builder discards the unit's
        // first 56 hex chars, so a mismatched prefix would mint a truncated asset name.
        if (finalMintingPolicyScript) {
          let mintPolicyId: string | undefined;
          try {
            mintPolicyId = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex')).hash.toString();
          } catch {
            // Invalid script CBOR: skip the prefix check, the builder rejects it with its own message.
          }
          if (mintPolicyId) {
            const policyId = mintPolicyId;
            // Actions with a per-action script were already checked against that policy id.
            const mismatch = parsedMintActions.find(
              (action) => !action.mintingPolicyScript && !action.assetUnit.toLowerCase().startsWith(policyId)
            );
            if (mismatch) {
              return rejectInvalid(
                req,
                'BuildPlutusSpendTransaction',
                `assetUnit "${mismatch.assetUnit}" does not start with the minting policy id ${policyId} — pass the full unit as policyId+assetName (asset names longer than 28 bytes cannot be passed bare)`,
                'mintActionsJson'
              );
            }
          }
        }
      }

      const cleanData: Record<string, unknown> = {
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
        inlineDatum,
        forceInputs,
        referenceInputs,
        extraOutputs,
        mintActions: parsedMintActions,
        mintingPolicyScript: finalMintingPolicyScript,
        mintRedeemer: parsedMintRedeemer
      };
      if (referenceScriptHex) {
        cleanData.referenceScript = referenceScriptHex;
      }
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;
      delete cleanData.inlineDatumJson;
      delete cleanData.lockOnScript;
      delete cleanData.forceInputsJson;
      delete cleanData.referenceInputsJson;
      delete cleanData.extraOutputsJson;
      delete cleanData.mintActionsJson;
      delete cleanData.mintRedeemerJson;
      delete cleanData.referenceScriptHex;

      // lockOnScript: route the continuing output to the enterprise script address
      if (lockOnScript && scriptParams && scriptParams.length > 0) {
        try {
          const appliedScript = Script.fromCbor(Buffer.from(finalValidatorScript, 'hex'));
          const derivedScriptHash = appliedScript.hash.toString();
          const scriptAddr = scriptHashToEnterpriseAddress(derivedScriptHash, getCardanoClient().network);
          cleanData.recipientAddress = scriptAddr;
          logger.debug({ scriptAddress: scriptAddr, scriptHash: derivedScriptHash }, 'lockOnScript: routing continuing output to script address');
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Failed to derive script address: ${errMsg}`, 'validatorScript');
        }
      }

      const buildResult = await getCardanoIndexer().indexPlutusSpendBuildResult(db, cleanData as TxBuildPlutusSpendRequest);

      // lockOnScript: persist the derived script address on the build record
      if (lockOnScript && scriptParams && scriptParams.length > 0 && buildResult.scriptHash && buildResult.id) {
        const scriptAddr = scriptHashToEnterpriseAddress(buildResult.scriptHash, getCardanoClient().network);
        buildResult.scriptAddress = scriptAddr;
        const { TransactionBuilds } = cds.entities('CardanoTransactionService');
        await db.run(UPDATE.entity(TransactionBuilds).set({ scriptAddress: scriptAddr }).where({ id: buildResult.id }));
      }

      return buildResult;
    });
  });

  // GetBuildDetails — an existing transaction build by id.
  srv.on('GetBuildDetails', async (req: Request) => {
    const { buildId } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'GetBuildDetails', errors);

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) throw new NotFoundError(`Build '${buildId}'`);
      return existing;
    });
  });

  // SetCollateral — ensures >= 2 UTxOs of >= 5 ADA; otherwise builds a self-send that creates one.
  srv.on('SetCollateral', async (req: Request) => {
    const { address } = req.data;

    if (!address) return rejectMissing(req, 'SetCollateral', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'SetCollateral', 'Invalid Bech32 address format', 'address');
    }

    return handleRequest(req, async (db) => {
      // Inside handleRequest use rejectInvalid (typed BackendError 400), not req.reject,
      // so mapError preserves the status.
      const utxos = await getCardanoClient().getAddressUtxos(address);

      if (utxos.length === 0) {
        return rejectInvalid(req, 'SetCollateral', 'No UTxOs found at address', 'address');
      }

      const qualifyingUtxos = utxos.filter(u => getLovelace(u) >= COLLATERAL_LOVELACE);

      if (qualifyingUtxos.length >= 2) {
        return {
          id: cds.utils.uuid(),
          network: getCardanoClient().network,
          senderAddress: address,
          collateralAvailable: true,
        };
      }

      const totalLovelace = utxos.reduce((sum, u) => sum + getLovelace(u), 0n);

      if (totalLovelace < COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) {
        return rejectInvalid(
          req,
          'SetCollateral',
          `Insufficient funds — need at least ${Number(COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) / 1_000_000} ADA, have ${Number(totalLovelace) / 1_000_000} ADA`,
          'address',
        );
      }

      logger.debug({ address, existingQualifying: qualifyingUtxos.length }, 'Building collateral setup transaction');
      const result = await getCardanoIndexer().indexSimpleBuildResult(db, {
        network: getCardanoClient().network,
        senderAddress: address,
        recipientAddress: address,
        lovelaceAmount: COLLATERAL_LOVELACE.toString(),
        changeAddress: address,
      });
      return { ...result, collateralAvailable: false };
    });
  });

  // SubmitTransaction — submit the signed CBOR of a previous build.
  srv.on('SubmitTransaction', async (req: Request) => {
    logger.debug('SubmitTransaction Action handler called');
    const { buildId, signedTxCbor } = req.data;

    const errors = validateTransactionInputs({ buildId, signedTxCbor }, ['buildId', 'signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitTransaction', errors);

    return handleRequest(req, async (db) => {
      logger.debug({ buildId }, 'Submitting signed transaction');

      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) throw new NotFoundError(`Build '${buildId}'`);

      // The signed CBOR must belong to this build (audit-trail integrity)
      const signedTxHash = getTxHashFromCbor(signedTxCbor);
      if (signedTxHash !== existing.txBodyHash) {
        return rejectInvalid(req, 'SubmitTransaction', `signedTxCbor hash '${signedTxHash}' does not match build txBodyHash '${existing.txBodyHash}'`, 'signedTxCbor');
      }

      const txHash = existing.txBodyHash;

      // Two-phase submit: persist as 'pending', then submit
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

        // Best-effort UTxO cache invalidation (spent inputs, output addresses, sender);
        // a failure must not fail the successful submit.
        try {
          const addrBuild = await db.run(
            SELECT.one.from(AddressTransactionBuilds).where({ txBuild_id: buildId })
          );
          await getCardanoIndexer().invalidateUtxoCacheForTx(
            db,
            extractTxCacheTargets(signedTxCbor),
            addrBuild?.address_address ? [addrBuild.address_address] : []
          );
        } catch (invalidateErr: unknown) {
          logger.warn(`UTxO cache invalidation failed (submit unaffected): ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ txHash, error: errMsg }, 'Transaction submission failed');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'failed', errMsg);
        throw err;
      }

      return submissionRecord;
    });
  });

  // SubmitSignedTransaction — submit externally built signed CBOR (no prior build).
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    logger.debug('SubmitSignedTransaction Action handler called');
    const { signedTxCbor, network } = req.data;

    const errors = validateTransactionInputs({ signedTxCbor }, ['signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitSignedTransaction', errors);

    return handleRequest(req, async (db) => {
      // A caller targeting the wrong deployment gets a clear 400
      const configuredNetwork = getCardanoClient().network;
      if (network && network !== configuredNetwork) {
        return rejectInvalid(req, 'SubmitSignedTransaction', `network '${network}' does not match this deployment's network '${configuredNetwork}'`, 'network');
      }

      const txHash = getTxHashFromCbor(signedTxCbor);

      // Two-phase submit: persist as 'pending', then submit
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

        // Best-effort UTxO cache invalidation
        try {
          await getCardanoIndexer().invalidateUtxoCacheForTx(db, extractTxCacheTargets(signedTxCbor));
        } catch (invalidateErr: unknown) {
          logger.warn(`UTxO cache invalidation failed (submit unaffected): ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ txHash, error: errMsg }, 'External transaction submission failed');
        await getCardanoIndexer().updateSubmissionStatus(db, submissionRecord.id!, 'failed', errMsg);
        throw err;
      }

      return submissionRecord;
    });
  });

  // CheckSubmissionStatus — bound action; the @from: [#submitted] state gate is enforced by CAP.
  srv.on('CheckSubmissionStatus', async (req: Request) => {
    logger.debug('CheckSubmissionStatus Action handler called');
    const { id: submissionId } = req.params[0] as { id: string };

    return handleRequest(req, async (db) => {
      const submission = await db.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId }));
      if (!submission) throw new NotFoundError(`Submission '${submissionId}'`);

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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof NotFoundError || (err as { statusCode?: number })?.statusCode === 404) {
          logger.debug({ submissionId, txHash: submission.txHash }, 'Transaction not yet confirmed on chain');
        } else {
          // A provider error must not be masked as "pending"
          logger.warn({ submissionId, txHash: submission.txHash, error: errMsg }, 'Failed to check transaction confirmation status');
          throw err;
        }
      }

      return submission;
    });
  });

  // GetTransactionBuildsByAddress — address ↔ build associations.
  srv.on('GetTransactionBuildsByAddress', async (req: Request) => {
    logger.debug('GetTransactionBuildsByAddress Action handler called');
    const { address } = req.data;
    if (!address) return rejectMissing(req, 'GetTransactionBuildsByAddress', 'address');
    if (!isValidBech32Address(address)) return rejectInvalid(req, 'GetTransactionBuildsByAddress', 'Invalid bech32 address format', 'address');
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressTransactionBuilds).where({ address_address: address }));
    });
  });

  // DeriveScriptAddress — enterprise address + hash of a validator, optionally parameterized.
  srv.on('DeriveScriptAddress', async (req: Request) => {
    const { validatorScript, scriptParamsJson, network } = req.data;

    if (!validatorScript) return rejectMissing(req, 'DeriveScriptAddress', 'validatorScript');
    if (typeof validatorScript !== 'string' || !/^[0-9a-fA-F]+$/.test(validatorScript) || validatorScript.length % 2 !== 0) {
      return rejectInvalid(req, 'DeriveScriptAddress', 'validatorScript must be an even-length hex string', 'validatorScript');
    }

    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'DeriveScriptAddress', jsonResult.error!, 'scriptParamsJson');
      if (!Array.isArray(jsonResult.parsed)) {
        return rejectInvalid(req, 'DeriveScriptAddress', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
      scriptParams = jsonResult.parsed as JSONValue[];
    }

    if (network && !VALID_DERIVE_NETWORKS.includes(network as DeriveNetwork)) {
      return rejectInvalid(req, 'DeriveScriptAddress', `Invalid network "${network}". Must be one of: ${VALID_DERIVE_NETWORKS.join(', ')}`, 'network');
    }

    return handleRequest(req, async () => {
      // Resolved outside the CBOR try/catch so an uninitialized client stays a 503, not a 400.
      const targetNetwork: DeriveNetwork = network
        ? (network as DeriveNetwork)
        : (getCardanoClient().network as DeriveNetwork);

      try {
        const finalScript = scriptParams && scriptParams.length > 0
          ? applyScriptParameters(validatorScript, scriptParams)
          : validatorScript;
        const scriptHash = Script.fromCbor(Buffer.from(finalScript, 'hex')).hash.toString();
        const scriptAddress = scriptHashToEnterpriseAddress(scriptHash, targetNetwork);
        return { scriptAddress, scriptHash };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return rejectInvalid(req, 'DeriveScriptAddress', `Failed to derive script address: ${errMsg}`, 'validatorScript');
      }
    });
  });

  // ExtractPaymentKeyHash — 28-byte payment credential of a bech32 address; pure local decoding.
  srv.on('ExtractPaymentKeyHash', async (req: Request) => {
    const { address } = req.data;

    if (!address) return rejectMissing(req, 'ExtractPaymentKeyHash', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Invalid bech32 address format', 'address');
    }

    try {
      const decoded = bech32.decode(address, BECH32_MAX_LENGTH);
      const bytes = Buffer.from(bech32.fromWords(decoded.words));
      // 1 header byte + 28-byte payment credential (+ optional 28-byte stake credential)
      if (bytes.length < 29) {
        return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Address is too short to contain a payment credential', 'address');
      }
      const paymentKeyHash = bytes.slice(1, 29).toString('hex');
      return { paymentKeyHash };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return rejectInvalid(req, 'ExtractPaymentKeyHash', `Failed to decode address: ${errMsg}`, 'address');
    }
  });

};