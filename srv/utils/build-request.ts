import { Script } from '@harmoniclabs/cardano-ledger-ts';
import {
  validateJsonWithLimits, validatePlutusJson, validateTransactionInputs, isValidBech32Address, isAssetUnit,
  PLUTUS_JSON_FIELDS, type TransactionInputs,
} from './validators';
import {
  parseUtxoRefArray, parseRequiredSigners, parseAssetsArray, parseExtraOutputs, parseOutputList,
  parseMintActionPolicyFields, parsePlutusCbor,
} from './tx-request-parsers';
import { applyScriptParameters } from './tx-build-helper';
import { scriptHashToEnterpriseAddress } from './mappers';
import { MIN_FULL_ASSET_UNIT_LENGTH } from './const';
import type { JSONValue, MintAction, TxBuildPlutusRequest, TxBuildPlutusSpendRequest, TxBuildRequest } from './types';
import type { Network } from '../blockchain/cardano-client';

// Turns the parameters of a Build* action, or the stored request of a wallet job, into the request
// the builder takes. The transaction service and the wallet worker share it, so one request is
// checked the same way on both paths. Every check that fails names the field.

type RawRequest = Record<string, unknown>;

/** A prepared request; for lockOnScript also the script hash and address the output goes to. */
export interface PreparedBuild<T> {
  request: T;
  scriptHash?: string;
  scriptAddress?: string;
}

/** What a request that does not pass says: a missing field, or why a field is invalid. */
export interface BuildRequestError {
  error: string;
  field?: string;
  missing?: boolean;
}

export type Prepared<T> = PreparedBuild<T> | BuildRequestError;

/** The network, read only where a script address is derived. */
export type NetworkOf = () => Network;

/** The kinds of build a stored request can be for. */
export type BuildKind = 'simpleAda' | 'metadata' | 'multiAsset' | 'mint' | 'plutusSpend';

class RequestError extends Error {
  constructor(message: string, readonly field?: string, readonly missing = false) {
    super(message);
  }
}

function fail(message: string, field?: string): never {
  throw new RequestError(message, field);
}

function prepared<T>(build: () => PreparedBuild<T>): Prepared<T> {
  try {
    return build();
  } catch (err: unknown) {
    if (err instanceof RequestError) return { error: err.message, field: err.field, ...(err.missing ? { missing: true } : {}) };
    throw err;
  }
}

/** Fields each kind checks for format, and the ones it requires, as the Build* actions declare them. */
const FIELD_CHECKS: Record<BuildKind, { check: (keyof TransactionInputs)[]; required: (keyof TransactionInputs)[] }> = {
  simpleAda: {
    check: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'referenceScriptHex', 'validityStartMs', 'validityEndMs'],
    required: ['senderAddress', 'recipientAddress', 'lovelaceAmount'],
  },
  metadata: {
    check: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson'],
    required: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson'],
  },
  multiAsset: {
    check: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson', 'referenceScriptHex', 'validityStartMs', 'validityEndMs'],
    required: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson'],
  },
  mint: {
    check: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'mintActionsJson', 'mintingPolicyScript', 'referenceScriptHex', 'metadataJson', 'validityStartMs', 'validityEndMs'],
    required: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'mintActionsJson', 'mintingPolicyScript'],
  },
  plutusSpend: {
    check: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'validatorScript', 'scriptTxHash', 'scriptOutputIndex', 'redeemerJson', 'datumJson', 'referenceScriptHex', 'validityStartMs', 'validityEndMs'],
    required: ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'validatorScript', 'scriptTxHash', 'redeemerJson'],
  },
};

function checkFields(kind: BuildKind, raw: RawRequest): void {
  const { check, required } = FIELD_CHECKS[kind];
  checkInputs(raw, check, required);
}

function checkInputs(raw: RawRequest, check: (keyof TransactionInputs)[], required: (keyof TransactionInputs)[]): void {
  const inputs = Object.fromEntries(check.map((f) => [f, raw[f]])) as TransactionInputs;
  const [first] = validateTransactionInputs(inputs, required);
  if (first) throw new RequestError(first.type === 'missing' ? `${first.field} is required` : first.message, first.field, first.type === 'missing');
  if (raw.changeAddress && (typeof raw.changeAddress !== 'string' || !isValidBech32Address(raw.changeAddress))) {
    fail('Invalid changeAddress format', 'changeAddress');
  }
}

