import cds, { Request } from '@sap/cds';
import { bech32 } from 'bech32';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors, rejectMissing, NotFoundError } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address, validateJsonWithLimits, isTxHash, isAssetUnit } from './utils/validators';
import { getTxHashFromCbor, getLovelace, applyScriptParameters } from './utils/tx-build-helper';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { computeCip14Fingerprint, scriptHashToEnterpriseAddress } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import { POLICY_ID_HEX_LENGTH, MIN_FULL_ASSET_UNIT_LENGTH, COLLATERAL_LOVELACE, FEE_BUFFER_LOVELACE, ED25519_KEY_HASH_REGEX, BECH32_MAX_LENGTH } from './utils/const';
import type { JSONValue } from './utils/types';

const VALID_DERIVE_NETWORKS = ['mainnet', 'preview', 'preprod'] as const;
type DeriveNetwork = typeof VALID_DERIVE_NETWORKS[number];
const { SELECT, UPDATE, DELETE: DELETE_FROM } = cds.ql;

const logger = cds.log('CardanoTxService');

/**
 * Parse and validate forceInputsJson. Returns { parsed } on success (possibly undefined
 * for empty array → treated as no-op) or { error } on validation failure.
 */
function parseForceInputs(
  forceInputsJson: string | undefined
): { parsed?: Array<{ txHash: string; outputIndex: number }>; error?: string } {
  if (!forceInputsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(forceInputsJson, 'forceInputsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'forceInputsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  const refs: Array<{ txHash: string; outputIndex: number }> = [];
  for (const entry of jsonResult.parsed) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'Each forceInputs entry must be an object with txHash and outputIndex' };
    }
    if (!isTxHash((entry as any).txHash)) {
      return { error: 'Each forceInputs entry must have a valid 64-hex txHash' };
    }
    const idx = (entry as any).outputIndex;
    if (!Number.isInteger(idx) || idx < 0) {
      return { error: 'Each forceInputs entry must have a non-negative integer outputIndex' };
    }
    refs.push({ txHash: (entry as any).txHash, outputIndex: idx });
  }
  return { parsed: refs };
}

/**
 * Parse and validate referenceInputsJson (CIP-31 reference inputs).
 * Same structure as forceInputsJson: JSON array of {txHash, outputIndex}.
 */
function parseReferenceInputs(
  referenceInputsJson: string | undefined
): { parsed?: Array<{ txHash: string; outputIndex: number }>; error?: string } {
  if (!referenceInputsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(referenceInputsJson, 'referenceInputsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'referenceInputsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  const refs: Array<{ txHash: string; outputIndex: number }> = [];
  for (const entry of jsonResult.parsed) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'Each referenceInputs entry must be an object with txHash and outputIndex' };
    }
    if (!isTxHash((entry as any).txHash)) {
      return { error: 'Each referenceInputs entry must have a valid 64-hex txHash' };
    }
    const idx = (entry as any).outputIndex;
    if (!Number.isInteger(idx) || idx < 0) {
      return { error: 'Each referenceInputs entry must have a non-negative integer outputIndex' };
    }
    refs.push({ txHash: (entry as any).txHash, outputIndex: idx });
  }
  return { parsed: refs };
}

/** Upper bound on extra outputs per transaction (defence against tx-size blow-up). */
const MAX_EXTRA_OUTPUTS = 32;

export interface ParsedExtraOutput {
  address: string;
  lovelaceAmount: string;
  assets?: Array<{ unit: string; quantity: string }>;
  inlineDatum?: JSONValue;
}

/**
 * Parse and validate extraOutputsJson. Returns { parsed } on success (possibly undefined
 * for empty array → no-op) or { error } on validation failure.
 */
