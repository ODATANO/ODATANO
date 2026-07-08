import cds, { Request } from '@sap/cds';
import { bech32 } from 'bech32';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors, rejectMissing, NotFoundError } from './utils/errors';
import { validateTransactionInputs, isValidBech32Address, validateJsonWithLimits, isTxHash, isAssetUnit, isValidCbor, validateRequiredSigners } from './utils/validators';
import { getTxHashFromCbor, getLovelace, applyScriptParameters, extractTxCacheTargets } from './utils/tx-build-helper';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { computeCip14Fingerprint, scriptHashToEnterpriseAddress } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import { POLICY_ID_HEX_LENGTH, MIN_FULL_ASSET_UNIT_LENGTH, COLLATERAL_LOVELACE, FEE_BUFFER_LOVELACE, BECH32_MAX_LENGTH } from './utils/const';
import type { JSONValue, TxBuildPlutusSpendRequest } from './utils/types';

const VALID_DERIVE_NETWORKS = ['mainnet', 'preview', 'preprod'] as const;
type DeriveNetwork = typeof VALID_DERIVE_NETWORKS[number];
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoTxService');

/**
 * Parse and validate a JSON array of UTxO refs ({txHash, outputIndex}) — the shared
 * shape of forceInputsJson and referenceInputsJson (CIP-31). Returns { parsed } on
 * success (undefined for absent/empty input → treated as no-op) or { error } on
 * validation failure. Error messages reference the entry name derived from fieldName.
 */
function parseUtxoRefArray(
  json: string | undefined,
  fieldName: 'forceInputsJson' | 'referenceInputsJson'
): { parsed?: Array<{ txHash: string; outputIndex: number }>; error?: string } {
  if (!json) return { parsed: undefined };
  const entryName = fieldName.replace(/Json$/, '');
  const jsonResult = validateJsonWithLimits(json, fieldName);
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: `${fieldName} must be a JSON array` };
  if (jsonResult.parsed.length === 0) return { parsed: undefined };
  const refs: Array<{ txHash: string; outputIndex: number }> = [];
  for (const rawEntry of jsonResult.parsed) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      return { error: `Each ${entryName} entry must be an object with txHash and outputIndex` };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.txHash !== 'string' || !isTxHash(entry.txHash)) {
      return { error: `Each ${entryName} entry must have a valid 64-hex txHash` };
    }
    const idx = entry.outputIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      return { error: `Each ${entryName} entry must have a non-negative integer outputIndex` };
    }
    refs.push({ txHash: entry.txHash, outputIndex: idx });
  }
  return { parsed: refs };
}

/**
 * Parse and validate requiredSignersJson (array of 56-hex Ed25519 key hashes).
 * Same result contract as the other parse* helpers.
 */
