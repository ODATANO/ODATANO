import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { BackendError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { validateJsonWithLimits, isAssetUnit } from '../../utils/validators';
import { parseUtxoRefArray, parseRequiredSigners, parseAssetsArray, parseExtraOutputs, parseMintActionPolicyFields } from '../../utils/tx-request-parsers';
import { applyScriptParameters } from '../../utils/tx-build-helper';
import { scriptHashToEnterpriseAddress } from '../../utils/mappers';
import { MIN_FULL_ASSET_UNIT_LENGTH } from '../../utils/const';
import type { JSONValue, MintAction, TxBuildRequest } from '../../utils/types';
import type { Network } from '../cardano-client';
import type { WalletJobKindValue } from './job-store';

/**
 * Transform a stored wallet-job `requestJson` (the documented Build*-action
 * payload shape — assetsJson, mintActionsJson, metadataJson strings, …) into
 * the TxBuildRequest shape the CardanoIndexer build methods expect (assets,
 * mintActions with bigint quantities, parsed metadata, assembled
 * plutusScriptExecution, …).
 *
 * The synchronous CardanoTransactionService handlers do this transformation
 * inline per action; the worker executes the SAME payload asynchronously, so
 * this module mirrors that logic using the shared parsers
 * (srv/utils/tx-request-parsers.ts). Validation failures throw
 * BackendError 400 INVALID_INPUT — deterministic, so the job fails terminally
 * instead of burning retries.
 */

type RawRequest = Record<string, unknown>;

function fail(message: string): never {
  throw new BackendError(message, 400, ERROR_CODES.INVALID_INPUT);
}

/**
 * Presence-only check for required payload fields. Format validation (bech32,
 * hex, amounts) deliberately stays with the builder/indexer, mirroring what a
 * missing field would produce on the synchronous path — the transform's job is
 * the SHAPE, not re-validating content.
 */
function requirePresent(raw: RawRequest, required: string[]): void {
  const missing = required.filter((f) => raw[f] === undefined || raw[f] === null || raw[f] === '');
  if (missing.length > 0) fail(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
}

function parseJsonField(raw: RawRequest, field: string): JSONValue | undefined {
  const value = raw[field];
  if (value == null) return undefined;
  if (typeof value !== 'string') fail(`${field} must be a JSON string`);
  const result = validateJsonWithLimits(value, field);
  if (!result.valid) fail(result.error!);
  return result.parsed as JSONValue;
}

function parseScriptParams(raw: RawRequest): JSONValue[] | undefined {
  const parsed = parseJsonField(raw, 'scriptParamsJson');
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) fail('scriptParamsJson must be a JSON array');
  return parsed;
}

/** Mirrors the BuildMint/BuildPlutusSpend mint-action parsing (bigint quantities,
 * multi-policy per-action fields). */
function parseMintActions(raw: RawRequest, allowBareNames: boolean): MintAction[] {
  const parsed = parseJsonField(raw, 'mintActionsJson');
  if (!Array.isArray(parsed)) fail('mintActionsJson must be a JSON array');
  return parsed.map((rawAction: unknown, i: number) => {
    if (!rawAction || typeof rawAction !== 'object') {
      fail('Each mint action must be an object with assetUnit and quantity');
    }
    const action = rawAction as Record<string, unknown>;
    if (typeof action.quantity !== 'string' || !/^-?\d+$/.test(action.quantity)) {
      fail(`Invalid quantity: "${String(action.quantity)}" — must be an integer string`);
    }
    if (typeof action.assetUnit !== 'string') fail('Each mint action must have an assetUnit string');
    // Multi-policy mint FR: optional per-action mintingPolicyScript + redeemerJson.
    const policyFields = parseMintActionPolicyFields(action, i);
    if (policyFields.error) fail(policyFields.error);
    let actionPolicyId: string | undefined;
    if (policyFields.script) {
      actionPolicyId = scriptHashOf(policyFields.script, `mintActions[${i}].mintingPolicyScript is not a valid Plutus script`);
    }
    const bareAssetNameForExpansion =
      (allowBareNames || !!actionPolicyId) &&
      action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH &&
      action.assetUnit.length % 2 === 0 &&
      /^[0-9a-fA-F]*$/.test(action.assetUnit);
    if (!isAssetUnit(action.assetUnit) && !bareAssetNameForExpansion) {
      fail(`Invalid assetUnit: "${action.assetUnit}" — must be policyId+assetName hex (or a bare assetName hex when scriptParamsJson or a per-action mintingPolicyScript is set)`);
    }
    let assetUnit = action.assetUnit as string;
    if (actionPolicyId) {
      if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
        assetUnit = actionPolicyId + assetUnit;
      } else if (!assetUnit.toLowerCase().startsWith(actionPolicyId)) {
        fail(`mintActions[${i}].assetUnit "${assetUnit}" does not start with its own policy id ${actionPolicyId}`);
      }
    }
    return {
      assetUnit,
      quantity: BigInt(action.quantity as string),
      ...(typeof action.redeemer === 'number' ? { redeemer: action.redeemer } : {}),
      ...(policyFields.script ? { mintingPolicyScript: policyFields.script } : {}),
      ...(policyFields.redeemer !== undefined ? { redeemerJson: policyFields.redeemer } : {})
    };
  });
}