function parseJsonField(raw: RawRequest, field: string): JSONValue | undefined {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(`${field} must be a JSON string`, field);
  const result = PLUTUS_JSON_FIELDS.has(field) ? validatePlutusJson(value, field) : validateJsonWithLimits(value, field);
  if (!result.valid) fail(result.error!, field);
  return result.parsed as JSONValue;
}

function parseScriptParams(raw: RawRequest): JSONValue[] | undefined {
  const parsed = parseJsonField(raw, 'scriptParamsJson');
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) fail('scriptParamsJson must be a JSON array', 'scriptParamsJson');
  return parsed;
}

function takeParsed<T>(result: { parsed?: T; error?: string }, field: string): T | undefined {
  if (result.error) fail(result.error, field);
  return result.parsed;
}

function utxoRefs(raw: RawRequest, field: 'forceInputsJson' | 'referenceInputsJson' | 'protectInputsJson') {
  return takeParsed(parseUtxoRefArray(raw[field] as string | undefined, field), field);
}

/** Policy id of a Plutus script given as CBOR hex. Throws the library's error for bytes that are no script. */
export function scriptHashOf(scriptHex: string): string {
  return Script.fromCbor(Buffer.from(scriptHex, 'hex')).hash.toString();
}

function hashOrFail(scriptHex: string, context: string, field: string): string {
  try {
    return scriptHashOf(scriptHex);
  } catch (err: unknown) {
    return fail(`${context}: ${err instanceof Error ? err.message : String(err)}`, field);
  }
}

function applyParams(script: string, params: JSONValue[], field: string): string {
  try {
    return applyScriptParameters(script, params);
  } catch (err: unknown) {
    return fail(`Failed to apply script parameters: ${err instanceof Error ? err.message : String(err)}`, field);
  }
}

// The mint actions of BuildMintTransaction and BuildPlutusSpendTransaction. Units come back in lower
// case, quantities as bigint and never 0; a bare asset name is completed with its policy id where
// `allowBareNames` says the policy is known, or the action carries its own script.
const mintBadUnit = (u: unknown) =>
  `Invalid assetUnit: "${u}": must be policyId+assetName hex (or a bare assetName hex when scriptParamsJson or a per-action mintingPolicyScript is set)`;

/** The texts each action answers with; they are API. */
const MINT_TEXTS = {
  mint: {
    quantityFirst: false,
    noQuantity: () => 'Each mint action must have a string quantity',
    badQuantity: (q: unknown) => `Invalid quantity format: "${q}": must be an integer string`,
    noUnit: mintBadUnit,
    badUnit: mintBadUnit,
  },
  spend: {
    quantityFirst: true,
    noQuantity: (q: unknown) => `Invalid quantity: "${q}": must be an integer string`,
    badQuantity: (q: unknown) => `Invalid quantity: "${q}": must be an integer string`,
    noUnit: (_unit: unknown) => 'Each mint action must have assetUnit string',
    badUnit: (u: unknown) => `Invalid assetUnit: "${u}": must be policyId+assetName hex (or a bare assetName hex when a per-action mintingPolicyScript is set, or scriptParamsJson is set and the policy equals the validator)`,
  },
} as const;