function parseRequiredSigners(
  requiredSignersJson: string | undefined
): { parsed?: string[]; error?: string } {
  if (!requiredSignersJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(requiredSignersJson, 'requiredSignersJson');
  if (!jsonResult.valid) return { error: jsonResult.error! };
  try {
    return { parsed: validateRequiredSigners(jsonResult.parsed) };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse and validate an assetsJson array ({unit, quantity} entries) with the same
 * per-entry strictness as parseExtraOutputs — unchecked entries previously flowed
 * into the builder and surfaced as 500s.
 */
function parseAssetsArray(
  assetsJson: string | undefined,
  fieldName: string
): { parsed?: Array<{ unit: string; quantity: string }>; error?: string } {
  if (!assetsJson) return { parsed: undefined };
  const jsonResult = validateJsonWithLimits(assetsJson, fieldName);
  if (!jsonResult.valid) return { error: jsonResult.error! };
  if (!Array.isArray(jsonResult.parsed)) return { error: `${fieldName} must be a JSON array` };
  const out: Array<{ unit: string; quantity: string }> = [];
  for (let i = 0; i < jsonResult.parsed.length; i++) {
    const a = jsonResult.parsed[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object') {
      return { error: `${fieldName}[${i}] must be an object` };
    }
    if (typeof a.unit !== 'string' || a.unit.toLowerCase() === 'lovelace' || !isAssetUnit(a.unit)) {
      return { error: `${fieldName}[${i}].unit must be a valid asset unit (policyId + assetName hex)` };
    }
    if (typeof a.quantity !== 'string' || !/^\d+$/.test(a.quantity) || a.quantity === '0') {
      return { error: `${fieldName}[${i}].quantity must be a positive integer string` };
    }
    out.push({ unit: a.unit, quantity: a.quantity });
  }
  return { parsed: out };
}

/** Upper bound on extra outputs per transaction (defence against tx-size blow-up). */
const MAX_EXTRA_OUTPUTS = 32;

export interface ParsedExtraOutput {
  address: string;
  lovelaceAmount: string;
  assets?: Array<{ unit: string; quantity: string }>;
  inlineDatum?: JSONValue;
  referenceScript?: string;
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
    const entry = jsonResult.parsed[i] as Record<string, unknown>;
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
        const a = entry.assets[j] as Record<string, unknown>;
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

    let referenceScript: string | undefined;
    if (entry.referenceScriptHex !== undefined && entry.referenceScriptHex !== null) {
      if (typeof entry.referenceScriptHex !== 'string' || !isValidCbor(entry.referenceScriptHex)) {
        return { error: `extraOutputs[${i}].referenceScriptHex must be even-length hex` };
      }
      referenceScript = entry.referenceScriptHex;
    }

    out.push({ address: entry.address, lovelaceAmount: entry.lovelaceAmount, assets, inlineDatum, referenceScript });
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

  /**
   * Build a simple ADA-only transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, outputDatumJson, assetsJson, forceInputsJson, validatorScript, scriptParamsJson, lockOnScript, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    // validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount']
    );
    throwIfValidationErrors(req, 'BuildSimpleAdaTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildSimpleAdaTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // parse optional output datum
    const cleanData = { ...req.data };

    // parse optional forceInputsJson
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

    // parse optional assets JSON (for locking native assets at script addresses)
    const assetsResult = parseAssetsArray(assetsJson, 'assetsJson');
    if (assetsResult.error) return rejectInvalid(req, 'BuildSimpleAdaTransaction', assetsResult.error, 'assetsJson');
    if (assetsResult.parsed) {
      cleanData.assets = assetsResult.parsed;
      delete cleanData.assetsJson;
    }

    // parse optional scriptParamsJson (for parameterized validators)
    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildSimpleAdaTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
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
    const { senderAddress, recipientAddress, lovelaceAmount, assetsJson, outputDatumJson, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    // validate inputs (includes JSON parsing validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, assetsJson, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']
    );
    throwIfValidationErrors(req, 'BuildMultiAssetTransaction', errors);
    if (req.data.changeAddress && !isValidBech32Address(req.data.changeAddress)) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'Invalid changeAddress format', 'changeAddress');
    }

    // Parse and validate assetsJson entries (unit + quantity, like parseExtraOutputs)
    const assetsResult = parseAssetsArray(assetsJson, 'assetsJson');
    if (assetsResult.error) return rejectInvalid(req, 'BuildMultiAssetTransaction', assetsResult.error, 'assetsJson');
    const parsedAssets = assetsResult.parsed;
    if (!parsedAssets || parsedAssets.length === 0) {
      return rejectInvalid(req, 'BuildMultiAssetTransaction', 'assetsJson must contain at least one asset', 'assetsJson');
    }

    // Validation BEFORE handleRequest (convention) — build the clean request object up front
    const cleanData = { ...req.data };
    delete cleanData.assetsJson;

    // parse optional output datum (for locking assets at script addresses)
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

    // handle the request / building the transaction / indexing the build result / returning build details
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

  /**
   * Build a minting transaction
   * @param req - CDS request object (with senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, changeAddress)
   * @returns {TransactionBuild} Transaction build details
   */
  srv.on('BuildMintTransaction', async (req: Request) => {
    const { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, requiredSignersJson, scriptParamsJson, inlineDatumJson, mintRedeemerJson, lockOnScript, forceInputsJson, referenceInputsJson, referenceScriptHex, metadataJson, validityStartMs, validityEndMs } = req.data;

    // validate inputs (includes JSON and CBOR validation)
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, mintActionsJson, mintingPolicyScript, referenceScriptHex, metadataJson, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'mintActionsJson', 'mintingPolicyScript']
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
      // assetUnit is normally a full policyId+assetName hex. Exception (BUG 7):
      // when scriptParamsJson is provided, a bare assetName (shorter than a full
      // unit) is accepted here and expanded to policyId+assetName once the policy
      // script is parameterized below — mirrors the expansion's own < MIN_FULL_ASSET_UNIT_LENGTH guard.
      const bareAssetNameForExpansion =
        !!scriptParamsJson &&
        typeof action.assetUnit === 'string' &&
        action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH &&
        action.assetUnit.length % 2 === 0 &&
        /^[0-9a-fA-F]*$/.test(action.assetUnit);
      if (typeof action.assetUnit !== 'string' || (!isAssetUnit(action.assetUnit) && !bareAssetNameForExpansion)) {
        return rejectInvalid(req, 'BuildMintTransaction', `Invalid assetUnit: "${action.assetUnit}" — must be policyId+assetName hex (or a bare assetName hex when scriptParamsJson is set)`, 'mintActionsJson');
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
    const requiredSignersResult = parseRequiredSigners(requiredSignersJson);
    if (requiredSignersResult.error) return rejectInvalid(req, 'BuildMintTransaction', requiredSignersResult.error, 'requiredSignersJson');
    const requiredSigners = requiredSignersResult.parsed;

    // Parse and validate optional scriptParamsJson
    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildMintTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // Parse and validate optional inlineDatumJson
    let inlineDatum: JSONValue | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed as JSONValue;
    }

    // Parse and validate optional mintRedeemerJson
    let mintRedeemer: JSONValue | undefined;
    if (mintRedeemerJson) {
      const jsonResult = validateJsonWithLimits(mintRedeemerJson, 'mintRedeemerJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildMintTransaction', jsonResult.error!, 'mintRedeemerJson');
      mintRedeemer = jsonResult.parsed as JSONValue;
    }

    // Validate lockOnScript requires scriptParamsJson
    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildMintTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    // Parse and validate optional forceInputsJson
    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // Parse and validate optional referenceInputsJson (CIP-31)
    const refInputsResult = parseUtxoRefArray(referenceInputsJson, 'referenceInputsJson');
    if (refInputsResult.error) return rejectInvalid(req, 'BuildMintTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    // Parse and validate optional metadataJson (auxiliary_data on the mint tx).
    // validateTransactionInputs has already JSON-validated the string; re-parse here
    // and enforce the label-object shape that the builder's metadata mapper expects.
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

    // handle the request / building the transaction / indexing the build result / returning build details
    return handleRequest(req, async (db) => {
      logger.debug(
        { senderAddress, recipientAddress, lovelaceAmount, mintActions: parsedMintActions, forceInputs: forceInputs?.length ?? 0, referenceInputs: referenceInputs?.length ?? 0, hasMetadata: !!parsedMetadata },
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
      if (parsedMetadata) {
        cleanData.metadataJson = parsedMetadata;
      } else {
        delete cleanData.metadataJson;
      }

      if (referenceScriptHex) {
        cleanData.referenceScript = referenceScriptHex;
      }
      delete cleanData.referenceScriptHex;

      // Apply script parameters if provided (for parameterized validators)
      let finalMintingPolicyScript = mintingPolicyScript;
      let effectivePolicyId: string | undefined;
      if (scriptParams && scriptParams.length > 0) {
        try {
          finalMintingPolicyScript = applyScriptParameters(mintingPolicyScript, scriptParams);

          // BUG 7 fix: expand assetName-only entries to full assetUnit using the applied script's policyId.
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

        // lockOnScript: route output to the enterprise script address derived from applied script hash
        if (lockOnScript) {
          const scriptAddr = scriptHashToEnterpriseAddress(effectivePolicyId, getCardanoClient().network);
          cleanData.recipientAddress = scriptAddr;
          logger.debug({ scriptAddress: scriptAddr, scriptHash: effectivePolicyId }, 'lockOnScript: routing output to script address');
        }
      } else {
        try {
          effectivePolicyId = Script.fromCbor(Buffer.from(mintingPolicyScript, 'hex')).hash.toString();
        } catch {
          // invalid script CBOR — skip the prefix check; the builder rejects it with its own message
        }
      }

      // BUG 9 fix: the builder mints every action under the policy script's hash and
      // parseAssetUnit silently discards the unit's first 56 hex chars. A bare asset name
      // of 29-32 bytes is length-indistinguishable from a full unit, so a mismatched
      // prefix would mint a truncated name. At this point every action holds a full
      // unit (bare names were expanded above), so all of them must carry the policyId.
      if (effectivePolicyId) {
        const policyId = effectivePolicyId;
        const mismatch = parsedMintActions.find(
          (action) => !action.assetUnit.toLowerCase().startsWith(policyId)
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
        referenceInputs
      });

      // Post-build: compute CIP-14 fingerprint and scriptAddress
      if (buildResult.scriptHash) {
        const policyId = buildResult.scriptHash;
        const updates: Record<string, string> = {};

        // CIP-14 asset fingerprint for the first minted asset. The unit is always a
        // full policyId+assetName here: bare names were expanded before the build and
        // the BUG 9 prefix check rejected everything else (a 56-hex unit is an empty
        // asset name, not a bare 28-byte name).
        if (parsedMintActions.length > 0) {
          const firstAssetUnit = parsedMintActions[0].assetUnit;
          const assetNameHex = firstAssetUnit.slice(POLICY_ID_HEX_LENGTH);
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
    const { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, requiredSignersJson, scriptParamsJson, inlineDatumJson, lockOnScript, forceInputsJson, extraOutputsJson, mintActionsJson, mintingPolicyScript, mintRedeemerJson, referenceInputsJson, referenceScriptHex, validityStartMs, validityEndMs } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs(
      { senderAddress, recipientAddress, lovelaceAmount, validatorScript, scriptTxHash, scriptOutputIndex, redeemerJson, datumJson, referenceScriptHex, validityStartMs, validityEndMs },
      ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'validatorScript', 'scriptTxHash', 'redeemerJson']
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
    const requiredSignersResult = parseRequiredSigners(requiredSignersJson);
    if (requiredSignersResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', requiredSignersResult.error, 'requiredSignersJson');
    const requiredSigners = requiredSignersResult.parsed;

    // Parse and validate optional scriptParamsJson
    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validateJsonWithLimits(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'scriptParamsJson');
      scriptParams = jsonResult.parsed as JSONValue[];
      if (!Array.isArray(scriptParams)) {
        return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
    }

    // Parse and validate optional inlineDatumJson
    let inlineDatum: JSONValue | undefined;
    if (inlineDatumJson) {
      const jsonResult = validateJsonWithLimits(inlineDatumJson, 'inlineDatumJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'BuildPlutusSpendTransaction', jsonResult.error!, 'inlineDatumJson');
      inlineDatum = jsonResult.parsed as JSONValue;
    }

    // Validate lockOnScript requires scriptParamsJson
    if (lockOnScript && (!scriptParams || scriptParams.length === 0)) {
      return rejectInvalid(req, 'BuildPlutusSpendTransaction', 'lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }

    // Parse and validate optional forceInputsJson
    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', forceInputsResult.error, 'forceInputsJson');
    const forceInputs = forceInputsResult.parsed;

    // Parse and validate optional referenceInputsJson (CIP-31)
    const refInputsResult = parseUtxoRefArray(referenceInputsJson, 'referenceInputsJson');
    if (refInputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', refInputsResult.error, 'referenceInputsJson');
    const referenceInputs = refInputsResult.parsed;

    // Parse and validate optional extraOutputsJson
    const extraOutputsResult = parseExtraOutputs(extraOutputsJson);
    if (extraOutputsResult.error) return rejectInvalid(req, 'BuildPlutusSpendTransaction', extraOutputsResult.error, 'extraOutputsJson');
    const extraOutputs = extraOutputsResult.parsed;

    // FR-1: Optional combined spend+mint parameters. mintActionsJson triggers the combined flow;
    // mintingPolicyScript is required alongside it. mintRedeemerJson is optional.
    let parsedMintActions: Array<{ assetUnit: string; quantity: bigint }> | undefined;
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
      parsedMintActions = mintJson.parsed.map((rawAction: unknown) => {
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
        // same rule as BuildMintTransaction: full policyId+assetName unit, OR a bare
        // assetName hex destined for policyId expansion (only possible when the policy
        // is the script-params-applied validator — see expansion below)
        const bareAssetNameForExpansion =
          !!scriptParamsJson &&
          mintingPolicyScript === validatorScript &&
          action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH &&
          action.assetUnit.length % 2 === 0 &&
          /^[0-9a-fA-F]*$/.test(action.assetUnit);
        if (!isAssetUnit(action.assetUnit) && !bareAssetNameForExpansion) {
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Invalid assetUnit: "${action.assetUnit}" — must be policyId+assetName hex (or a bare assetName hex when scriptParamsJson is set and the policy equals the validator)`, 'mintActionsJson');
        }
        return { assetUnit: action.assetUnit, quantity: BigInt(action.quantity) };
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

      // Apply script parameters if provided (for parameterized validators)
      let finalValidatorScript = validatorScript;
      if (scriptParams && scriptParams.length > 0) {
        try {
          finalValidatorScript = applyScriptParameters(validatorScript, scriptParams);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, 'BuildPlutusSpendTransaction', `Failed to apply script parameters: ${errMsg}`, 'scriptParamsJson');
        }
      }

      // FR-1: when the mint policy is byte-equal to the validator (multi-purpose script),
      // re-use the script-params-applied validator hex. Otherwise pass the policy through unchanged.
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

        // BUG 9 fix: same policyId-prefix check as BuildMintTransaction — the builder
        // mints every action under the mint script's hash and parseAssetUnit silently
        // discards the unit's first 56 hex chars, so a mismatched prefix would mint a
        // truncated asset name.
        if (finalMintingPolicyScript) {
          let mintPolicyId: string | undefined;
          try {
            mintPolicyId = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex')).hash.toString();
          } catch {
            // invalid script CBOR — skip the prefix check; the builder rejects it with its own message
          }
          if (mintPolicyId) {
            const policyId = mintPolicyId;
            const mismatch = parsedMintActions.find(
              (action) => !action.assetUnit.toLowerCase().startsWith(policyId)
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

      // lockOnScript: route continuing output to enterprise script address
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
      if (!existing) throw new NotFoundError(`Build '${buildId}'`);
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

    if (!address) return rejectMissing(req, 'SetCollateral', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'SetCollateral', 'Invalid Bech32 address format', 'address');
    }

    return handleRequest(req, async (db) => {
      // Inside handleRequest: getCardanoClient() throwing (e.g. uninitialized after
      // a failed bootstrap → ProviderUnavailableError) and backend errors from
      // getAddressUtxos both get caught and properly mapped via mapError.
      // Use rejectInvalid (throws BackendError 400) instead of req.reject so
      // mapError sees a typed BackendError and preserves the 400 status.
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
      if (!existing) throw new NotFoundError(`Build '${buildId}'`);

      // Verify the signed CBOR is for this build (audit-trail integrity)
      const signedTxHash = getTxHashFromCbor(signedTxCbor);
      if (signedTxHash !== existing.txBodyHash) {
        return rejectInvalid(req, 'SubmitTransaction', `signedTxCbor hash '${signedTxHash}' does not match build txBodyHash '${existing.txBodyHash}'`, 'signedTxCbor');
      }

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

        // Invalidate stale UTxO cache: spent input refs + output addresses from
        // the signed CBOR, plus the build's sender address. Best-effort — a
        // failure here must not fail the already-successful submit.
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

  /**
   * Submit signed transaction without prior build
   * Handler validates, submits to blockchain, delegates persistence to indexer
   * Two-phase: persist with 'pending' first, then update to 'submitted' or 'failed'
   * @param req - CDS request object (with signedTxCbor, network)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    logger.debug('SubmitSignedTransaction Action handler called');
    const { signedTxCbor, network } = req.data;

    // Validate inputs (includes CBOR format validation)
    const errors = validateTransactionInputs({ signedTxCbor }, ['signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitSignedTransaction', errors);

    return handleRequest(req, async (db) => {
      // The declared network param was previously ignored — verify it against the
      // configured network so a caller targeting the wrong deployment gets a clear 400.
      const configuredNetwork = getCardanoClient().network;
      if (network && network !== configuredNetwork) {
        return rejectInvalid(req, 'SubmitSignedTransaction', `network '${network}' does not match this deployment's network '${configuredNetwork}'`, 'network');
      }

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

        // Invalidate stale UTxO cache (spent inputs + output addresses) — best-effort
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
      if (!submission) throw new NotFoundError(`Submission '${submissionId}'`);

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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof NotFoundError || (err as { statusCode?: number })?.statusCode === 404) {
          // Transaction genuinely not yet confirmed on chain
          logger.debug({ submissionId, txHash: submission.txHash }, 'Transaction not yet confirmed on chain');
        } else {
          // Provider error — don't mask as "pending", let caller know
          logger.warn({ submissionId, txHash: submission.txHash, error: errMsg }, 'Failed to check transaction confirmation status');
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
      // getCardanoClient() throws ProviderUnavailableError (503) when the app context
      // is uninitialized. Resolving the network outside the inner CBOR try/catch
      // keeps that 503 distinct from the 400 used for malformed validatorScript bytes.
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
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
      return rejectInvalid(req, 'ExtractPaymentKeyHash', `Failed to decode address: ${errMsg}`, 'address');
    }
  });

};