function scriptHashOf(scriptHex: string, context: string): string {
  try {
    return Script.fromCbor(Buffer.from(scriptHex, 'hex')).hash.toString();
  } catch (err: unknown) {
    return fail(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * BUG 9 mirror: every (expanded) mint action must carry the effective policy id —
 * parseAssetUnit silently discards the first 56 hex chars, so a mismatched prefix
 * would mint a truncated asset name.
 */
function assertPolicyPrefix(actions: Array<{ assetUnit: string; mintingPolicyScript?: string }>, policyId: string): void {
  // Actions with their own per-action script were already checked against THAT
  // script's policy id during parsing.
  const mismatch = actions.find((a) => !a.mintingPolicyScript && !a.assetUnit.toLowerCase().startsWith(policyId));
  if (mismatch) {
    fail(`assetUnit "${mismatch.assetUnit}" does not start with the minting policy id ${policyId} — pass the full unit as policyId+assetName (asset names longer than 28 bytes cannot be passed bare)`);
  }
}

function takeParsed<T>(result: { parsed?: T; error?: string }): T | undefined {
  if (result.error) fail(result.error);
  return result.parsed;
}

function prepareSimpleAda(raw: RawRequest, network: Network): TxBuildRequest {
  requirePresent(raw, ['senderAddress', 'recipientAddress', 'lovelaceAmount']);

  const clean: RawRequest = { ...raw };
  clean.forceInputs = takeParsed(parseUtxoRefArray(raw.forceInputsJson as string | undefined, 'forceInputsJson'));
  delete clean.forceInputsJson;

  const outputDatum = parseJsonField(raw, 'outputDatumJson');
  if (outputDatum !== undefined) clean.outputDatum = outputDatum;
  delete clean.outputDatumJson;

  const assets = takeParsed(parseAssetsArray(raw.assetsJson as string | undefined, 'assetsJson'));
  if (assets) clean.assets = assets;
  delete clean.assetsJson;

  const scriptParams = parseScriptParams(raw);
  if (raw.lockOnScript) {
    const validatorScript = raw.validatorScript;
    if (typeof validatorScript !== 'string' || !validatorScript) {
      fail('lockOnScript requires validatorScript to derive the script address');
    }
    const finalScript = scriptParams && scriptParams.length > 0
      ? applyScriptParameters(validatorScript, scriptParams)
      : validatorScript;
    clean.recipientAddress = scriptHashToEnterpriseAddress(
      scriptHashOf(finalScript, 'Failed to derive script address'), network);
  }
  delete clean.validatorScript;
  delete clean.scriptParamsJson;
  delete clean.lockOnScript;

  if (raw.referenceScriptHex) clean.referenceScript = raw.referenceScriptHex;
  delete clean.referenceScriptHex;

  return clean as TxBuildRequest;
}

function prepareMetadata(raw: RawRequest): TxBuildRequest {
  requirePresent(raw, ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']);
  const parsedMetadata = parseJsonField(raw, 'metadataJson');
  return { ...raw, metadataJson: parsedMetadata } as TxBuildRequest;
}

function prepareMultiAsset(raw: RawRequest): TxBuildRequest {
  requirePresent(raw, ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']);

  const assets = takeParsed(parseAssetsArray(raw.assetsJson as string | undefined, 'assetsJson'));
  if (!assets || assets.length === 0) fail('assetsJson must contain at least one asset');

  const clean: RawRequest = { ...raw, assets };
  delete clean.assetsJson;

  const outputDatum = parseJsonField(raw, 'outputDatumJson');
  if (outputDatum !== undefined) clean.outputDatum = outputDatum;
  delete clean.outputDatumJson;

  if (raw.referenceScriptHex) clean.referenceScript = raw.referenceScriptHex;
  delete clean.referenceScriptHex;

  return clean as TxBuildRequest;
}

function prepareMint(raw: RawRequest, network: Network): TxBuildRequest {
  requirePresent(raw, ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'mintActionsJson', 'mintingPolicyScript']);

  const scriptParams = parseScriptParams(raw);
  const mintActions = parseMintActions(raw, !!scriptParams);
  const requiredSigners = takeParsed(parseRequiredSigners(raw.requiredSignersJson as string | undefined));
  const inlineDatum = parseJsonField(raw, 'inlineDatumJson');
  const mintRedeemer = parseJsonField(raw, 'mintRedeemerJson');
  const forceInputs = takeParsed(parseUtxoRefArray(raw.forceInputsJson as string | undefined, 'forceInputsJson'));
  const referenceInputs = takeParsed(parseUtxoRefArray(raw.referenceInputsJson as string | undefined, 'referenceInputsJson'));
  const extraOutputs = takeParsed(parseExtraOutputs(raw.extraOutputsJson as string | undefined));

  if (raw.lockOnScript && (!scriptParams || scriptParams.length === 0)) {
    fail('lockOnScript requires scriptParamsJson to derive script address');
  }

  let parsedMetadata: JSONValue | undefined;
  if (raw.metadataJson) {
    parsedMetadata = parseJsonField(raw, 'metadataJson');
    if (typeof parsedMetadata !== 'object' || parsedMetadata === null || Array.isArray(parsedMetadata)) {
      fail('metadataJson must be an object with numeric label keys');
    }
  }

  const clean: RawRequest = { ...raw };
  delete clean.mintActionsJson;
  delete clean.requiredSignersJson;
  delete clean.scriptParamsJson;
  delete clean.inlineDatumJson;
  delete clean.mintRedeemerJson;
  delete clean.lockOnScript;
  delete clean.forceInputsJson;
  delete clean.referenceInputsJson;
  delete clean.extraOutputsJson;
  if (parsedMetadata) clean.metadataJson = parsedMetadata; else delete clean.metadataJson;

  if (raw.referenceScriptHex) clean.referenceScript = raw.referenceScriptHex;
  delete clean.referenceScriptHex;

  // Apply script parameters (parameterized policies), expand bare asset names,
  // route lockOnScript output — mirrors BuildMintTransaction.
  let finalMintingPolicyScript = raw.mintingPolicyScript as string;
  let effectivePolicyId: string | undefined;
  if (scriptParams && scriptParams.length > 0) {
    try {
      finalMintingPolicyScript = applyScriptParameters(raw.mintingPolicyScript as string, scriptParams);
    } catch (err: unknown) {
      fail(`Failed to apply script parameters: ${err instanceof Error ? err.message : String(err)}`);
    }
    effectivePolicyId = scriptHashOf(finalMintingPolicyScript, 'Failed to hash applied script');
    for (const action of mintActions) {
      if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
        action.assetUnit = effectivePolicyId + action.assetUnit;
      }
    }
    if (raw.lockOnScript) {
      clean.recipientAddress = scriptHashToEnterpriseAddress(effectivePolicyId, network);
    }
  } else {
    try {
      effectivePolicyId = Script.fromCbor(Buffer.from(raw.mintingPolicyScript as string, 'hex')).hash.toString();
    } catch {
      // invalid script CBOR — skip the prefix check; the builder rejects it with its own message
    }
  }
  if (effectivePolicyId) assertPolicyPrefix(mintActions, effectivePolicyId);

  return {
    ...clean,
    mintActions,
    mintingPolicyScript: finalMintingPolicyScript,
    requiredSigners,
    inlineDatum,
    mintRedeemer,
    forceInputs,
    referenceInputs,
    extraOutputs,
  } as TxBuildRequest;
}

function preparePlutusSpend(raw: RawRequest, network: Network): TxBuildRequest {
  requirePresent(raw, ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'validatorScript', 'scriptTxHash', 'redeemerJson']);
  if (raw.scriptOutputIndex === undefined || raw.scriptOutputIndex === null) {
    fail('scriptOutputIndex is required');
  }

  const parsedRedeemer = parseJsonField(raw, 'redeemerJson');
  const parsedDatum = parseJsonField(raw, 'datumJson');
  const requiredSigners = takeParsed(parseRequiredSigners(raw.requiredSignersJson as string | undefined));
  const scriptParams = parseScriptParams(raw);
  const inlineDatum = parseJsonField(raw, 'inlineDatumJson');
  if (raw.lockOnScript && (!scriptParams || scriptParams.length === 0)) {
    fail('lockOnScript requires scriptParamsJson to derive script address');
  }
  const forceInputs = takeParsed(parseUtxoRefArray(raw.forceInputsJson as string | undefined, 'forceInputsJson'));
  const referenceInputs = takeParsed(parseUtxoRefArray(raw.referenceInputsJson as string | undefined, 'referenceInputsJson'));
  const extraOutputs = takeParsed(parseExtraOutputs(raw.extraOutputsJson as string | undefined));

  // Optional combined spend+mint (FR-1) — mirrors BuildPlutusSpendTransaction.
  const validatorScript = raw.validatorScript as string;
  const mintingPolicyScript = raw.mintingPolicyScript as string | undefined;
  let mintActions: Array<{ assetUnit: string; quantity: bigint }> | undefined;
  let mintRedeemer: JSONValue | undefined;
  if (raw.mintActionsJson) {
    if (!mintingPolicyScript) fail('mintActionsJson requires mintingPolicyScript');
    mintActions = parseMintActions(raw, !!scriptParams && mintingPolicyScript === validatorScript);
    mintRedeemer = parseJsonField(raw, 'mintRedeemerJson');
  } else if (mintingPolicyScript || raw.mintRedeemerJson) {
    fail('mintingPolicyScript / mintRedeemerJson require mintActionsJson');
  }

  let finalValidatorScript = validatorScript;
  if (scriptParams && scriptParams.length > 0) {
    try {
      finalValidatorScript = applyScriptParameters(validatorScript, scriptParams);
    } catch (err: unknown) {
      fail(`Failed to apply script parameters: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let finalMintingPolicyScript: string | undefined;
  if (mintActions) {
    finalMintingPolicyScript = (mintingPolicyScript === validatorScript) ? finalValidatorScript : mintingPolicyScript;
    if (finalMintingPolicyScript && scriptParams && scriptParams.length > 0 && mintingPolicyScript === validatorScript) {
      const appliedPolicyId = scriptHashOf(finalMintingPolicyScript, 'Failed to hash applied script');
      for (const action of mintActions) {
        if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) {
          action.assetUnit = appliedPolicyId + action.assetUnit;
        }
      }
    }
    if (finalMintingPolicyScript) {
      let mintPolicyId: string | undefined;
      try {
        mintPolicyId = Script.fromCbor(Buffer.from(finalMintingPolicyScript, 'hex')).hash.toString();
      } catch {
        // invalid script CBOR — skip the prefix check; the builder rejects it with its own message
      }
      if (mintPolicyId) assertPolicyPrefix(mintActions, mintPolicyId);
    }
  }

  const clean: RawRequest = {
    ...raw,
    plutusScriptExecution: {
      validatorScript: finalValidatorScript,
      scriptUtxo: {
        txHash: raw.scriptTxHash,
        outputIndex: raw.scriptOutputIndex,
      },
      redeemer: parsedRedeemer,
      datum: parsedDatum,
    },
    requiredSigners,
    inlineDatum,
    forceInputs,
    referenceInputs,
    extraOutputs,
    mintActions,
    mintingPolicyScript: finalMintingPolicyScript,
    mintRedeemer,
  };
  if (raw.referenceScriptHex) clean.referenceScript = raw.referenceScriptHex;
  delete clean.requiredSignersJson;
  delete clean.scriptParamsJson;
  delete clean.inlineDatumJson;
  delete clean.forceInputsJson;
  delete clean.referenceInputsJson;
  delete clean.extraOutputsJson;
  delete clean.mintActionsJson;
  delete clean.mintRedeemerJson;
  delete clean.referenceScriptHex;
  delete clean.redeemerJson;
  delete clean.datumJson;

  if (raw.lockOnScript && scriptParams && scriptParams.length > 0) {
    clean.recipientAddress = scriptHashToEnterpriseAddress(
      scriptHashOf(finalValidatorScript, 'Failed to derive script address'), network);
  }
  delete clean.lockOnScript;

  return clean as TxBuildRequest;
}

/**
 * Transform the raw job request (documented Build*-action payload) into the
 * TxBuildRequest the matching CardanoIndexer build method expects. Throws
 * BackendError 400 INVALID_INPUT for malformed payloads (terminal job failure).
 */
export function prepareWorkerBuildRequest(kind: WalletJobKindValue, raw: RawRequest, network: Network): TxBuildRequest {
  switch (kind) {
    case 'simpleAda': return prepareSimpleAda(raw, network);
    case 'metadata': return prepareMetadata(raw);
    case 'multiAsset': return prepareMultiAsset(raw);
    case 'mint': return prepareMint(raw, network);
    case 'plutusSpend': return preparePlutusSpend(raw, network);
    default:
      return fail(`Unsupported job kind "${String(kind)}"`);
  }
}