// `texts` names the action whose error texts apply: BuildMintTransaction ('mint') or the combined
// mint of BuildPlutusSpendTransaction ('spend').
export function parseMintActions(raw: RawRequest, allowBareNames: boolean, texts: keyof typeof MINT_TEXTS = 'mint'): MintAction[] {
  const field = 'mintActionsJson';
  const say = MINT_TEXTS[texts];
  const parsed = parseJsonField(raw, field);
  if (!Array.isArray(parsed)) fail('mintActionsJson must be a JSON array', field);
  return parsed.map((rawAction: unknown, i: number) => {
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
      fail('Each mint action must be an object with assetUnit and quantity', field);
    }
    const action = rawAction as Record<string, unknown>;
    // each action checks its fields in the order its Build* action always did, so errors keep their text
    const quantity = (): string => {
      if (typeof action.quantity !== 'string') fail(say.noQuantity(action.quantity), field);
      if (!/^-?\d+$/.test(action.quantity)) fail(say.badQuantity(action.quantity), field);
      return action.quantity;
    };
    if (say.quantityFirst) {
      quantity();
      if (typeof action.assetUnit !== 'string') fail(say.noUnit(action.assetUnit), field);
    }
    // Optional per-action mintingPolicyScript + redeemerJson (multi-policy mint).
    const policyFields = parseMintActionPolicyFields(action, i);
    if (policyFields.error) fail(policyFields.error, field);
    const actionPolicyId = policyFields.script
      ? hashOrFail(policyFields.script, `mintActions[${i}].mintingPolicyScript is not a valid Plutus script`, field)
      : undefined;

    if (typeof action.assetUnit !== 'string') fail(say.noUnit(action.assetUnit), field);
    const given = action.assetUnit;
    const bareName = (allowBareNames || !!actionPolicyId)
      && given.length < MIN_FULL_ASSET_UNIT_LENGTH && given.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(given);
    let assetUnit = given.toLowerCase();
    if (!isAssetUnit(assetUnit) && !bareName) fail(say.badUnit(given), field);
    if (actionPolicyId) {
      if (assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) assetUnit = actionPolicyId + assetUnit;
      else if (!assetUnit.startsWith(actionPolicyId)) {
        fail(`mintActions[${i}].assetUnit "${given}" does not start with its own policy id ${actionPolicyId}`, field);
      }
    }
    const minted = quantity();
    if (BigInt(minted) === 0n) fail(`Invalid quantity: "${minted}": a mint action must mint or burn, zero does neither`, field);
    if (action.redeemer !== undefined && (typeof action.redeemer !== 'number' || !Number.isSafeInteger(action.redeemer))) {
      fail(`mintActions[${i}].redeemer must be an integer`, field);
    }
    return {
      assetUnit,
      quantity: BigInt(minted),
      ...(action.redeemer !== undefined ? { redeemer: action.redeemer as number } : {}),
      ...(policyFields.script ? { mintingPolicyScript: policyFields.script } : {}),
      ...(policyFields.redeemer !== undefined ? { redeemerJson: policyFields.redeemer } : {}),
    };
  });
}

/** Completes bare names with `policyId`, then requires the prefix on every action without its own script. */
function bindToPolicy(actions: MintAction[], policyId: string, completeBareNames: boolean): void {
  if (completeBareNames) {
    for (const action of actions) {
      if (action.assetUnit.length < MIN_FULL_ASSET_UNIT_LENGTH) action.assetUnit = policyId + action.assetUnit;
    }
  }
  // the builder drops the unit's first 56 hex chars, so a wrong prefix would mint a truncated name
  const mismatch = actions.find((a) => !a.mintingPolicyScript && !a.assetUnit.startsWith(policyId));
  if (mismatch) {
    fail(`assetUnit "${mismatch.assetUnit}" does not start with the minting policy id ${policyId}: pass the full unit as policyId+assetName (asset names longer than 28 bytes cannot be passed bare)`, 'mintActionsJson');
  }
}

/** The output datum as JSON or as CBOR, never both. */
function outputDatum(raw: RawRequest, clean: RawRequest): void {
  const json = parseJsonField(raw, 'outputDatumJson');
  delete clean.outputDatumJson;
  delete clean.outputDatumCbor;
  if (json !== undefined) clean.outputDatum = json;
  if (raw.outputDatumCbor === undefined || raw.outputDatumCbor === null) return;
  if (json !== undefined) fail('outputDatumJson and outputDatumCbor exclude each other; pass one', 'outputDatumCbor');
  const cbor = parsePlutusCbor(raw.outputDatumCbor as string, 'outputDatumCbor');
  if (cbor.error) fail(cbor.error, 'outputDatumCbor');
  clean.outputDatumCbor = cbor.hex;
}

function referenceScript(raw: RawRequest, clean: RawRequest): void {
  if (raw.referenceScriptHex) clean.referenceScript = raw.referenceScriptHex;
  delete clean.referenceScriptHex;
}