function parseExtraOutputs(
  extraOutputsJson: string | undefined
): { parsed?: ParsedExtraOutput[]; error?: string } {
  if (!extraOutputsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(extraOutputsJson, 'extraOutputsJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: 'extraOutputsJson must be a JSON array' };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  if (jsonResult.parsed.length > MAX_EXTRA_OUTPUTS) {
    return { error: `extraOutputsJson exceeds maximum of ${MAX_EXTRA_OUTPUTS} entries` };
  }

  const out: ParsedExtraOutput[] = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const entry = jsonResult.parsed[i] as any;
    if (!entry || typeof entry !== 'object') {
      return { error: `extraOutputs[${i}] must be an object` };
    }
    if (typeof entry.address !== 'string' || !isValidBech32Address(entry.address)) {
      return { error: `extraOutputs[${i}].address is not a valid Bech32 address` };
    }
    if (typeof entry.lovelaceAmount !== 'string' || !/^\d+$/.test(entry.lovelaceAmount) || entry.lovelaceAmount === '0') {
      return { error: `extraOutputs[${i}].lovelaceAmount must be a positive integer string` };
    }

    let assets: Array<{ unit: string; quantity: string }> | undefined;
    if (entry.assets !== undefined && entry.assets !== null) {
      if (!Array.isArray(entry.assets)) {
        return { error: `extraOutputs[${i}].assets must be an array` };
      }
      assets = [];
      for (let j = 0; j < entry.assets.length; j++) {
        const a = entry.assets[j];
        if (!a || typeof a !== 'object') {
          return { error: `extraOutputs[${i}].assets[${j}] must be an object` };
        }
        if (typeof a.unit !== 'string' || a.unit.toLowerCase() === 'lovelace' || !isAssetUnit(a.unit)) {
          return { error: `extraOutputs[${i}].assets[${j}].unit must be a valid asset unit (policyId + assetName hex)` };
        }
        if (typeof a.quantity !== 'string' || !/^\d+$/.test(a.quantity) || a.quantity === '0') {
          return { error: `extraOutputs[${i}].assets[${j}].quantity must be a positive integer string` };
        }
        assets.push({ unit: a.unit, quantity: a.quantity });
      }
    }

    let inlineDatum: JSONValue | undefined;
    if (entry.inlineDatumJson !== undefined && entry.inlineDatumJson !== null) {
      if (typeof entry.inlineDatumJson !== 'string') {
        return { error: `extraOutputs[${i}].inlineDatumJson must be a JSON string` };
      }
      const datumResult = validateJsonWithLimits(entry.inlineDatumJson, `extraOutputs[${i}].inlineDatumJson`);
      if (!datumResult.valid) return { error: datumResult.error! };
      inlineDatum = datumResult.parsed as JSONValue;
    }

    out.push({ address: entry.address, lovelaceAmount: entry.lovelaceAmount, assets, inlineDatum });
  }
  return { parsed: out };
}

/**
 * Cardano Transaction Service Implementation
 * Handles transaction building and submission operations & some additional data queries.
 */