export function prepareSimpleAdaRequest(raw: RawRequest, network: NetworkOf): Prepared<TxBuildRequest> {
  return prepared(() => {
    checkFields('simpleAda', raw);
    const clean: RawRequest = { ...raw };
    clean.forceInputs = utxoRefs(raw, 'forceInputsJson');
    clean.protectInputs = utxoRefs(raw, 'protectInputsJson');
    delete clean.forceInputsJson;
    delete clean.protectInputsJson;
    outputDatum(raw, clean);
    // native assets to lock at a script address
    const assets = takeParsed(parseAssetsArray(raw.assetsJson as string | undefined, 'assetsJson'), 'assetsJson');
    if (assets) clean.assets = assets;
    delete clean.assetsJson;

    const scriptParams = parseScriptParams(raw);
    if (raw.lockOnScript && !raw.validatorScript) {
      fail('lockOnScript requires validatorScript to derive the script address', 'validatorScript');
    }
    let scriptHash: string | undefined;
    let scriptAddress: string | undefined;
    if (raw.lockOnScript) {
      const validator = String(raw.validatorScript);
      // read first: a server that is not ready answers 503, not a fault of the script
      const net = network();
      try {
        scriptHash = scriptHashOf(scriptParams?.length ? applyScriptParameters(validator, scriptParams) : validator);
        scriptAddress = scriptHashToEnterpriseAddress(scriptHash, net);
      } catch (err: unknown) {
        fail(`Failed to derive script address: ${err instanceof Error ? err.message : String(err)}`, 'validatorScript');
      }
      clean.recipientAddress = scriptAddress;
    }
    delete clean.validatorScript;
    delete clean.scriptParamsJson;
    delete clean.lockOnScript;
    referenceScript(raw, clean);
    return { request: clean as unknown as TxBuildRequest, scriptHash, scriptAddress };
  });
}

export function prepareMetadataRequest(raw: RawRequest): Prepared<TxBuildRequest> {
  return prepared(() => {
    checkFields('metadata', raw);
    return { request: { ...raw, metadataJson: parseJsonField(raw, 'metadataJson') } as unknown as TxBuildRequest };
  });
}

export function prepareMultiAssetRequest(raw: RawRequest): Prepared<TxBuildRequest> {
  return prepared(() => {
    checkFields('multiAsset', raw);
    const assets = takeParsed(parseAssetsArray(raw.assetsJson as string | undefined, 'assetsJson'), 'assetsJson');
    if (!assets || assets.length === 0) fail('assetsJson must contain at least one asset', 'assetsJson');
    const clean: RawRequest = { ...raw, assets };
    delete clean.assetsJson;
    outputDatum(raw, clean);
    referenceScript(raw, clean);
    return { request: clean as unknown as TxBuildRequest };
  });
}

/** metadataJson of a mint: an object with numeric label keys. */
function mintMetadata(raw: RawRequest): JSONValue | undefined {
  const parsed = parseJsonField(raw, 'metadataJson');
  if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    fail('metadataJson must be an object with numeric label keys', 'metadataJson');
  }
  return parsed;
}