module.exports = (srv: cds.Service) => {
  logger.debug('Module loaded - registering handlers');

  const {
    TransactionBuilds,
    TransactionSubmissions,
    AddressTransactionBuilds
  } = require('#cds-models/CardanoTransactionService');

  const {
    Addresses,
    AddressUTxOs,
    AddressAssets
  } = require('#cds-models/CardanoODataService');

  /**
   * Build a simple ADA-only transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, outputDatumJson, assetsJson, forceInputsJson, validatorScript, scriptParamsJson, lockOnScript } = req.data;

    // validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount']
    );
    throwIfValidationErrors(req, 'BuildSimpleAdaTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // parse optional output datum
    const cleanData = { ...req.data };

    // parse optional forceInputsJson
    const forceInputsResult = parseForceInputs(forceInputsJson);
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildSimpleAdaTransaction', forceInputsResult.error, 'forceInputsJson');
    cleanData.forceInputs = forceInputsResult.parsed;
    delete cleanData.forceInputsJson;
    if (outputDatumJson) {
      const jsonResult = validateJsonWithLimits(outputDatumJson, 'outputDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'outputDatumJson');
      cleanData.outputDatum = jsonResult.parsed;
    }

    // parse optional assets JSON (for locking native assets at script addresses)
    if (assetsJson) {
      const jsonResult = validateJsonWithLimits(assetsJson, 'assetsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'assetsJson');
      if (!Array.isArray(jsonResult.parsed)) {
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'assetsJson must be a JSON array', 'assetsJson');
      }
      cleanData.assets = jsonResult.parsed;
      delete cleanData.assetsJson;
    }

    // parse optional scriptParamsJson (for parameterized validators)
    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as any[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // lockOnScript requires a validatorScript to derive the target address from
    if (lockOnScript && !validatorScript) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'lockOnScript requires validatorScript to derive the script address', 'validatorScript');
    }

    // Pre-compute script hash + address when lockOnScript is set; override recipient before build.
    let derivedScriptHash: string | undefined;
    let derivedScriptAddress: string | undefined;
    if (lockOnScript && validatorScript) {
      try {
        const finalScript = scriptParams && scriptParams.length > 0
          ? applyScriptParameters(validatorScript, scriptParams)
          : validatorScript;
        derivedScriptHash = Script.fromCbor(Buffer.from(finalScript, 'hex')).hash.toString();
        derivedScriptAddress = scriptHashToEnterpriseAddress(derivedScriptHash, getCardanoClient().network);
      } catch (err: any) {
        return rejectInvalid(req, 'BuildSimpleAdaTransaction', `Failed to derive script address: ${err.message}`, 'validatorScript');
      }
      cleanData.recipientAddress = derivedScriptAddress;
    }

    delete cleanData.validatorScript;
    delete cleanData.scriptParamsJson;
    delete cleanData.lockOnScript;

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress, recipientAddress: cleanData.recipientAddress, lovelaceAmount, hasDatum: !!outputDatumJson, hasAssets: !!assetsJson, lockOnScript: !!lockOnScript }, 'Building simple ADA transaction');

      const buildResult = await getCardanoIndexer().indexSimpleBuildResult(db, cleanData);

      // Persist derived script address + hash on the build record when lockOnScript was applied
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
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildTransactionWithMetadata', 'Invalid changeAddress format', 'changeAddress');
    }

    // Parse metadataJson (already validated as valid JSON)
    const parsedMetadata = JSON.parse(metadataJson);

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, metadataKeyCount: Object.keys(parsedMetadata).length },
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
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // Parse assetsJson (already validated as valid JSON by validateTransactionInputs)
    const parsedAssets = JSON.parse(assetsJson);
    if (!Array.isArray(parsedAssets)) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'assetsJson must be a JSON array', 'assetsJson');
    }

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, assets: parsedAssets, hasDatum: !!outputDatumJson },
        'Building multi-asset transaction'
      );
      // Create clean request object with parsed assets (remove assetsJson, add assets)
      const cleanData = { ...req.data };
      delete cleanData.assetsJson;

      // parse optional output datum (for locking assets at script addresses)
      if (outputDatumJson) {
        const jsonResult = validateJsonWithLimits(outputDatumJson, 'outputDatumJson');
        if (!jsonResult.valid) return rejectInvalid(req, 'BuildMultiAssetTransaction', jsonResult.error!, 'outputDatumJson');
        cleanData.outputDatum = jsonResult.parsed;
        delete cleanData.outputDatumJson;
      }


      const result = await getCardanoIndexer().indexMultiAssetBuildResult(db, { ...cleanData, assets: parsedAssets });
      logger.debug({ id: result.id, fee: result.fee, size: result.size }, 'Multi-asset transaction build result');
      return result;
    });
  });

  /**
   * Build a minting transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildMintTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, requiredSignersJson, scriptParamsJson, inlineDatumJson, mintRedeemerJson, lockOnScript, forceInputsJson, referenceInputsJson } = req.data;

    // validate inputs (includes JSON and CBOR validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, mintActionsJson, mintingPolicyScript },
      ['senderAddress', 'recipientAddress', 'mintActionsJson', 'mintingPolicyScript']
    );
    throwIfValidationErrors(req, 'BuildMintTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // Parse mintActionsJson and convert quantity strings to bigint
    const parsedMintActionsRaw = JSON.parse(mintActionsJson);
    if (!Array.isArray(parsedMintActionsRaw)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'mintActionsJson must be a JSON array', 'mintActionsJson');
    }
    const parsedMintActions = parsedMintActionsRaw.map((action: { assetUnit: string; quantity: string }) => {
      if (!action || typeof action !== 'object') {
        return rejectInvalid(req, 'BuildMintTransaction', 'Each mint action must be an object with assetUnit and quantity', 'mintActionsJson');
      }
      if (typeof action.quantity !== 'string') {
        return rejectInvalid(req, 'BuildMintTransaction', 'Each mint action must have a string quantity', 'mintActionsJson');
      }
      if (!/^-?\d+$/.test(action.quantity)) {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid quantity format: "${action.quantity}" — must be an integer string`, 'mintActionsJson');
      }
      try {
        return { ...action, quantity: BigInt(action.quantity) };
      } catch {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid quantity: "${action.quantity}" — cannot parse as integer`, 'mintActionsJson');
      }
    });

    // Parse and validate optional requiredSignersJson
    let requiredSigners: string[] | undefined;
    if (requiredSignersJson) {
      const jsonResult = validateJsonWithLimits(requiredSignersJson, 'requiredSignersJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'requiredSignersJson');
      requiredSigners = jsonResult.parsed as string[];
      if (!Array.isArray(requiredSigners)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'requiredSignersJson must be a JSON array', 'requiredSignersJson');
      }
      for (const signer of requiredSigners) {
        if (typeof signer !== 'string' || !ED25519_KEY_HASH_REGEX.test(signer)) {
          return rejectInvalid(req, 'BuildMintTransaction', 'Invalid Ed25519 key hash: must be 56 hex chars', 'requiredSignersJson');
        }
      }
    }

    // Parse and validate optional scriptParamsJson
    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as any[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // Parse and validate optional inlineDatumJson
    let inlineDatum: any | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed;
    }

    // Parse and validate optional mintRedeemerJson
    let mintRedeemer: any | undefined;
    if (mintRedeemerJson) {
      const jsonResult = validateJsonWithLimits(mintRedeemerJson, 'mintRedeemerJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'mintRedeemerJson');
      mintRedeemer = jsonResult.parsed;
    }

    // Validate lockOnScript requires scriptParamsJson
    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    // Parse and validate optional forceInputsJson
    const forceInputsResult = parseForceInputs(forceInputsJson);
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // Parse and validate optional referenceInputsJson (CIP-31)
    const refInputsResult = parseReferenceInputs(referenceInputsJson);
    if (refInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, mintActions: parsedMintActions, forceInputs: forceInputs?.length ?? 0, referenceInputs: referenceInputs?.length ?? 0 },
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
      delete cleanData.forceInputsJson;
      delete cleanData.referenceInputsJson;

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
          logger.debug({ scriptAddress: scriptAddr, scriptHash: appliedPolicyId }, 'lockOnScript: routing output to script address');
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
        referenceInputs
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

        if (buildResult.id && Object.keys(updates).length > 0) {
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
    const { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, requiredSignersJson, scriptParamsJson, inlineDatumJson, lockOnScript, forceInputsJson, extraOutputsJson, mintActionsJson, mintingPolicyScript, mintRedeemerJson, referenceInputsJson } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson },
      ['senderAddress', 'recipientAddress', 'validatorScript', 'scriptTxHash', 'redeemerJson']
    );
    throwIfValidationErrors(req, 'BuildPlutusSpendTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // Validate scriptOutputIndex separately (it's a number, not caught by required-fields check for empty string)
    if (scriptOutputIndex === undefined || scriptOutputIndex === null) {
      return rejectMissing(req, 'BuildPlutusSpendTransaction', 'scriptOutputIndex');
    }

    // Parse redeemer JSON
    const parsedRedeemer = JSON.parse(redeemerJson);

    // Parse optional datum JSON
    const parsedDatum = datumJson ? JSON.parse(datumJson) : undefined;

    // Parse and validate optional requiredSignersJson
    let requiredSigners: string[] | undefined;
    if (requiredSignersJson) {
      const jsonResult = validateJsonWithLimits(requiredSignersJson, 'requiredSignersJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'requiredSignersJson');
      requiredSigners = jsonResult.parsed as string[];
      if (!Array.isArray(requiredSigners)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'requiredSignersJson must be a JSON array', 'requiredSignersJson');
      }
      for (const signer of requiredSigners) {
        if (typeof signer !== 'string' || !ED25519_KEY_HASH_REGEX.test(signer)) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Invalid Ed25519 key hash: must be 56 hex chars', 'requiredSignersJson');
        }
      }
    }

    // Parse and validate optional scriptParamsJson
    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as any[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // Parse and validate optional inlineDatumJson
    let inlineDatum: any | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed;
    }

    // Validate lockOnScript requires scriptParamsJson
    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    // Parse and validate optional forceInputsJson
    const forceInputsResult = parseForceInputs(forceInputsJson);
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // Parse and validate optional referenceInputsJson (CIP-31)
    const refInputsResult = parseReferenceInputs(referenceInputsJson);
    if (refInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    // Parse and validate optional extraOutputsJson
    const extraOutputsResult = parseExtraOutputs(extraOutputsJson);
    if (extraOutputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', extraOutputsResult.error, 'extraOutputsJson');
    const extraOutputs = extraOutputsResult.parsed;

    // FR-1: Optional combined spend+mint parameters. mintActionsJson triggers the combined flow;
    // mintingPolicyScript is required alongside it. mintRedeemerJson is optional.
    let parsedMintActions: Array<{ assetUnit: string; quantity: bigint }> | undefined;
    let parsedMintRedeemer: any | undefined;
    if (mintActionsJson) {
      if (!mintingPolicyScript) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintActionsJson requires mintingPolicyScript', 'mintingPolicyScript');
      }
      const mintJson = validateJsonWithLimits(mintActionsJson, 'mintActionsJson');
      if (!mintJson.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', mintJson.error!, 'mintActionsJson');
      if (!Array.isArray(mintJson.parsed)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintActionsJson must be a JSON array', 'mintActionsJson');
      }
      parsedMintActions = mintJson.parsed.map((action: any) => {
        if (!action || typeof action !== 'object') {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'Each mint action must be an object with assetUnit and quantity', 'mintActionsJson');
        }
        if (typeof action.quantity !== 'string' || !/^-?\d+$/.test(action.quantity)) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Invalid quantity: "${action.quantity}" — must be an integer string`, 'mintActionsJson');
        }
        return { ...action, quantity: BigInt(action.quantity) };
      });
      if (mintRedeemerJson) {
        const mrJson = validateJsonWithLimits(mintRedeemerJson, 'mintRedeemerJson');
        if (!mrJson.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', mrJson.error!, 'mintRedeemerJson');
        parsedMintRedeemer = mrJson.parsed;
      }
    } else if (mintingPolicyScript || mintRedeemerJson) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'mintingPolicyScript / mintRedeemerJson require mintActionsJson', 'mintActionsJson');
    }

    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, scriptTxHash, scriptOutputIndex },
        'Building Plutus spending transaction'
      );

      // Apply script parameters if provided (for parameterized validators)
      let finalValidatorScript = validatorScript;
      if (scriptParams && scriptParams.length > 0) {
        finalValidatorScript = applyScriptParameters(validatorScript, scriptParams);
      }

      // FR-1: when the mint policy is byte-equal to the validator (multi-purpose script),
      // re-use the script-params-applied validator hex. Otherwise pass the policy through unchanged.
      let finalMintingPolicyScript: string | undefined;
      if (parsedMintActions) {
        finalMintingPolicyScript = (mintingPolicyScript === validatorScript)
          ? finalValidatorScript
          : mintingPolicyScript;

        if (finalMintingPolicyScript && scriptParams && scriptParams.length > 0 && mintingPolicyScript === validatorScript) {
          const appliedPolicyId = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex')).hash.toString();
          for (const action of parsedMintActions) {
            if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
              action.assetUnit = appliedPolicyId + action.assetUnit;
            }
          }
        }
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
        inlineDatum,
        forceInputs,
        referenceInputs,
        extraOutputs,
        mintActions: parsedMintActions,
        mintingPolicyScript: finalMintingPolicyScript,
        mintRedeemer: parsedMintRedeemer
      };
      delete cleanData.requiredSignersJson;
      delete cleanData.scriptParamsJson;
      delete cleanData.inlineDatumJson;
      delete cleanData.lockOnScript;
      delete cleanData.forceInputsJson;
      delete cleanData.referenceInputsJson;
      delete cleanData.extraOutputsJson;
      delete cleanData.mintActionsJson;
      delete cleanData.mintRedeemerJson;

      // lockOnScript: route continuing output to enterprise script address
      if (lockOnScript && scriptParams && scriptParams.length > 0) {
        const appliedScript = Script.fromCbor(Buffer.from(finalValidatorScript, 'hex'));
        const derivedScriptHash = appliedScript.hash.toString();
        const scriptAddr = scriptHashToEnterpriseAddress(derivedScriptHash, getCardanoClient().network);
        cleanData.recipientAddress = scriptAddr;
        logger.debug({ scriptAddress: scriptAddr, scriptHash: derivedScriptHash }, 'lockOnScript: routing continuing output to script address');
      }

      const buildResult = await getCardanoIndexer().indexPlutusSpendBuildResult(db, cleanData);

      // lockOnScript: persist the derived script address on the build record (only when scriptParams were applied)
      if (lockOnScript && scriptParams && scriptParams.length > 0 && buildResult.scriptHash && buildResult.id) {
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
      if (!existing) return rejectInvalid(req, 'GetBuildDetails', 'Build not found', 'buildId');
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

    // Fetch UTxOs and validate before entering handleRequest (req.reject inside handleRequest gets wrapped as 500)
    const utxos = await getCardanoClient().getAddressUtxos(address);

    if (utxos.length === 0) {
      return req.reject(400, 'SetCollateral: No UTxOs found at address');
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
      return req.reject(400, `SetCollateral: Insufficient funds — need at least ${Number(COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) / 1_000_000} ADA, have ${Number(totalLovelace) / 1_000_000} ADA`);
    }

    // Build self-send transaction: address → address, 5 ADA
    logger.debug({ address, existingQualifying: qualifyingUtxos.length }, 'Building collateral setup transaction');
    return handleRequest(req, async (db) => {
      const result = await getCardanoIndexer().indexSimpleBuildResult(db, {
        network: getCardanoClient().network,
        senderAddress: address,
        recipientAddress: address,
        lovelaceAmount: Number(COLLATERAL_LOVELACE),
        changeAddress: address,
      });
      return { ...result, collateralAvailable: false };
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
      if (!existing) return rejectInvalid(req, 'SubmitTransaction', 'Build not found', 'buildId');

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

        // Invalidate sender address cache so next read fetches fresh data
        const addrBuild = await db.run(
          SELECT.one.from(AddressTransactionBuilds).where({ txBuild_id: buildId })
        );
        if (addrBuild?.address_address) {
          await db.run(DELETE_FROM.from(Addresses).where({ address: addrBuild.address_address }));
          await db.run(DELETE_FROM.from(AddressUTxOs).where({ address_address: addrBuild.address_address }));
          await db.run(DELETE_FROM.from(AddressAssets).where({ address_address: addrBuild.address_address }));
          logger.debug(`Invalidated cache for sender address ${addrBuild.address_address.substring(0, 20)}...`);
        }
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
    logger.debug('SubmitSignedTransaction Action handler called');
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
      if (!submission) return rejectInvalid(req, 'CheckSubmissionStatus', 'Submission not found', 'submissionId');

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
      } catch (err: any) {
        if (err instanceof NotFoundError || err?.statusCode === 404) {
          // Transaction genuinely not yet confirmed on chain
          logger.debug({ submissionId, txHash: submission.txHash }, 'Transaction not yet confirmed on chain');
        } else {
          // Provider error — don't mask as "pending", let caller know
          logger.warn({ submissionId, txHash: submission.txHash, error: err.message }, 'Failed to check transaction confirmation status');
          throw err;
        }
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
    if (!address) return rejectMissing(req, 'GetTransactionBuildsByAddress', 'address');
    if (!isValidBech32Address(address)) return rejectInvalid(req, 'GetTransactionBuildsByAddress', 'Invalid bech32 address format', 'address');
    // Fetch the address-build associations
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressTransactionBuilds).where({ address_address: address }));
    });
  });

  /**
   * Derive the enterprise script address + script hash for a validator script,
   * optionally after applying PlutusData parameters. No transaction is built.
   */
  srv.on('DeriveScriptAddress', async (req: Request) => {
    const { validatorScript, scriptParamsJson, network } = req.data;

    if (!validatorScript) return rejectMissing(req, 'DeriveScriptAddress', 'validatorScript');
    if (typeof validatorScript !== 'string' || !/^[0-9a-fA-F]+$/.test(validatorScript) || validatorScript.length % 2 !== 0) {
      return rejectInvalid(req, 'DeriveScriptAddress', 'validatorScript must be an even-length hex string', 'validatorScript');
    }

    let scriptParams: any[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'DeriveScriptAddress', jsonResult.error!, 'scriptParamsJson');
      if (!Array.isArray(jsonResult.parsed)) {
        return rejectInvalid(req, 'DeriveScriptAddress', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
      scriptParams = jsonResult.parsed as any[];
    }

    let targetNetwork: DeriveNetwork;
    if (network) {
      if (!VALID_DERIVE_NETWORKS.includes(network as DeriveNetwork)) {
        return rejectInvalid(req, 'DeriveScriptAddress', `Invalid network "${network}". Must be one of: ${VALID_DERIVE_NETWORKS.join(', ')}`, 'network');
      }
      targetNetwork = network as DeriveNetwork;
    } else {
      targetNetwork = getCardanoClient().network as DeriveNetwork;
    }

    try {
      const finalScript = scriptParams && scriptParams.length > 0
        ? applyScriptParameters(validatorScript, scriptParams)
        : validatorScript;
      const scriptHash = Script.fromCbor(Buffer.from(finalScript, 'hex')).hash.toString();
      const scriptAddress = scriptHashToEnterpriseAddress(scriptHash, targetNetwork);
      return { scriptAddress, scriptHash };
    } catch (err: any) {
      return rejectInvalid(req, 'DeriveScriptAddress', `Failed to derive script address: ${err.message}`, 'validatorScript');
    }
  });

  /**
   * Extract the 28-byte payment credential (key hash or script hash) from a Bech32
   * Cardano address. Pure local decoding — no blockchain call.
   */
  srv.on('ExtractPaymentKeyHash', async (req: Request) => {
    const { address } = req.data;

    if (!address) return rejectMissing(req, 'ExtractPaymentKeyHash', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Invalid bech32 address format', 'address');
    }

    try {
      const decoded = bech32.decode(address, BECH32_MAX_LENGTH);
      const bytes = Buffer.from(bech32.fromWords(decoded.words));
      // Cardano address: 1 header byte + 28-byte payment credential + (optional 28-byte stake credential)
      if (bytes.length < 29) {
        return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Address is too short to contain a payment credential', 'address');
      }
      const paymentKeyHash = bytes.slice(1, 29).toString('hex');
      return { paymentKeyHash };
    } catch (err: any) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', `Failed to decode address: ${err.message}`, 'address');
    }
  });

};