export function prepareMintRequest(raw: RawRequest, network: NetworkOf): Prepared<TxBuildRequest> {
  return prepared(() => {
    checkFields('mint', raw);
    const scriptParams = parseScriptParams(raw);
    const mintActions = parseMintActions(raw, !!scriptParams);
    const requiredSigners = takeParsed(parseRequiredSigners(raw.requiredSignersJson as string | undefined), 'requiredSignersJson');
    const inlineDatum = parseJsonField(raw, 'inlineDatumJson');
    const mintRedeemer = parseJsonField(raw, 'mintRedeemerJson');
    if (raw.lockOnScript && !scriptParams?.length) {
      fail('lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }
    // each minted token can sit on its own output with its own inline datum
    const extraOutputs = takeParsed(parseExtraOutputs(raw.extraOutputsJson as string | undefined), 'extraOutputsJson');
    const forceInputs = utxoRefs(raw, 'forceInputsJson');
    const protectInputs = utxoRefs(raw, 'protectInputsJson');
    const referenceInputs = utxoRefs(raw, 'referenceInputsJson');
    const metadata = mintMetadata(raw);

    const clean: RawRequest = { ...raw };
    for (const f of ['mintActionsJson', 'requiredSignersJson', 'scriptParamsJson', 'inlineDatumJson', 'mintRedeemerJson',
      'lockOnScript', 'forceInputsJson', 'protectInputsJson', 'referenceInputsJson', 'extraOutputsJson']) delete clean[f];
    if (metadata !== undefined) clean.metadataJson = metadata; else delete clean.metadataJson;
    referenceScript(raw, clean);

    // A parameterized policy is applied first; bare names take the applied policy id.
    const policyScript = String(raw.mintingPolicyScript);
    let finalPolicyScript = policyScript;
    let scriptAddress: string | undefined;
    let policyId: string | undefined;
    if (scriptParams?.length) {
      finalPolicyScript = applyParams(policyScript, scriptParams, 'scriptParamsJson');
      policyId = hashOrFail(finalPolicyScript, 'Failed to apply script parameters', 'scriptParamsJson');
      if (raw.lockOnScript) {
        scriptAddress = scriptHashToEnterpriseAddress(policyId, network());
        clean.recipientAddress = scriptAddress;
      }
    } else {
      try {
        policyId = scriptHashOf(policyScript);
      } catch {
        // Invalid script CBOR: the builder rejects it with its own message.
      }
    }
    if (policyId) bindToPolicy(mintActions, policyId, !!scriptParams?.length);

    return {
      request: {
        ...clean, mintActions, mintingPolicyScript: finalPolicyScript, requiredSigners, inlineDatum, mintRedeemer,
        forceInputs, protectInputs, referenceInputs, extraOutputs,
      } as unknown as TxBuildRequest,
      scriptHash: scriptAddress ? policyId : undefined,
      scriptAddress,
    };
  });
}

export function preparePlutusSpendRequest(raw: RawRequest, network: NetworkOf): Prepared<TxBuildPlutusSpendRequest> {
  return prepared(() => {
    checkFields('plutusSpend', raw);
    if (raw.scriptOutputIndex === undefined || raw.scriptOutputIndex === null) {
      throw new RequestError('scriptOutputIndex is required', 'scriptOutputIndex', true);
    }
    const redeemer = parseJsonField(raw, 'redeemerJson');
    const datum = parseJsonField(raw, 'datumJson');
    const requiredSigners = takeParsed(parseRequiredSigners(raw.requiredSignersJson as string | undefined), 'requiredSignersJson');
    const scriptParams = parseScriptParams(raw);
    const inlineDatum = parseJsonField(raw, 'inlineDatumJson');
    if (raw.lockOnScript && !scriptParams?.length) {
      fail('lockOnScript requires scriptParamsJson to derive script address', 'lockOnScript');
    }
    const forceInputs = utxoRefs(raw, 'forceInputsJson');
    const protectInputs = utxoRefs(raw, 'protectInputsJson');
    const referenceInputs = utxoRefs(raw, 'referenceInputsJson');
    const extraOutputs = takeParsed(parseExtraOutputs(raw.extraOutputsJson as string | undefined), 'extraOutputsJson');

    // Optional mint in the same transaction. A policy byte-equal to the validator takes its parameters.
    const validatorScript = String(raw.validatorScript);
    const policyScript = raw.mintingPolicyScript as string | undefined;
    const policyIsValidator = policyScript === validatorScript;
    let mintActions: MintAction[] | undefined;
    let mintRedeemer: JSONValue | undefined;
    if (raw.mintActionsJson) {
      if (!policyScript) fail('mintActionsJson requires mintingPolicyScript', 'mintingPolicyScript');
      mintActions = parseMintActions(raw, !!scriptParams && policyIsValidator, 'spend');
      mintRedeemer = parseJsonField(raw, 'mintRedeemerJson');
    } else if (policyScript || raw.mintRedeemerJson) {
      fail('mintingPolicyScript / mintRedeemerJson require mintActionsJson', 'mintActionsJson');
    }

    const finalValidator = scriptParams?.length ? applyParams(validatorScript, scriptParams, 'scriptParamsJson') : validatorScript;
    let finalPolicyScript: string | undefined;
    if (mintActions && policyScript) {
      finalPolicyScript = policyIsValidator ? finalValidator : policyScript;
      let policyId: string | undefined;
      if (scriptParams?.length && policyIsValidator) {
        policyId = hashOrFail(finalPolicyScript, 'Failed to hash applied script', 'mintingPolicyScript');
      } else {
        try {
          policyId = scriptHashOf(finalPolicyScript);
        } catch {
          // Invalid script CBOR: the builder rejects it with its own message.
        }
      }
      if (policyId) bindToPolicy(mintActions, policyId, !!scriptParams?.length && policyIsValidator);
    }

    const clean: RawRequest = {
      ...raw,
      plutusScriptExecution: {
        validatorScript: finalValidator,
        scriptUtxo: { txHash: raw.scriptTxHash, outputIndex: raw.scriptOutputIndex },
        redeemer,
        datum,
      },
      requiredSigners, inlineDatum, forceInputs, protectInputs, referenceInputs, extraOutputs,
      mintActions, mintingPolicyScript: finalPolicyScript, mintRedeemer,
    };
    for (const f of ['requiredSignersJson', 'scriptParamsJson', 'inlineDatumJson', 'lockOnScript', 'forceInputsJson',
      'protectInputsJson', 'referenceInputsJson', 'extraOutputsJson', 'mintActionsJson', 'mintRedeemerJson', 'redeemerJson', 'datumJson']) delete clean[f];
    referenceScript(raw, clean);

    let scriptHash: string | undefined;
    let scriptAddress: string | undefined;
    if (raw.lockOnScript) {
      scriptHash = hashOrFail(finalValidator, 'Failed to derive script address', 'validatorScript');
      scriptAddress = scriptHashToEnterpriseAddress(scriptHash, network());
      clean.recipientAddress = scriptAddress;
    }
    return { request: clean as unknown as TxBuildPlutusSpendRequest, scriptHash, scriptAddress };
  });
}

/** Most recipients one payout takes; the transaction size limit may be reached earlier. */
export const MAX_PAYOUT_OUTPUTS = 150;

// payout: the outputs of `outputsJson` in the given order, paid from the sender in one transaction.
// Entries read like those of BuildPlutusTransaction. No script runs.
export function preparePayoutRequest(raw: RawRequest): Prepared<TxBuildPlutusRequest> {
  return prepared(() => {
    checkInputs(raw, ['senderAddress', 'validityStartMs', 'validityEndMs'], ['senderAddress']);
    if (raw.outputsJson === undefined || raw.outputsJson === null || raw.outputsJson === '') {
      throw new RequestError('outputsJson is required', 'outputsJson', true);
    }
    if (typeof raw.outputsJson !== 'string') fail('outputsJson must be a JSON string', 'outputsJson');
    const outputs = takeParsed(parseOutputList(raw.outputsJson, 'outputsJson', MAX_PAYOUT_OUTPUTS), 'outputsJson');
    if (!outputs) fail('outputsJson must list at least one output', 'outputsJson');
    return {
      request: {
        network: raw.network as Network,
        senderAddress: raw.senderAddress as string,
        changeAddress: raw.changeAddress as string | undefined,
        scriptInputs: [],
        outputs,
        forceInputs: utxoRefs(raw, 'forceInputsJson'),
        protectInputs: utxoRefs(raw, 'protectInputsJson'),
        validityStartMs: raw.validityStartMs as string | undefined,
        validityEndMs: raw.validityEndMs as string | undefined,
      },
    };
  });
}

/** The prepared request for a build kind. */
export function prepareBuildRequest(kind: BuildKind, raw: RawRequest, network: NetworkOf): Prepared<TxBuildRequest> {
  switch (kind) {
    case 'simpleAda': return prepareSimpleAdaRequest(raw, network);
    case 'metadata': return prepareMetadataRequest(raw);
    case 'multiAsset': return prepareMultiAssetRequest(raw);
    case 'mint': return prepareMintRequest(raw, network);
    case 'plutusSpend': return preparePlutusSpendRequest(raw, network) as Prepared<TxBuildRequest>;
    default: return { error: `Unsupported job kind "${String(kind)}"`, field: 'kind' };
  }
}
