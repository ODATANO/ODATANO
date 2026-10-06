import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildPlutusRequest, PlutusTxOutput, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters, TxEvaluator, MintAction } from "../../utils/types";
import { TxBuilder, getScriptDataHash, costModelsToLanguageViewCbor, ExBudget, isCostModels, toCostModelV1, toCostModelV2, toCostModelV3, type CostModels, type ITxBuildArgs, type ITxBuildOptions, type ITxBuildWithdrawal, type ITxBuildCert } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace, isCollateralCandidate, mapBuilderError, parseAssetUnit, jsonToPlutusData } from "../../utils/tx-build-helper";
import { ConfigError, InsufficientFundsError, TransactionValidationError, ScriptValidationError } from "../../utils/errors";
import { resolveIndexPlaceholders, sortInputsLikeBuildooor, sortWithdrawalsLikeLedger, type InputRef } from "../../utils/plutus-placeholders";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cds from "@sap/cds";
import {
  type ProtocolParameters,
  defaultProtocolParameters,
  Address,
  StakeAddress,
  Credential,
  CredentialType,
  CertStakeRegistration,
  CertStakeDeRegistration,
  CertRegistrationDeposit,
  CertUnRegistrationDeposit,
  UTxO as LedgerUTxO,
  Value,
  TxOut,
  TxOutRef,
  Script,
  Hash28,
  Hash32,
  Tx as LedgerTx,
  TxBody,
  TxWitnessSet,
  TxRedeemer,
  TxRedeemerTag,
  txRedeemerTagToString
} from "@harmoniclabs/cardano-ledger-ts";

// Metadata classes come from the DIST paths on purpose: buildooor's AuxiliaryData/TxMetadata
// run `instanceof` checks against these exact class identities, not the package-root re-exports.
import { TxMetadata } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata";
import {
  type TxMetadatum,
  TxMetadatumInt,
  TxMetadatumText,
  TxMetadatumList,
  TxMetadatumMap,
  TxMetadatumBytes
} from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { DataI, dataFromCbor, dataToCbor, type Data } from "@harmoniclabs/plutus-data";
import { CardanoClient } from "../cardano-client";
import { type CallerDatums, callerDatumGrowth, callerDatumsGrowth, writeCallerDatums, datumHashOf, witnessDatumsGrowth, writeWitnessDatums } from "./caller-datums";
import { EXECUTION_UNIT_BUFFER, ABS_CPU_BUFFER, ABS_MEM_BUFFER, MIN_CHANGE_LOVELACE, COLLATERAL_LOVELACE, GENESIS_INFOS_BY_NETWORK, DEFAULT_VALIDITY_START_OFFSET_MS, DEFAULT_VALIDITY_END_OFFSET_MS } from '../../utils/const'

/** Policy of a mint action: the script itself, or the UTxO that carries it as reference script. */
type MintScriptSource = { inline: Script } | { ref: LedgerUTxO };

const logger = cds.log('BuildooorTxBuilder');

/** A redeemer whose script failed Buildooor's local CEK evaluation during build(). */
interface LocalEvalFailure {
  tag: TxRedeemerTag;
  index: number;
  logs: string[];
}

/** Execution units as bigints (matching ExBudget's mem/cpu). */
type ExUnitsBig = { mem: bigint; cpu: bigint };

/** Cost-model arrays exactly as served by the chain, keyed like Buildooor's CostModels. */
type RawCostModelArrays = Partial<Record<'PlutusScriptV1' | 'PlutusScriptV2' | 'PlutusScriptV3', number[]>>;

/**
 * Build options for script-bearing transactions. Buildooor stamps each redeemer with its
 * local CEK budget and, without `onScriptInvalid`, aborts on a local failure; we only record
 * failures here and let `_buildScriptTx` decide (Ogmios result wins, otherwise abort).
 */
function makeScriptBuildOpts(failures: LocalEvalFailure[]): ITxBuildOptions {
  return {
    onScriptInvalid: (rdmr: TxRedeemer, logs: string[]): void => {
      failures.push({ tag: rdmr.tag, index: rdmr.index, logs: logs.slice() });
      logger.warn(
        `Plutus script failed local evaluation (redeemer ${txRedeemerTagToString(rdmr.tag)}:${rdmr.index}); ` +
        `deferring to Ogmios evaluation if available. Logs: [${logs.join(', ')}]`
      );
    }
  };
}

const redeemerKey = (tag: TxRedeemerTag, index: number): string => `${tag}:${index}`;

/** Ogmios RedeemerPointer purpose → ledger TxRedeemerTag (Ogmios v6 wire names). */
const PURPOSE_TO_TAG: Record<string, TxRedeemerTag | undefined> = {
  spend: TxRedeemerTag.Spend,
  mint: TxRedeemerTag.Mint,
  publish: TxRedeemerTag.Cert,
  certificate: TxRedeemerTag.Cert,
  withdraw: TxRedeemerTag.Withdraw,
  withdrawal: TxRedeemerTag.Withdraw
};

/** CBOR-encoded length in bytes of an unsigned integer head + payload. */
function cborUIntLength(n: bigint): bigint {
  if (n < 24n) return 1n;
  if (n < 256n) return 2n;
  if (n < 65536n) return 3n;
  if (n < 4294967296n) return 5n;
  return 9n;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Parse a protocol-parameter value (number or decimal string) into a non-negative safe integer;
 * undefined for null/empty/invalid so callers keep library defaults instead of coercing to 0.
 */
function toUInt(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Parse a strictly positive finite number (e.g. exUnit prices); undefined when absent/invalid. */
function toPositiveNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Stable identity of a protocol-parameter set: network#epoch (params change per epoch), else full JSON. */
function protocolParamsFingerprint(p: LedgerProtocolParameter): string {
  if (p.network && p.epoch !== undefined && p.epoch !== null) return `${p.network}#${p.epoch}`;
  return JSON.stringify(p);
}

/** Ledger limit for a single text/bytes metadatum (bytes, not characters). */
const METADATA_BYTE_LIMIT = 64;

/** Split a string into pieces of at most maxBytes UTF-8 bytes without splitting a code point. */
function chunkUtf8(str: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * The same script without the CBOR it was parsed from. Script.fromCbor keeps the input bytes (the
 * compiler's bare bytestring) and toCbor() returns them, while an output's script_ref must hold the
 * ledger form [language, bytes]; the hash is the same either way.
 */
function ledgerScript(script: Script): Script {
  return new Script(script.type, script.bytes);
}

// Hash32 inherits Hash.clone(), which returns a plain Hash; TxOut rejects that as datum when
// Buildooor clones outputs, so a datum-hash output could never be built. Hash28 has its own clone.
if (!Object.prototype.hasOwnProperty.call(Hash32.prototype, 'clone')) {
  Hash32.prototype.clone = function (this: Hash32): Hash32 { return new Hash32(this.toString()); };
}

/** CardanoTxBuilder implementation on top of Buildooor. */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = 'BuildooorTxBuilder';
  private txBuilder!: TxBuilder;
  private cardanoClient!: CardanoClient;
  private genesisInfos!: NonNullable<ConstructorParameters<typeof TxBuilder>[1]>;
  private paramsFingerprint: string | undefined;
  /**
   * Chain cost-model arrays kept verbatim for language-view hashing; set by _mapCostModels,
   * empty when the current parameters carry no usable cost models.
   */
  private rawCostModelArrays: RawCostModelArrays = {};

  /**
   * Initialize the builder.
   * @param protocolParams - optional; fetched from the backend when omitted
   */
  public async init(client: CardanoClient, protocolParams?: LedgerProtocolParameters): Promise<void> {
    this.cardanoClient = client;
    const params = protocolParams ?? await client.getProtocolParameters();
    const genesisInfos = GENESIS_INFOS_BY_NETWORK[client.network];
    if (!genesisInfos) {
      throw new ConfigError(`BuildooorTxBuilder: no genesis presets for network "${client.network}"`);
    }
    this.genesisInfos = genesisInfos;
    this._applyProtocolParameters(params, protocolParamsFingerprint(params));
    logger.debug(`Initialized with protocol parameters and ${client.network} genesis infos`);
  }

  /**
   * Rebuild the TxBuilder when the per-request protocol parameters differ from the current
   * ones; the TxBuilder has no setter but its constructor is cheap (effectively once per epoch).
   */
  private _ensureCurrentProtocolParameters(ctx: TxBuildContext): void {
    const params = ctx.protocolParameters;
    if (!params) return;
    const fingerprint = protocolParamsFingerprint(params);
    if (fingerprint === this.paramsFingerprint) return;
    this._applyProtocolParameters(params, fingerprint);
    logger.info(`Refreshed protocol parameters (${fingerprint})`);
  }

  private _applyProtocolParameters(params: LedgerProtocolParameter, fingerprint: string): void {
    this.txBuilder = new TxBuilder(this._mapLedgerParametersToBuildooorParams(params), this.genesisInfos);
    this.paramsFingerprint = fingerprint;
  }

  /** Build an unsigned transfer transaction (ADA-only or with native assets). */
  public buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    return this._buildSimpleTransfer(req, ctx, 'transfer');
  }

  /** Build an unsigned transfer transaction with attached metadata. */
  public buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    return this._buildSimpleTransfer(req, ctx, 'metadata transfer');
  }

  /**
   * Shared non-script transfer build; assets, outputDatum and metadataJson are each
   * handled only when present in the request.
   */
  private async _buildSimpleTransfer(req: TxBuildRequest, ctx: TxBuildContext, label: string): Promise<TxBuildResult> {
    try {
      this._ensureCurrentProtocolParameters(ctx);
      if (!ctx.utxos || ctx.utxos.length === 0) {
        throw new InsufficientFundsError('lovelace', BigInt(req.lovelaceAmount || 0), 0n);
      }

      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
      const amount = BigInt(String(req.lovelaceAmount));

      if (req.outputDatum !== undefined && req.outputDatumCbor !== undefined) {
        throw new TransactionValidationError('outputDatum and outputDatumCbor exclude each other; pass one');
      }
      const callerDatum = req.outputDatumCbor !== undefined ? Buffer.from(req.outputDatumCbor, 'hex') : undefined;
      const refScript = this._parseReferenceScript(req.referenceScript);
      const recipientOut = (lovelace: bigint): TxOut => {
        const value = this._buildLedgerValue(lovelace, req.assets);
        return callerDatum
          ? new TxOut({ address: recipientAddress, value, datum: dataFromCbor(callerDatum), ...(refScript && { refScript }) })
          : this._buildTxOut(recipientAddress, value, req.outputDatum, refScript);
      };

      let recipient = recipientOut(amount);
      const minLovelace = this._minOutputLovelace(recipient, callerDatum);
      if (amount < minLovelace) {
        if (!req.ensureMinAda) {
          throw new TransactionValidationError(
            `recipient output needs at least ${minLovelace.toString()} lovelace (has ${amount.toString()}); raise lovelaceAmount or set ensureMinAda`
          );
        }
        recipient = recipientOut(this._minOutputLovelace(recipient, callerDatum, true));
      }
      const outputValue = recipient.value;
      const outputs = [recipient];

      // Partition: forced UTxOs become fixed inputs; rest is the coin-selection pool
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs, this._referencedKeys(ctx, req.referenceInputs), req.protectInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));
      const candidateInputs = rest.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Coin selection on candidates only; forced inputs are prepended unconditionally
      const selected = this.txBuilder.keepRelevant(outputValue, candidateInputs);
      const inputs = [...forcedInputs, ...selected];
      logger.debug(`Coin selection: ${selected.length}/${candidateInputs.length} UTxOs selected (${forcedInputs.length} forced) for ${label}`);

      const metadata = req.metadataJson !== undefined && req.metadataJson !== null
        ? this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson)
        : undefined;
      const validity = this._resolveValiditySlots(req, 'passthrough');
      const callerDatums: CallerDatums = new Map(callerDatum ? [[0, callerDatum]] : []);
      const tx = await this._buildWithCallerDatums({ inputs, outputs, changeAddress, ...(metadata && { metadata }), ...validity }, callerDatums);

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { forcedInputsUsed: forcedInputs.length });
    } catch (err: unknown) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // Set once the collateral partition is known: it explains insufficient-funds rejections
    // that the builder's own message cannot attribute.
    let coinSelectionContext: string | undefined;
    try {
      this._ensureCurrentProtocolParameters(ctx);
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

      const script = this._parsePlutusV3Script(req.mintingPolicyScript, 'mintingPolicyScript');

      // Total mint value for the output (positive quantities only); each action mints under its own policy script.
      let mintValue = Value.lovelaces(0n);
      for (const [index, mintAction] of req.mintActions.entries()) {
        const quantity = BigInt(mintAction.quantity);
        if (quantity > 0n) {
          const actionScript = this._mintActionScript(mintAction, script, index);
          const { assetName } = parseAssetUnit(mintAction.assetUnit);
          mintValue = Value.add(mintValue, Value.singleAsset(actionScript.hash, Buffer.from(assetName, 'hex'), quantity));
        }
      }

      // Partition forced vs candidate UTxOs. Forced inputs are already committed;
      // collateral and coin selection operate on the remainder only.
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs, this._referencedKeys(ctx, req.referenceInputs), req.protectInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Collateral + funding separation (from candidates only — forced inputs cannot double as collateral)
      const { collateralUtxos, fundingUtxos, collateralReturn } = this._setupCollateral(rest);
      coinSelectionContext = this._collateralPartitionContext(collateralUtxos, fundingUtxos);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));
      const allFundingInputs = fundingLedgerUtxos.map(utxo => ({ utxo }));

      // Funding must cover the lovelace plus, for extra outputs, their lovelace and any asset
      // demand the mint itself does not cover.
      let requiredFundingValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      if (req.extraOutputs && req.extraOutputs.length > 0) {
        const { lovelace, assets } = this._extraOutputsFundingAfterMint(req.mintActions, req.extraOutputs);
        requiredFundingValue = Value.add(
          requiredFundingValue,
          this._buildLedgerValue(lovelace, assets)
        );
      }
      const selectedFunding = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);
      const inputs = [...forcedInputs, ...selectedFunding];
      logger.debug(`Coin selection: ${selectedFunding.length}/${allFundingInputs.length} UTxOs selected (${forcedInputs.length} forced) for mint`);

      // Resolve __INPUT_IDX__ placeholders in mintRedeemer + inlineDatum once the final input order is known.
      const sortedInputs = sortInputsLikeBuildooor([
        ...forced.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
        ...this._extractFundingRefs(selectedFunding)
      ]);
      const resolveCtx = { sortedInputs };
      const resolvedMintRedeemer = req.mintRedeemer
        ? resolveIndexPlaceholders(req.mintRedeemer, resolveCtx)
        : undefined;
      const resolvedInlineDatum = req.inlineDatum
        ? resolveIndexPlaceholders(req.inlineDatum, resolveCtx)
        : undefined;
      const resolvedExtraOutputs = this._resolveExtraOutputPlaceholders(req.extraOutputs, resolveCtx);

      // Primary output: minted assets + min ADA. With extra outputs declared, those carry
      // the minted assets and the primary output stays ADA(+datum)-only.
      let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      if (!resolvedExtraOutputs || resolvedExtraOutputs.length === 0) {
        outputValue = Value.add(outputValue, mintValue);
      }
      const refScript = this._parseReferenceScript(req.referenceScript);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedInlineDatum, refScript)];

      // Append extra outputs, each independently min-ADA checked.
      this._appendExtraOutputs(outputs, resolvedExtraOutputs);

      // Mint entries; Buildooor ignores caller-supplied execution units, the real ones are
      // stamped post-build by _buildScriptTx.
      const mints = this._buildMintEntries(req.mintActions, (a, i) => ({ inline: this._mintActionScript(a, script, i) }), resolvedMintRedeemer, resolveCtx);

      // CIP-31: map resolved reference input UTxOs to Buildooor LedgerUTxO format
      const readonlyRefInputs = this._mapReferenceInputs(ctx.referenceInputUtxos);

      // Resolve validity bounds once — both passes must share them so redeemer ExUnits
      // and fee computation stay consistent (a mismatch would force re-evaluation).
      const { invalidBefore, invalidAfter } = this._resolveValiditySlots(req, 'script');

      // Auxiliary metadata (CIP-20, label 674, ...) must be identical across eval + final passes:
      // it affects tx size (fee) and the script data hash.
      const mintMetadata = req.metadataJson
        ? this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson)
        : undefined;

      // One set of build args shared by both internal passes and the Ogmios evaluation.
      const buildParams: ITxBuildArgs = {
        inputs, outputs, changeAddress, mints,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners,
        invalidBefore, invalidAfter,
        ...(collateralReturn && { collateralReturn }),
        ...(mintMetadata && { metadata: mintMetadata }),
        ...(readonlyRefInputs.length > 0 && { readonlyRefInputs })
      };
      const tx = await this._buildScriptTx(buildParams, ctx.evaluateTransaction);

      logger.debug(`Built unsigned minting transaction successfully with fee: ${tx.body.fee.toString()}`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { scriptHash: script.hash.toString(), forcedInputsUsed: forcedInputs.length, referenceInputsUsed: readonlyRefInputs.length });
    } catch (err: unknown) {
      mapBuilderError(err, undefined, coinSelectionContext);
    }
  }

  public async buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // See buildUnsignedMintTransaction — same collateral-partition context for rejections.
    let coinSelectionContext: string | undefined;
    try {
      this._ensureCurrentProtocolParameters(ctx);
      const { plutusScriptExecution } = req;

      const script = this._parsePlutusV3Script(plutusScriptExecution.validatorScript, 'plutusScriptExecution.validatorScript');

      if (!plutusScriptExecution.datum) {
        // Without an explicit datum the script UTxO must carry an inline datum.
        logger.debug('No datumJson provided — expecting inline datum on script UTxO');
      }

      const scriptUtxoRef = plutusScriptExecution.scriptUtxo;
      const scriptOdatanoUtxo = ctx.utxos.find(
        u => u.txHash === scriptUtxoRef.txHash && u.outputIndex === scriptUtxoRef.outputIndex
      );
      if (!scriptOdatanoUtxo) {
        throw new TransactionValidationError(`Script UTxO ${scriptUtxoRef.txHash}#${scriptUtxoRef.outputIndex} not found in provided UTxOs`);
      }

      const scriptLedgerUtxo = this._mapMultiAssetUtxoToLedgerUtxo(scriptOdatanoUtxo);

      // Map sender UTxOs (excluding the script UTxO) as regular inputs
      const senderUtxos = ctx.utxos.filter(
        u => !(u.txHash === scriptUtxoRef.txHash && u.outputIndex === scriptUtxoRef.outputIndex)
      );

      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

      // Partition forced inputs (excluding any ref that matches the script UTxO — silently ignored)
      const forceInputsFiltered = (req.forceInputs ?? []).filter(
        r => !(r.txHash === scriptUtxoRef.txHash && r.outputIndex === scriptUtxoRef.outputIndex)
      );
      const { forced, rest } = this._partitionForcedInputs(senderUtxos, forceInputsFiltered, this._referencedKeys(ctx, req.referenceInputs), req.protectInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Collateral + funding separation (from candidates only — forced inputs cannot double as collateral)
      const { collateralUtxos, fundingUtxos, collateralReturn } = this._setupCollateral(rest);
      coinSelectionContext = this._collateralPartitionContext(collateralUtxos, fundingUtxos);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // Funding covers fee + min change (the script UTxO covers the output) plus extra outputs;
      // assets the script UTxO already provides net out, so over-requesting is harmless.
      const allFundingInputs = fundingLedgerUtxos.map(utxo => ({ utxo }));
      let requiredFundingValue = Value.lovelaces(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE));
      if (req.extraOutputs && req.extraOutputs.length > 0) {
        for (const extra of req.extraOutputs) {
          requiredFundingValue = Value.add(
            requiredFundingValue,
            this._buildLedgerValue(BigInt(extra.lovelaceAmount), extra.assets)
          );
        }
      }
      const selectedFundingInputs = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);
      logger.debug(`Coin selection: ${selectedFundingInputs.length}/${allFundingInputs.length} UTxOs selected (${forcedInputs.length} forced) for Plutus spend`);

      // Compute the final input order (Buildooor's lex sort) and resolve __INPUT_IDX__ placeholders
      // in redeemer / datum / output datums BEFORE PlutusData encoding.
      const sortedInputs = this._computeSortedInputs([scriptUtxoRef], forced, this._extractFundingRefs(selectedFundingInputs));
      const resolveCtx = { sortedInputs };
      const resolvedRedeemer = resolveIndexPlaceholders(plutusScriptExecution.redeemer, resolveCtx);
      const redeemerData = jsonToPlutusData(resolvedRedeemer);
      const datum = plutusScriptExecution.datum
        ? jsonToPlutusData(resolveIndexPlaceholders(plutusScriptExecution.datum, resolveCtx))
        : "inline" as const;
      if (datum !== "inline") {
        this._checkWitnessDatum(scriptOdatanoUtxo, dataToCbor(datum), 'datumJson',
          '; BuildPlutusTransaction takes the datum as datumCbor with the bytes the UTxO was locked with');
      }
      const resolvedPrimaryInlineDatum = req.inlineDatum
        ? resolveIndexPlaceholders(req.inlineDatum, resolveCtx)
        : undefined;
      const resolvedExtraOutputs = this._resolveExtraOutputPlaceholders(req.extraOutputs, resolveCtx);
      const resolvedMintRedeemer = req.mintRedeemer
        ? resolveIndexPlaceholders(req.mintRedeemer, resolveCtx)
        : undefined;

      // Combined spend+mint: with mintActions present, mints are built alongside the spend input.
      const hasMint = !!(req.mintActions && req.mintActions.length > 0 && req.mintingPolicyScript);
      let mintScript: Script | undefined;
      let mintScriptHash: string | undefined;
      if (hasMint) {
        mintScript = this._parsePlutusV3Script(req.mintingPolicyScript!, 'mintingPolicyScript');
        mintScriptHash = mintScript.hash.toString();
      }

      // Build outputs — include multi-assets from script UTxO in continuing output
      const scriptNonAdaAssets = scriptOdatanoUtxo.amount.filter(
        a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n
      );
      let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE));
      if (scriptNonAdaAssets.length > 0) {
        outputValue = this._buildLedgerValue(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE), scriptOdatanoUtxo.amount);
      }
      // If mints are present and no extraOutputs handle the minted assets, attach positive mints to the primary output.
      if (hasMint && (!resolvedExtraOutputs || resolvedExtraOutputs.length === 0)) {
        for (const [index, action] of req.mintActions!.entries()) {
          const qty = BigInt(action.quantity);
          if (qty > 0n) {
            const actionScript = this._mintActionScript(action, mintScript!, index);
            const { assetName } = parseAssetUnit(action.assetUnit);
            outputValue = Value.add(outputValue, Value.singleAsset(actionScript.hash, Buffer.from(assetName, 'hex'), qty));
          }
        }
      }
      const primaryRefScript = this._parseReferenceScript(req.referenceScript);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedPrimaryInlineDatum, primaryRefScript)];

      // Append extra outputs, each independently min-ADA checked.
      this._appendExtraOutputs(outputs, resolvedExtraOutputs);

      // Mint entries for the combined spend+mint; Buildooor ignores caller-supplied execution
      // units, the real ones are stamped post-build by _buildScriptTx.
      const mints = hasMint
        ? this._buildMintEntries(req.mintActions!, (a, i) => ({ inline: this._mintActionScript(a, mintScript!, i) }), resolvedMintRedeemer, resolveCtx)
        : undefined;

      const scriptInput = {
        utxo: scriptLedgerUtxo,
        inputScript: { script, datum, redeemer: redeemerData }
      };
      const inputs = [scriptInput, ...forcedInputs, ...selectedFundingInputs];

      // CIP-31: map resolved reference input UTxOs to Buildooor LedgerUTxO format
      const readonlyRefInputs = this._mapReferenceInputs(ctx.referenceInputUtxos);

      // Resolve validity bounds once — both passes must share them so redeemer ExUnits
      // and fee computation stay consistent (a mismatch would force re-evaluation).
      const { invalidBefore, invalidAfter } = this._resolveValiditySlots(req, 'script');

      // One set of build args shared by both internal passes and the Ogmios evaluation.
      const buildParams: ITxBuildArgs = {
        inputs, outputs, changeAddress,
        mints,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners,
        invalidBefore, invalidAfter,
        ...(collateralReturn && { collateralReturn }),
        ...(readonlyRefInputs.length > 0 && { readonlyRefInputs })
      };
      const tx = await this._buildScriptTx(buildParams, ctx.evaluateTransaction);

      logger.debug(`Built unsigned Plutus spending transaction successfully with fee: ${tx.body.fee.toString()}`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), {
        scriptHash: script.hash.toString(),
        mintScriptHash,
        forcedInputsUsed: forcedInputs.length,
        referenceInputsUsed: readonlyRefInputs.length
      });
    } catch (err: unknown) {
      mapBuilderError(err, undefined, coinSelectionContext);
    }
  }

  /**
   * Several script inputs in one transaction, each with its own redeemer (inline validator or a
   * reference-script UTxO), the outputs exactly in the given order and change after them.
   */
  public async buildUnsignedPlutusTransaction(req: TxBuildPlutusRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    let coinSelectionContext: string | undefined;
    try {
      this._ensureCurrentProtocolParameters(ctx);
      const keyOf = (r: { txHash: string; outputIndex: number }) => `${r.txHash.toLowerCase()}#${r.outputIndex}`;
      const utxoByKey = new Map(ctx.utxos.map(u => [keyOf(u), u]));
      const refUtxoByKey = new Map((ctx.referenceInputUtxos ?? []).map(u => [keyOf(u), u]));
      const scriptKeys = new Set(req.scriptInputs.map(keyOf));

      // Scripts the reference inputs already carry: the ledger rejects the same script again as a
      // witness (ExtraneousScriptWitnesses), so an inline validator with such a hash uses the reference.
      const referencedByHash = new Map<string, LedgerUTxO>();
      for (const u of ctx.referenceInputUtxos ?? []) {
        const ledgerUtxo = this._mapMultiAssetUtxoToLedgerUtxo(u);
        const hash = ledgerUtxo.resolved.refScript?.hash.toString();
        if (hash && !referencedByHash.has(hash)) referencedByHash.set(hash, ledgerUtxo);
      }

      // Script inputs: each UTxO with its script (inline, or the ledger UTxO carrying it)
      const scriptEntries = req.scriptInputs.map((si, i) => {
        const utxo = utxoByKey.get(keyOf(si));
        if (!utxo) throw new TransactionValidationError(`scriptInputs[${i}] ${keyOf(si)} not found on-chain or already spent`);
        if (si.validatorScript) {
          const script = this._parsePlutusV3Script(si.validatorScript, `scriptInputs[${i}].validatorScript`);
          const scriptHash = script.hash.toString();
          const referenced = referencedByHash.get(scriptHash);
          return referenced ? { si, utxo, refLedgerUtxo: referenced, scriptHash } : { si, utxo, script };
        }
        const refKey = keyOf(si.referenceScript!);
        const refUtxo = refUtxoByKey.get(refKey);
        if (!refUtxo) throw new TransactionValidationError(`scriptInputs[${i}].referenceScript ${refKey} not found on-chain or already spent`);
        const refLedgerUtxo = this._mapMultiAssetUtxoToLedgerUtxo(refUtxo);
        if (!refLedgerUtxo.resolved.refScript) {
          throw new TransactionValidationError(
            `scriptInputs[${i}].referenceScript ${refKey} carries no reference script, or its bytes are not available ` +
            `from the configured backends (Ogmios or Koios deliver them, Blockfrost only the hash)`
          );
        }
        return { si, utxo, refLedgerUtxo, scriptHash: refLedgerUtxo.resolved.refScript.hash.toString() };
      });

      // Withdrawals: the staking script inline, by reference, or the one a reference input carries
      const withdrawalEntries = (req.withdrawals ?? []).map((w, i) => ({
        w, rewardAccount: StakeAddress.fromString(w.rewardAddress),
        ...this._resolveScriptWitness({ script: w.stakingScript, referenceScript: w.referenceScript }, `withdrawals[${i}]`, referencedByHash, refUtxoByKey),
      }));

      // Certificates: the credential from the stake address; a script runs under the Certifying purpose
      const stakeDeposit = BigInt(String(this.txBuilder.protocolParamters.stakeAddressDeposit ?? defaultProtocolParameters.stakeAddressDeposit));
      const certEntries = (req.certificates ?? []).map((c, i) => {
        const at = `certificates[${i}]`;
        const stake = StakeAddress.fromString(c.stakeAddress);
        const credentialHash = stake.credentials.toString().toLowerCase();
        const witness = this._resolveScriptWitness({ script: c.stakingScript, referenceScript: c.referenceScript }, at, referencedByHash, refUtxoByKey);
        const scripted = Boolean(witness.script || witness.refLedgerUtxo);
        const witnessHash = (witness.script?.hash ?? witness.refLedgerUtxo?.resolved.refScript?.hash)?.toString().toLowerCase();
        if (stake.type === 'script') {
          if (scripted && witnessHash !== credentialHash) {
            throw new TransactionValidationError(`${at} staking script hash ${witnessHash} is not the credential of ${c.stakeAddress} (${credentialHash})`);
          }
          if (!scripted && c.type === 'deregisterStake') {
            throw new TransactionValidationError(`${at} deregisters the script credential ${c.stakeAddress}; its staking script and redeemer are needed`);
          }
        } else if (scripted) {
          throw new TransactionValidationError(`${at} ${c.stakeAddress} is a key credential; it takes no staking script`);
        }
        const stakeCredential = stake.type === 'script' ? Credential.script(stake.credentials) : Credential.keyHash(stake.credentials);
        const deposit = c.deposit ? BigInt(c.deposit) : stakeDeposit;
        // Without a script the witness-free legacy registration; the deposit forms need the witness
        const cert = c.type === 'registerStake'
          ? (scripted ? new CertRegistrationDeposit({ stakeCredential, deposit }) : new CertStakeRegistration({ stakeCredential }))
          : (c.deposit ? new CertUnRegistrationDeposit({ stakeCredential, deposit }) : new CertStakeDeRegistration({ stakeCredential }));
        return { c, cert, deposit, ...witness };
      });

      // Mints: each policy inline, by reference, or the one a reference input carries
      const mintEntries = (req.mintActions ?? []).map((m, i) => {
        const at = `mintActions[${i}]`;
        const witness = this._resolveScriptWitness({ script: m.mintingPolicyScript, referenceScript: m.referenceScript },
          at, referencedByHash, refUtxoByKey, 'mintingPolicyScript');
        const policyId = (witness.script?.hash ?? witness.refLedgerUtxo!.resolved.refScript!.hash).toString().toLowerCase();
        if (!m.assetUnit.toLowerCase().startsWith(policyId)) {
          throw new TransactionValidationError(`${at}.assetUnit ${m.assetUnit} is not under the policy ${policyId} of its script`);
        }
        return { m, policyId, ...witness };
      });
      // one policy runs from one place: once any action of it uses a reference script, all do
      const mintRefByPolicy = new Map<string, LedgerUTxO>();
      for (const e of mintEntries) if (e.refLedgerUtxo && !mintRefByPolicy.has(e.policyId)) mintRefByPolicy.set(e.policyId, e.refLedgerUtxo);
      for (const e of mintEntries) {
        const ref = mintRefByPolicy.get(e.policyId);
        if (ref) { e.refLedgerUtxo = ref; e.script = undefined; }
      }

      const senderUtxos = ctx.utxos.filter(u => !scriptKeys.has(keyOf(u)));
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
      const scriptKeyClash = (req.protectInputs ?? []).map(keyOf).find(k => scriptKeys.has(k));
      if (scriptKeyClash) throw new TransactionValidationError(`protectInputs ${scriptKeyClash} is also a script input`);
      const { forced, rest } = this._partitionForcedInputs(senderUtxos, (req.forceInputs ?? []).filter(r => !scriptKeys.has(keyOf(r))),
        this._referencedKeys(ctx, req.referenceInputs, req.scriptInputs.flatMap(s => (s.referenceScript ? [s.referenceScript] : []))),
        req.protectInputs);
      this._checkForeignForcedInputs(forced, req);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      const { collateralUtxos, fundingUtxos, collateralReturn } = this._setupCollateral(rest);
      coinSelectionContext = this._collateralPartitionContext(collateralUtxos, fundingUtxos);
      const allFundingInputs = fundingUtxos.map(utxo => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(utxo) }));

      // Funding covers only what the outputs need beyond the script inputs, forced inputs, mints and
      // withdrawals (keepRelevant adds its own lovelace margin for fee and change).
      const need = new Map<string, bigint>();
      const add = (unit: string, qty: bigint) => need.set(unit, (need.get(unit) ?? 0n) + qty);
      for (const o of req.outputs) {
        add('lovelace', BigInt(o.lovelaceAmount));
        for (const a of o.assets ?? []) add(a.unit, BigInt(a.quantity));
      }
      for (const u of [...scriptEntries.map(e => e.utxo), ...forced]) {
        for (const a of u.amount) add(a.unit.toLowerCase() === 'lovelace' ? 'lovelace' : a.unit, -BigInt(a.quantity));
      }
      for (const m of req.mintActions ?? []) add(m.assetUnit, -BigInt(m.quantity));
      for (const { w } of withdrawalEntries) add('lovelace', -BigInt(w.lovelace));
      // a registration locks the deposit, a deregistration refunds it
      for (const { c, deposit } of certEntries) add('lovelace', c.type === 'registerStake' ? deposit : -deposit);
      let requiredFundingValue = Value.lovelaces(0n);
      for (const [unit, qty] of need) {
        if (qty <= 0n) continue;
        requiredFundingValue = Value.add(requiredFundingValue, unit === 'lovelace'
          ? Value.lovelaces(qty)
          : this._buildLedgerValue(0n, [{ unit, quantity: qty.toString() }]));
      }
      const selectedFundingInputs = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);

      // Reference inputs: the caller's, minus the reference-script UTxOs Buildooor adds itself
      const refScriptKeys = new Set([...scriptEntries, ...withdrawalEntries, ...certEntries, ...mintEntries].filter(e => e.refLedgerUtxo).map(e =>
        keyOf({ txHash: e.refLedgerUtxo!.utxoRef.id.toString(), outputIndex: e.refLedgerUtxo!.utxoRef.index })));
      const callerRefUtxos = (ctx.referenceInputUtxos ?? []).filter(u =>
        !refScriptKeys.has(keyOf(u)) && (req.referenceInputs ?? []).some(r => keyOf(r) === keyOf(u)));
      const readonlyRefInputs = this._mapReferenceInputs(callerRefUtxos);
      const sortedReferenceInputs = sortInputsLikeBuildooor([
        ...callerRefUtxos.map(u => ({ txHash: u.txHash.toLowerCase(), outputIndex: u.outputIndex })),
        ...[...refScriptKeys].map(k => { const [txHash, idx] = k.split('#'); return { txHash, outputIndex: Number(idx) }; }),
      ]);

      // Placeholders resolve against the final input, reference-input and withdrawal order
      const sortedInputs = this._computeSortedInputs(req.scriptInputs, forced, this._extractFundingRefs(selectedFundingInputs));
      const sortedWithdrawals = this._ledgerWithdrawalOrder(withdrawalEntries);
      const resolveCtx = { sortedInputs, sortedReferenceInputs, sortedWithdrawals };

      const witnessDatums: Uint8Array[] = [];
      const scriptInputs = scriptEntries.map(({ si, utxo, script, refLedgerUtxo }, i) => {
        const redeemer = si.redeemerCbor ? dataFromCbor(si.redeemerCbor) : jsonToPlutusData(resolveIndexPlaceholders(si.redeemer, resolveCtx));
        let datum: Data | "inline" = "inline";
        if (si.datumCbor) {
          const bytes = Buffer.from(si.datumCbor, 'hex');
          this._checkWitnessDatum(utxo, bytes, `scriptInputs[${i}].datumCbor`, '');
          witnessDatums.push(bytes);
          datum = dataFromCbor(bytes);
        } else if (si.datum !== undefined) {
          datum = jsonToPlutusData(resolveIndexPlaceholders(si.datum, resolveCtx));
          this._checkWitnessDatum(utxo, dataToCbor(datum), `scriptInputs[${i}].datumJson`,
            '; pass datumCbor with the bytes the UTxO was locked with');
        }
        const ledgerUtxo = this._mapMultiAssetUtxoToLedgerUtxo(utxo);
        return script
          ? { utxo: ledgerUtxo, inputScript: { script, datum, redeemer } }
          : { utxo: ledgerUtxo, referenceScript: { refUtxo: refLedgerUtxo!, datum, redeemer } };
      });

      const outputs: TxOut[] = [];
      const callerDatums = this._appendPlutusOutputs(outputs, req.outputs.map(o => ({
        ...o,
        inlineDatum: o.inlineDatum !== undefined ? resolveIndexPlaceholders(o.inlineDatum, resolveCtx) : undefined,
      })));

      const mints = mintEntries.length > 0
        ? this._buildMintEntries(mintEntries.map(e => e.m),
          (_a, i) => (mintEntries[i].script ? { inline: mintEntries[i].script! } : { ref: mintEntries[i].refLedgerUtxo! }), undefined, resolveCtx)
        : undefined;

      // Withdrawals: Buildooor sorts them by reward account and runs each script under the Reward purpose
      const withdrawals: ITxBuildWithdrawal[] = withdrawalEntries.map(({ w, script, refLedgerUtxo, rewardAccount }) => {
        const withdrawal = { rewardAccount, amount: BigInt(w.lovelace) };
        if (!script && !refLedgerUtxo) return { withdrawal };
        const redeemer = w.redeemerCbor ? dataFromCbor(w.redeemerCbor) : jsonToPlutusData(resolveIndexPlaceholders(w.redeemer ?? null, resolveCtx));
        return { withdrawal, script: script ? { inline: script, redeemer } : { ref: refLedgerUtxo!, redeemer } };
      });

      // Certificates in the given order; a scripted one carries its redeemer under the Cert purpose
      const certificates: ITxBuildCert[] = certEntries.map(({ c, cert, script, refLedgerUtxo }) => {
        if (!script && !refLedgerUtxo) return { cert };
        const redeemer = c.redeemerCbor ? dataFromCbor(c.redeemerCbor) : jsonToPlutusData(resolveIndexPlaceholders(c.redeemer ?? null, resolveCtx));
        return { cert, script: script ? { inline: script, redeemer } : { ref: refLedgerUtxo!, redeemer } };
      });

      const { invalidBefore, invalidAfter } = this._resolveValiditySlots(req, 'script');
      const buildParams: ITxBuildArgs = {
        inputs: [...scriptInputs, ...forcedInputs, ...selectedFundingInputs],
        outputs, changeAddress, mints,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners,
        invalidBefore, invalidAfter,
        ...(collateralReturn && { collateralReturn }),
        ...(readonlyRefInputs.length > 0 && { readonlyRefInputs }),
        ...(withdrawals.length > 0 && { withdrawals }),
        ...(certificates.length > 0 && { certificates })
      };
      const tx = await this._buildScriptTx(buildParams, ctx.evaluateTransaction, callerDatums, witnessDatums);

      const details = this._extractTxDetails(tx);
      const maxTxSize = Number(this.txBuilder.protocolParamters.maxTxSize);
      if (details.sizeBytes > maxTxSize) {
        const inline = scriptEntries.filter(e => e.script).length;
        throw new TransactionValidationError(
          `transaction is ${details.sizeBytes} bytes, above the maximum of ${maxTxSize}` +
          (inline > 0 ? `; ${inline} script input(s) carry their validator inline, a referenceScript would move it out of the transaction` : '')
        );
      }
      const scriptHashes = scriptEntries.map(e => e.script ? e.script.hash.toString() : e.scriptHash!);
      logger.debug(`Built unsigned Plutus transaction with ${scriptInputs.length} script input(s), fee ${details.feeLovelace}`);
      return this._buildResult(req, ctx, details, {
        scriptHash: scriptHashes[0],
        forcedInputsUsed: forcedInputs.length,
        referenceInputsUsed: readonlyRefInputs.length + refScriptKeys.size
      });
    } catch (err: unknown) {
      mapBuilderError(err, undefined, coinSelectionContext);
    }
  }

  /**
   * Outputs of a BuildPlutusTransaction in the given order: inline datum or datum hash, ref script, min-ADA each.
   * Returns the inline datums given as CBOR, keyed by output index.
   */
  private _appendPlutusOutputs(outputs: TxOut[], list: PlutusTxOutput[]): CallerDatums {
    const callerDatums: CallerDatums = new Map();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const value = this._buildLedgerValue(BigInt(o.lovelaceAmount), o.assets);
      const refScript = this._parseReferenceScript(o.referenceScript);
      const callerDatum = o.inlineDatumCbor ? Buffer.from(o.inlineDatumCbor, 'hex') : undefined;
      const datum = o.datumHash ? new Hash32(o.datumHash) : callerDatum ? dataFromCbor(callerDatum) : undefined;
      const txOut = datum
        ? new TxOut({ address: Address.fromString(o.address), value, datum, ...(refScript && { refScript }) })
        : this._buildTxOut(Address.fromString(o.address), value, o.inlineDatum, refScript);
      const minLovelaces = this._minOutputLovelace(txOut, callerDatum);
      if (BigInt(o.lovelaceAmount) < minLovelaces) {
        throw new TransactionValidationError(
          `outputs[${i}] needs at least ${minLovelaces.toString()} lovelace (has ${o.lovelaceAmount}); raise its lovelaceAmount`
        );
      }
      if (callerDatum) callerDatums.set(outputs.length, callerDatum);
      outputs.push(txOut);
    }
    return callerDatums;
  }

  /**
   * Min-ADA of an output, counting the caller's datum bytes where they are longer than
   * Buildooor's encoding. `forAnyAmount` sizes the coin field for the largest amount, so the
   * result stays valid once written into the output.
   */
  private _minOutputLovelace(txOut: TxOut, callerDatum?: Uint8Array, forAnyAmount = false): bigint {
    const base = forAnyAmount
      ? this.txBuilder.minimizeLovelaces(txOut).value.lovelaces
      : this.txBuilder.getMinimumOutputLovelaces(txOut);
    const growth = callerDatum ? Math.max(0, callerDatumGrowth(callerDatum)) : 0;
    return base + BigInt(growth) * BigInt(this.txBuilder.protocolParamters.utxoCostPerByte);
  }

  /** Build, then write the caller's datum bytes; when they are longer, a second build raises the fee. */
  private async _buildWithCallerDatums(args: ITxBuildArgs, datums: CallerDatums): Promise<LedgerTx> {
    const tx = await this.txBuilder.build(args);
    const growth = callerDatumsGrowth(datums);
    if (growth === 0) return writeCallerDatums(tx, datums);
    // Fee floor: the extra bytes plus a pad for change-size wobble
    const fee = BigInt(tx.body.fee.toString()) + BigInt(growth + 10) * this._txFeePerByte();
    return writeCallerDatums(await this.txBuilder.build({ ...args, fee }), datums);
  }

  //---------------------------------------------------------------------------
  // Shared Helper Methods
  //---------------------------------------------------------------------------

  /** Extract CBOR, hash, fee, size, inputs and outputs from a built Buildooor Tx */
  private _extractTxDetails(tx: LedgerTx): {
    unsignedTxCbor: string; txBodyHash: string; sizeBytes: number;
    feeLovelace: string;
    inputRefs: Array<{ txHash: string; index: number }>;
    outputs: Array<{ address: string; lovelace: string }>;
    redeemers: NonNullable<TxBuildResult['redeemers']>;
  } {
    const unsignedTxBytes = tx.toCbor();
    return {
      unsignedTxCbor: toHex(unsignedTxBytes),
      txBodyHash: tx.hash.toString(),
      sizeBytes: unsignedTxBytes.length,
      feeLovelace: tx.body.fee.toString(),
      inputRefs: tx.body.inputs.map((inp) => ({
        txHash: inp.utxoRef.id.toString(),
        index: inp.utxoRef.index
      })),
      outputs: tx.body.outputs.map((o) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
      redeemers: (tx.witnesses.redeemers ?? []).map((r) => ({
        tag: txRedeemerTagToString(r.tag),
        index: r.index,
        mem: r.execUnits.mem.toString(),
        steps: r.execUnits.cpu.toString(),
      })),
    };
  }

  /** Build the standard TxBuildResult object */
  private _buildResult(
    req: Pick<TxBuildRequest, 'senderAddress'>, ctx: TxBuildContext,
    txDetails: ReturnType<BuildooorTxBuilder['_extractTxDetails']>,
    extra?: { scriptHash?: string; mintScriptHash?: string; forcedInputsUsed?: number; referenceInputsUsed?: number }
  ): TxBuildResult {
    // Map actual tx inputs (from built CBOR) back to context UTxOs for lovelace amounts
    const inputs = txDetails.inputRefs.map(ref => {
      const ctxUtxo = ctx.utxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.index);
      return {
        txHash: ref.txHash,
        index: ref.index,
        lovelace: ctxUtxo ? getLovelace(ctxUtxo).toString() : "0"
      };
    });

    return {
      unsignedTxCbor: txDetails.unsignedTxCbor,
      txBodyHash: txDetails.txBodyHash,
      senderAddress: req.senderAddress,
      network: this.cardanoClient.network,
      builderEngine: this.name,
      sizeBytes: txDetails.sizeBytes,
      feeLovelace: txDetails.feeLovelace,
      inputs,
      outputs: txDetails.outputs,
      ...(txDetails.redeemers.length > 0 ? { redeemers: txDetails.redeemers } : {}),
      ...extra,
      warnings: [],
    };
  }

  /**
   * Build a script-bearing transaction with real execution units: Buildooor stamps local CEK
   * budgets and ignores caller-supplied units, so build once, evaluate via Ogmios when available,
   * rebuild with a fee floor for the target units, then stamp them and recompute scriptDataHash.
   */
  private async _buildScriptTx(
    buildParams: ITxBuildArgs, evaluator?: TxEvaluator, callerDatums: CallerDatums = new Map(), witnessDatums: Uint8Array[] = []
  ): Promise<LedgerTx> {
    const pass1Failures: LocalEvalFailure[] = [];
    const tx1 = await this.txBuilder.build(buildParams, makeScriptBuildOpts(pass1Failures));
    if (!tx1) {
      throw new TransactionValidationError('Buildooor txBuilder.build() returned null — check inputs, datum, and collateral configuration');
    }
    const rdmrs1 = tx1.witnesses.redeemers ?? [];
    if (rdmrs1.length === 0) {
      // Defensive: callers always attach a script; nothing to evaluate or stamp.
      return callerDatums.size === 0 ? tx1 : this._buildWithCallerDatums(buildParams, callerDatums);
    }

    // The first-pass CBOR equals a dedicated evaluation build (passed ExUnits are ignored anyway).
    const evaluatedUnits = evaluator
      ? await this._evaluateExUnitsByRedeemer(toHex(tx1.toCbor()), evaluator)
      : undefined;
    if (!evaluator) {
      logger.debug('No evaluator available — falling back to buffered local execution units');
    }

    const targets1 = this._resolveTargetExUnits(rdmrs1, evaluatedUnits, pass1Failures);

    // Fee floor: Buildooor's fee already covers local budgets and future vkey witnesses; add the
    // price delta of the stamped units, their longer CBOR encoding, and a pad for change-size wobble.
    const feeFloor = BigInt(tx1.body.fee.toString())
      + this._exUnitsPriceDelta(rdmrs1, targets1)
      + this._exUnitsSizeDelta(rdmrs1, targets1) * this._txFeePerByte()
      + BigInt(callerDatumsGrowth(callerDatums) + witnessDatumsGrowth(witnessDatums)) * this._txFeePerByte()
      + 10n * this._txFeePerByte();

    const pass2Failures: LocalEvalFailure[] = [];
    const tx2 = await this.txBuilder.build({ ...buildParams, fee: feeFloor }, makeScriptBuildOpts(pass2Failures));
    const rdmrs2 = tx2.witnesses.redeemers ?? [];
    const targets2 = this._resolveTargetExUnits(rdmrs2, evaluatedUnits, pass2Failures);
    const tx = writeCallerDatums(this._stampExecUnits(tx2, targets2), callerDatums);
    return writeWitnessDatums(tx, witnessDatums, this._languageViews(tx));
  }

  /**
   * Evaluate via Ogmios; returns cushioned budgets keyed `tag:index`, or undefined when the
   * evaluation is unusable (transient failure, empty result). Validation errors are rethrown.
   */
  private async _evaluateExUnitsByRedeemer(
    evalTxCbor: string,
    evaluator: TxEvaluator
  ): Promise<Map<string, ExUnitsBig> | undefined> {
    try {
      const evalResults = await evaluator(evalTxCbor);
      logger.debug(`Evaluation results: ${JSON.stringify(evalResults)}`);
      if (!evalResults || evalResults.length === 0) return undefined;

      const byRedeemer = new Map<string, ExUnitsBig>();
      for (const result of evalResults) {
        const v = result.validator;
        let purpose: string;
        let index: number;
        if (typeof v === 'string') {
          // "purpose:index" string form
          const [p, i] = v.split(':');
          purpose = p;
          index = Number(i);
        } else {
          purpose = v.purpose;
          index = Number(v.index);
        }
        const tag = PURPOSE_TO_TAG[purpose];
        if (tag === undefined || !Number.isInteger(index)) {
          logger.warn(`Skipping evaluation result with unrecognized validator pointer: ${JSON.stringify(v)}`);
          continue;
        }
        byRedeemer.set(redeemerKey(tag, index), this._applyExUnitBuffer(result.budget.memory, result.budget.cpu));
      }
      return byRedeemer.size > 0 ? byRedeemer : undefined;
    } catch (evalError: unknown) {
      if (evalError instanceof TransactionValidationError || evalError instanceof ScriptValidationError) {
        // Authoritative: the ledger executed and rejected the script; falling back to local
        // units would hand back a transaction the node has already rejected.
        throw evalError;
      }
      const msg = evalError instanceof Error ? evalError.message : String(evalError);
      logger.warn(`Evaluation failed (transient), falling back to local execution units: ${msg}`);
      return undefined;
    }
  }

  /**
   * Cushion: relative multiplier for proportional drift on large validators, absolute floor
   * for sub-percent drift on small ones.
   */
  private _applyExUnitBuffer(mem: number | bigint, cpu: number | bigint): ExUnitsBig {
    return {
      mem: BigInt(Math.ceil(Number(mem) * EXECUTION_UNIT_BUFFER) + ABS_MEM_BUFFER),
      cpu: BigInt(Math.ceil(Number(cpu) * EXECUTION_UNIT_BUFFER) + ABS_CPU_BUFFER)
    };
  }

  /**
   * Execution units each redeemer must declare: max(local, Ogmios) when both exist, buffered
   * local without Ogmios, Ogmios alone after a local failure; a local failure without Ogmios
   * aborts because unreliable units would forfeit the signer's collateral.
   */
  private _resolveTargetExUnits(
    rdmrs: readonly TxRedeemer[],
    evaluatedUnits: Map<string, ExUnitsBig> | undefined,
    failures: LocalEvalFailure[]
  ): ExUnitsBig[] {
    return rdmrs.map(r => {
      const local: ExUnitsBig = { mem: BigInt(r.execUnits.mem), cpu: BigInt(r.execUnits.cpu) };
      const evaluated = evaluatedUnits?.get(redeemerKey(r.tag, r.index));
      const failure = failures.find(f => f.tag === r.tag && f.index === r.index);
      if (failure) {
        if (!evaluated) {
          throw new TransactionValidationError(
            `Plutus script failed local evaluation (redeemer ${txRedeemerTagToString(r.tag)}:${r.index}) ` +
            `and no Ogmios evaluation is available to certify its execution units. Refusing to return a ` +
            `transaction with unreliable execution units — signing and submitting it would forfeit the collateral. ` +
            `Configure an Ogmios backend for authoritative script evaluation, or fix the script/datum/redeemer. ` +
            `Script logs: [${failure.logs.join(', ')}]`
          );
        }
        return evaluated;
      }
      return evaluated
        ? { mem: maxBig(local.mem, evaluated.mem), cpu: maxBig(local.cpu, evaluated.cpu) }
        : this._applyExUnitBuffer(local.mem, local.cpu);
    });
  }

  /** Fee delta of the target vs local units, priced like Buildooor's own fee loop. */
  private _exUnitsPriceDelta(rdmrs: readonly TxRedeemer[], targets: ExUnitsBig[]): bigint {
    let deltaMem = 0n;
    let deltaCpu = 0n;
    rdmrs.forEach((r, i) => {
      const dMem = targets[i].mem - BigInt(r.execUnits.mem);
      const dCpu = targets[i].cpu - BigInt(r.execUnits.cpu);
      if (dMem > 0n) deltaMem += dMem;
      if (dCpu > 0n) deltaCpu += dCpu;
    });
    if (deltaMem === 0n && deltaCpu === 0n) return 0n;

    const prices = this.txBuilder.protocolParamters.executionUnitPrices;
    if (Array.isArray(prices)) {
      const [memRational, cpuRational] = prices;
      return ceilDiv(deltaMem * memRational.num, memRational.den)
        + ceilDiv(deltaCpu * cpuRational.num, cpuRational.den);
    }
    // Plain { priceMemory, priceSteps } number form (pre-normalization shape)
    const obj = prices as unknown as { priceMemory: number; priceSteps: number };
    return BigInt(Math.ceil(Number(deltaMem) * obj.priceMemory) + Math.ceil(Number(deltaCpu) * obj.priceSteps));
  }

  /** CBOR size growth (bytes) from stamping larger budgets into the redeemers. */
  private _exUnitsSizeDelta(rdmrs: readonly TxRedeemer[], targets: ExUnitsBig[]): bigint {
    return rdmrs.reduce((sum, r, i) => {
      const dMem = cborUIntLength(targets[i].mem) - cborUIntLength(BigInt(r.execUnits.mem));
      const dCpu = cborUIntLength(targets[i].cpu) - cborUIntLength(BigInt(r.execUnits.cpu));
      return sum + (dMem > 0n ? dMem : 0n) + (dCpu > 0n ? dCpu : 0n);
    }, 0n);
  }

  private _txFeePerByte(): bigint {
    return BigInt(this.txBuilder.protocolParamters.txFeePerByte);
  }

  /**
   * Replace the redeemers' execution units and recompute scriptDataHash with the raw chain
   * cost-model arrays (TxBuilder.overrideTxRedeemers hashes with clamped named-key models,
   * which mismatches once the on-chain cost model grows). Recomputed even when units match.
   */
  private _stampExecUnits(tx: LedgerTx, targets: ExUnitsBig[]): LedgerTx {
    const rdmrs = tx.witnesses.redeemers ?? [];
    const unchanged = rdmrs.every((r, i) =>
      BigInt(r.execUnits.mem) === targets[i].mem && BigInt(r.execUnits.cpu) === targets[i].cpu
    );
    const stamped = unchanged ? [...rdmrs] : rdmrs.map((r, i) => new TxRedeemer({
      tag: r.tag,
      index: r.index,
      data: r.data,
      execUnits: new ExBudget({ mem: targets[i].mem, cpu: targets[i].cpu })
    }));
    const newWitnesses = new TxWitnessSet({ ...tx.witnesses, vkeyWitnesses: [], redeemers: stamped });
    const newBody = new TxBody({ ...tx.body, scriptDataHash: getScriptDataHash(newWitnesses, this._languageViews(tx)) });
    const finalTx = new LedgerTx({ ...tx, body: newBody, witnesses: newWitnesses });
    if (!unchanged) {
      logger.info(`Stamped execution units into ${stamped.length} redeemer(s): ` +
        stamped.map(s => `${txRedeemerTagToString(s.tag)}:${s.index} mem=${s.execUnits.mem} cpu=${s.execUnits.cpu}`).join('; '));
    }
    return finalTx;
  }

  /** Language views the scriptDataHash covers, from the chain's cost models. */
  private _languageViews(tx: LedgerTx): Uint8Array {
    return costModelsToLanguageViewCbor(this._languageViewCostModels(), this._usedLanguageViewOpts(tx));
  }

  /**
   * Check a witness datum against the datum hash its script UTxO is locked with: the ledger
   * finds the datum by the hash of its bytes. Inline-datum UTxOs need no witness datum.
   */
  private _checkWitnessDatum(utxo: OdatanoUtxo, datum: Uint8Array, field: string, hint: string): void {
    if (!utxo.datumHash || utxo.inlineDatum) return;
    const hash = datumHashOf(datum);
    if (hash !== utxo.datumHash.toLowerCase()) {
      throw new TransactionValidationError(
        `${field} hashes to ${hash}, but ${utxo.txHash}#${utxo.outputIndex} is locked with datum hash ${utxo.datumHash}${hint}`
      );
    }
  }

  /**
   * Language-view selection for scriptDataHash, mirroring Buildooor's initTxBuild
   * (which flags the languages of *executed* scripts). This builder only attaches
   * scripts inline, so the witness set carries every executed script.
   */
  private _usedLanguageViewOpts(tx: LedgerTx): { mustHaveV1: boolean; mustHaveV2: boolean; mustHaveV3: boolean } {
    const w = tx.witnesses;
    const opts = {
      mustHaveV1: (w.plutusV1Scripts?.length ?? 0) > 0,
      mustHaveV2: (w.plutusV2Scripts?.length ?? 0) > 0,
      mustHaveV3: (w.plutusV3Scripts?.length ?? 0) > 0
    };
    if (!opts.mustHaveV1 && !opts.mustHaveV2 && !opts.mustHaveV3) opts.mustHaveV3 = true;
    return opts;
  }

  /**
   * Cost models for language-view hashing: named-key objects clamp the chain array to the
   * parameter count this library release knows, but the ledger hashes every entry served,
   * so raw chain arrays (passed through unclamped) are substituted where available.
   */
  private _languageViewCostModels(): CostModels {
    const models = this.txBuilder.protocolParamters.costModels;
    if (Object.keys(this.rawCostModelArrays).length === 0) return models;
    return { ...models, ...this.rawCostModelArrays } as CostModels;
  }

  /**
   * Split UTxOs into forced inputs (must be consumed) and remaining candidates; forceInputs
   * refs absent from utxos are ignored (existence is validated upstream).
   */
  private _partitionForcedInputs(
    utxos: OdatanoUtxo[],
    forceInputs?: Array<{ txHash: string; outputIndex: number }>,
    referenced: ReadonlySet<string> = new Set(),
    protectInputs?: Array<{ txHash: string; outputIndex: number }>
  ): { forced: OdatanoUtxo[]; rest: OdatanoUtxo[] } {
    const hasRefScript = (u: OdatanoUtxo) => Boolean(u.scriptRef || u.scriptRefCbor);
    const key = (r: { txHash: string; outputIndex: number }) => `${r.txHash.toLowerCase()}#${r.outputIndex}`;
    const protectedKeys = new Set((protectInputs ?? []).map(key));
    if ((!forceInputs || forceInputs.length === 0) && referenced.size === 0 && protectedKeys.size === 0 && !utxos.some(hasRefScript)) {
      return { forced: [], rest: utxos };
    }
    const forcedKeys = new Set((forceInputs ?? []).map(key));
    // a UTxO cannot be spent and referenced in one transaction
    const clash = [...forcedKeys].find(k => referenced.has(k));
    if (clash) throw new TransactionValidationError(`forceInputs ${clash} is also a reference input — a UTxO cannot be spent and referenced in one transaction`);
    const protectedClash = [...forcedKeys].find(k => protectedKeys.has(k));
    if (protectedClash) throw new TransactionValidationError(`forceInputs ${protectedClash} is also in protectInputs`);
    const forced: OdatanoUtxo[] = [];
    const rest: OdatanoUtxo[] = [];
    for (const u of utxos) {
      if (forcedKeys.has(key(u))) forced.push(u);
      // reference inputs, protected UTxOs and UTxOs carrying a reference script stay out of coin
      // selection and collateral; a deployed script is spent only when forced
      else if (!referenced.has(key(u)) && !protectedKeys.has(key(u)) && !hasRefScript(u)) rest.push(u);
    }
    return { forced, rest };
  }

  /**
   * Script of a withdrawal, certificate or mint: inline (swapped for a reference input that already
   * carries the same hash), by reference, or none (key witness).
   */
  private _resolveScriptWitness(
    w: { script?: string; referenceScript?: { txHash: string; outputIndex: number } },
    at: string,
    referencedByHash: ReadonlyMap<string, LedgerUTxO>,
    refUtxoByKey: ReadonlyMap<string, OdatanoUtxo>,
    scriptField = 'stakingScript'
  ): { script?: Script; refLedgerUtxo?: LedgerUTxO } {
    if (w.script) {
      const script = this._parsePlutusV3Script(w.script, `${at}.${scriptField}`);
      const referenced = referencedByHash.get(script.hash.toString());
      return referenced ? { refLedgerUtxo: referenced } : { script };
    }
    if (!w.referenceScript) return {};
    const refKey = `${w.referenceScript.txHash.toLowerCase()}#${w.referenceScript.outputIndex}`;
    const refUtxo = refUtxoByKey.get(refKey);
    if (!refUtxo) throw new TransactionValidationError(`${at}.referenceScript ${refKey} not found on-chain or already spent`);
    const refLedgerUtxo = this._mapMultiAssetUtxoToLedgerUtxo(refUtxo);
    if (!refLedgerUtxo.resolved.refScript) {
      throw new TransactionValidationError(
        `${at}.referenceScript ${refKey} carries no reference script, or its bytes are not available ` +
        `from the configured backends (Ogmios or Koios deliver them, Blockfrost only the hash)`
      );
    }
    return { refLedgerUtxo };
  }

  /**
   * Withdrawal credential hashes in ledger order, which `__WDRL_IDX__` resolves against. Buildooor
   * numbers withdrawal redeemers by hash alone, so a scripted withdrawal whose position differs
   * between the two orders would get the wrong redeemer; such a build is refused.
   */
  private _ledgerWithdrawalOrder(
    entries: ReadonlyArray<{ rewardAccount: StakeAddress; script?: Script; refLedgerUtxo?: LedgerUTxO }>
  ): string[] {
    const withHash = entries.map(e => ({
      credentialHash: e.rewardAccount.credentials.toString().toLowerCase(),
      isScript: e.rewardAccount.type === 'script',
      scripted: Boolean(e.script || e.refLedgerUtxo),
    }));
    const ledger = sortWithdrawalsLikeLedger(withHash).map(e => e.credentialHash);
    const buildooor = withHash.map(e => e.credentialHash).sort((a, b) => Buffer.compare(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')));
    const misplaced = withHash.find(e => e.scripted && ledger.indexOf(e.credentialHash) !== buildooor.indexOf(e.credentialHash));
    if (misplaced) {
      throw new TransactionValidationError(
        `withdrawals: the scripted withdrawal of credential ${misplaced.credentialHash} cannot be indexed correctly, ` +
        'because a key-credential withdrawal sorts before it by hash; move that key withdrawal into a separate transaction'
      );
    }
    return ledger;
  }

  /**
   * Forced inputs of other key addresses: the owner's payment key hash must be a required signer,
   * and every unit they bring must be spent by the outputs, so none of it lands in the sender's change.
   * Script addresses are refused; those UTxOs are script inputs.
   */
  private _checkForeignForcedInputs(forced: OdatanoUtxo[], req: TxBuildPlutusRequest): void {
    const sender = req.senderAddress.toLowerCase();
    const foreign = forced.filter(u => u.address.toLowerCase() !== sender);
    if (foreign.length === 0) return;
    const signers = new Set((req.requiredSigners ?? []).map(s => s.toLowerCase()));
    const keyOf = (u: OdatanoUtxo) => `${u.txHash}#${u.outputIndex}`;
    const byAddress = new Map<string, OdatanoUtxo[]>();
    for (const u of foreign) byAddress.set(u.address, [...(byAddress.get(u.address) ?? []), u]);
    for (const [address, utxos] of byAddress) {
      const creds = Address.fromString(address).paymentCreds;
      const refs = utxos.map(keyOf).join(', ');
      if (creds.type !== CredentialType.KeyHash) {
        throw new TransactionValidationError(`forceInputs ${refs} are at the script address ${address}; spend script UTxOs via scriptInputs`);
      }
      const keyHash = creds.hash.toString().toLowerCase();
      if (!signers.has(keyHash)) {
        throw new TransactionValidationError(
          `forceInputs ${refs} belong to ${address}; its payment key hash ${keyHash} must be in requiredSigners (the owner co-signs)`
        );
      }
    }
    const brought = new Map<string, bigint>();
    for (const u of foreign) {
      for (const a of u.amount) {
        const unit = a.unit.toLowerCase() === 'lovelace' ? 'lovelace' : a.unit;
        brought.set(unit, (brought.get(unit) ?? 0n) + BigInt(a.quantity));
      }
    }
    const spent = new Map<string, bigint>();
    for (const o of req.outputs) {
      spent.set('lovelace', (spent.get('lovelace') ?? 0n) + BigInt(o.lovelaceAmount));
      for (const a of o.assets ?? []) spent.set(a.unit, (spent.get(a.unit) ?? 0n) + BigInt(a.quantity));
    }
    for (const [unit, qty] of brought) {
      const out = spent.get(unit) ?? 0n;
      if (qty > out) {
        throw new TransactionValidationError(
          `forceInputs of other addresses bring ${qty} ${unit} but the outputs spend only ${out}; ` +
          `the difference would go to the sender's change, return it to its owner in outputs`
        );
      }
    }
  }

  /** Keys (`txhash#index`) of the reference inputs of a build, from the resolved UTxOs and the request refs. */
  private _referencedKeys(ctx: TxBuildContext, ...refs: Array<Array<{ txHash: string; outputIndex: number }> | undefined>): Set<string> {
    const keys = new Set<string>();
    for (const u of ctx.referenceInputUtxos ?? []) keys.add(`${u.txHash.toLowerCase()}#${u.outputIndex}`);
    for (const list of refs) for (const r of list ?? []) keys.add(`${r.txHash.toLowerCase()}#${r.outputIndex}`);
    return keys;
  }

  /** Map resolved CIP-31 reference input UTxOs to Buildooor LedgerUTxO; empty when none. */
  private _mapReferenceInputs(referenceInputUtxos?: OdatanoUtxo[]): LedgerUTxO[] {
    if (!referenceInputUtxos || referenceInputUtxos.length === 0) return [];
    return referenceInputUtxos.map(u => this._mapMultiAssetUtxoToLedgerUtxo(u));
  }

  /**
   * Funding contributed by extra outputs on a mint build: their summed lovelace plus, per asset
   * unit, the demand the transaction's own positive mints do not cover.
   */
  private _extraOutputsFundingAfterMint(
    mintActions: MintAction[],
    extraOutputs: NonNullable<TxBuildRequest['extraOutputs']>
  ): { lovelace: bigint; assets?: Array<{ unit: string; quantity: string }> } {
    const mintedByUnit = new Map<string, bigint>();
    for (const action of mintActions) {
      const quantity = BigInt(action.quantity);
      if (quantity > 0n) {
        const unit = action.assetUnit.toLowerCase();
        mintedByUnit.set(unit, (mintedByUnit.get(unit) ?? 0n) + quantity);
      }
    }
    const demandByUnit = new Map<string, bigint>();
    let lovelace = 0n;
    for (const extra of extraOutputs) {
      lovelace += BigInt(extra.lovelaceAmount);
      for (const asset of extra.assets ?? []) {
        const unit = asset.unit.toLowerCase();
        demandByUnit.set(unit, (demandByUnit.get(unit) ?? 0n) + BigInt(asset.quantity));
      }
    }
    const assets: Array<{ unit: string; quantity: string }> = [];
    for (const [unit, demand] of demandByUnit) {
      const uncovered = demand - (mintedByUnit.get(unit) ?? 0n);
      if (uncovered > 0n) assets.push({ unit, quantity: uncovered.toString() });
    }
    return { lovelace, ...(assets.length > 0 ? { assets } : {}) };
  }

  /**
   * Script a mint action executes under: its per-action policy when set, else the request's
   * top-level policy script.
   */
  private _mintActionScript(action: MintAction, defaultScript: Script, index: number): Script {
    if (!action.mintingPolicyScript) return defaultScript;
    return this._parsePlutusV3Script(action.mintingPolicyScript, `mintActions[${index}].mintingPolicyScript`);
  }

  /**
   * Buildooor mint entries shared by all mint flows. `scriptFor` gives each action's policy, inline
   * or as a reference-script UTxO. Each action may carry its own redeemer (falling back to the
   * request-level one); the ledger holds ONE redeemer per policy, so actions on the same policy must agree.
   */
  private _buildMintEntries(
    mintActions: MintAction[],
    scriptFor: (action: MintAction, index: number) => MintScriptSource,
    resolvedMintRedeemer: JSONValue | undefined,
    resolveCtx?: Parameters<typeof resolveIndexPlaceholders>[1]
  ) {
    const redeemerByPolicy = new Map<string, string>();
    return mintActions.map((action, index) => {
      const source = scriptFor(action, index);
      const policyHash = 'inline' in source ? source.inline.hash : source.ref.resolved.refScript!.hash;
      const actionRedeemer = action.redeemerJson !== undefined
        ? (resolveCtx ? resolveIndexPlaceholders(action.redeemerJson, resolveCtx) : action.redeemerJson)
        : resolvedMintRedeemer;
      const redeemerData = actionRedeemer !== undefined
        ? jsonToPlutusData(actionRedeemer)
        : new DataI(action.redeemer ?? 0);
      const policyId = policyHash.toString();
      // Canonical comparison over the encoded PlutusData: JSON key order must
      // not matter, and a JSON {int:0} equals the DataI(0) fallback.
      const redeemerFingerprint = dataToCbor(redeemerData).toString();
      const seen = redeemerByPolicy.get(policyId);
      if (seen !== undefined && seen !== redeemerFingerprint) {
        throw new Error(
          `mint actions under policy ${policyId} carry different redeemers — the ledger allows one redeemer per policy; ` +
          'split them into separate transactions or align the redeemers'
        );
      }
      redeemerByPolicy.set(policyId, redeemerFingerprint);
      const { assetName } = parseAssetUnit(action.assetUnit);
      return {
        value: Value.singleAsset(policyHash, Buffer.from(assetName, 'hex'), BigInt(action.quantity)),
        script: { ...source, redeemer: redeemerData }
      };
    });
  }

  /**
   * Context for insufficient-funds rejections after the collateral partition: the builder's
   * message counts only the funding pool, so the reservation would otherwise be invisible.
   */
  private _collateralPartitionContext(collateralUtxos: LedgerUTxO[], fundingUtxos: OdatanoUtxo[]): string {
    const collateralLovelace = collateralUtxos.reduce((s, u) => s + u.resolved.value.lovelaces, 0n);
    const fundingLovelace = fundingUtxos.reduce((s, u) => s + getLovelace(u), 0n);
    return `${collateralUtxos.length} UTxO(s) with ${collateralLovelace} lovelace reserved as collateral; ` +
      `${fundingUtxos.length} UTxO(s) with ${fundingLovelace} lovelace remained for coin selection`;
  }

  /**
   * Pick the smallest ADA-only UTxO covering COLLATERAL_LOVELACE as collateral and return the
   * rest as funding; excess above the floor goes back via collateralReturn when it meets min-ADA
   * (Buildooor sets no collateralReturn for ADA-only collateral). Throws without an ADA-only UTxO.
   */
  private _setupCollateral(utxos: OdatanoUtxo[]): {
    collateralUtxos: LedgerUTxO[]; fundingUtxos: OdatanoUtxo[];
    collateralReturn?: { address: Address; value: Value };
  } {
    // ADA-only and without a reference script (a deployed script is not collateral); SetCollateral uses the same rule
    const adaOnly = utxos.filter(isCollateralCandidate);
    if (adaOnly.length === 0) {
      throw new TransactionValidationError('No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral; create one with SetCollateral.');
    }

    const sorted = [...adaOnly].sort((a, b) => {
      const diff = getLovelace(a) - getLovelace(b);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });
    // smallest sufficient; if none reaches the floor, the largest available is the best bet
    const chosen = sorted.find(u => getLovelace(u) >= COLLATERAL_LOVELACE) ?? sorted[sorted.length - 1];
    if (getLovelace(chosen) < COLLATERAL_LOVELACE) {
      logger.warn(
        `Largest ADA-only UTxO (${getLovelace(chosen)} lovelace) is below the ${COLLATERAL_LOVELACE} lovelace ` +
        `collateral floor — the node will reject the transaction if collateralPercentage × fee exceeds it`
      );
    }

    const collateralUtxos = [this._mapOdatanoUtxoToLedgerUtxo(chosen)];
    const fundingUtxos = utxos.filter(
      u => !(u.txHash === chosen.txHash && u.outputIndex === chosen.outputIndex)
    );

    // Cap the at-risk amount at the floor: return the excess to the owner.
    let collateralReturn: { address: Address; value: Value } | undefined;
    const excess = getLovelace(chosen) - COLLATERAL_LOVELACE;
    if (excess > 0n) {
      const address = Address.fromString(chosen.address);
      const minAda = this.txBuilder.getMinimumOutputLovelaces(
        new TxOut({ address, value: Value.lovelaces(excess) })
      );
      if (excess >= minAda) {
        collateralReturn = { address, value: Value.lovelaces(excess) };
      }
      // excess below min-ADA: no return output possible, the whole UTxO stays at risk
    }

    return { collateralUtxos, fundingUtxos, collateralReturn };
  }

  /** Build a Ledger Value from lovelace + optional multi-asset array */
  private _buildLedgerValue(lovelace: bigint, assets?: Array<{ unit: string; quantity: string }>): Value {
    let value = Value.lovelaces(lovelace);
    if (assets) {
      for (const asset of assets) {
        if (asset.unit.toLowerCase() === 'lovelace') continue;
        if (BigInt(asset.quantity) <= 0n) continue;
        const { policyId, assetName } = parseAssetUnit(asset.unit);
        value = Value.add(value, Value.singleAsset(new Hash28(policyId), Buffer.from(assetName, 'hex'), BigInt(asset.quantity)));
      }
    }
    return value;
  }

  /** Build a TxOut with optional inline datum and optional reference script (CIP-33) */
  private _buildTxOut(address: Address, value: Value, datum?: JSONValue, refScript?: Script): TxOut {
    const params: ConstructorParameters<typeof TxOut>[0] = { address, value };
    if (datum) {
      params.datum = jsonToPlutusData(datum);
    }
    if (refScript) {
      params.refScript = refScript;
    }
    return new TxOut(params);
  }

  /**
   * Parse a CBOR-wrapped Plutus script and reject UPLC 1.0.0 code (V1/V2): Script.fromCbor
   * defaults to V3 and would hash with the 0x03 prefix, giving a silently wrong script hash.
   * The UPLC version is the first three flat naturals of the unwrapped script: [1,0,0] vs [1,1,0].
   */
  private _parsePlutusV3Script(hex: string, field: string): Script {
    let script: Script;
    try {
      script = Script.fromCbor(Buffer.from(hex, 'hex'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransactionValidationError(`Invalid ${field} CBOR: ${msg}`);
    }
    const b = script.bytes;
    if (b.length >= 3 && b[0] === 1 && b[1] === 0 && b[2] === 0) {
      throw new TransactionValidationError(
        `${field} contains UPLC 1.0.0 code (PlutusV1/V2) — ODATANO builds Plutus V3 transactions only. ` +
        `Hashing it as V3 would yield a different script hash (wrong policy ID / unspendable address).`
      );
    }
    return script;
  }

  /** Parse a Plutus V3 CBOR hex into a Buildooor Script for refScript attachment. */
  private _parseReferenceScript(hex: string | undefined): Script | undefined {
    if (!hex) return undefined;
    return ledgerScript(this._parsePlutusV3Script(hex, 'referenceScript'));
  }

  /**
   * Map an input UTxO's reference script to a Script: `scriptRefCbor` (Ogmios), else a full-CBOR
   * `scriptRef` (Koios); Blockfrost and the tables carry the 28-byte hash only, unusable locally.
   */
  private _buildInputRefScript(utxo: OdatanoUtxo): Script | undefined {
    const cbor = utxo.scriptRefCbor ?? (utxo.scriptRef && utxo.scriptRef.length > 56 ? utxo.scriptRef : undefined);
    if (!cbor) {
      if (utxo.scriptRef) logger.debug(`UTxO ${utxo.txHash}#${utxo.outputIndex} carries scriptRef hash only — local Plutus eval will not see the script`);
      return undefined;
    }
    try {
      const script = ledgerScript(Script.fromCbor(Buffer.from(cbor, 'hex')));
      // chain data, not consumer input — warn instead of rejecting
      const b = script.bytes;
      if (b.length >= 3 && b[0] === 1 && b[1] === 0 && b[2] === 0) {
        logger.warn(`Input refScript on ${utxo.txHash}#${utxo.outputIndex} is UPLC 1.0.0 (PlutusV1/V2) — treated as V3, local eval may misbehave`);
      }
      return script;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse input refScript for ${utxo.txHash}#${utxo.outputIndex}: ${msg}`);
      return undefined;
    }
  }

  /**
   * Post-sort input order so __INPUT_IDX__ placeholders resolve to the indices Buildooor assigns
   * in build(): all inputs (script, forced, funding) sorted lexicographically on (txHash, outputIndex).
   */
  private _computeSortedInputs(
    scriptUtxoRefs: Array<{ txHash: string; outputIndex: number }>,
    forcedUtxos: OdatanoUtxo[],
    fundingRefs: InputRef[]
  ): InputRef[] {
    const all: InputRef[] = [
      ...scriptUtxoRefs.map(r => ({ txHash: r.txHash, outputIndex: r.outputIndex })),
      ...forcedUtxos.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
      ...fundingRefs
    ];
    return sortInputsLikeBuildooor(all);
  }

  /** Extract InputRef list from the Buildooor-shaped funding inputs returned by keepRelevant. */
  private _extractFundingRefs(fundingInputs: Array<{ utxo: { utxoRef: { id: { toString(): string }; index: number } } }>): InputRef[] {
    return fundingInputs.map(i => ({
      txHash: i.utxo.utxoRef.id.toString(),
      outputIndex: i.utxo.utxoRef.index
    }));
  }

  /** Resolve __INPUT_IDX__ placeholders inside each extraOutput.inlineDatum; other fields pass through. */
  private _resolveExtraOutputPlaceholders(
    extraOutputs: TxBuildRequest['extraOutputs'],
    resolveCtx: { sortedInputs: InputRef[] }
  ): TxBuildRequest['extraOutputs'] {
    if (!extraOutputs || extraOutputs.length === 0) return extraOutputs;
    return extraOutputs.map(extra => ({
      ...extra,
      inlineDatum: extra.inlineDatum
        ? resolveIndexPlaceholders(extra.inlineDatum, resolveCtx)
        : undefined
    }));
  }

  /**
   * Append parsed extra outputs, enforcing min-ADA per entry; the rejection names the
   * required min-ADA so consumers can adjust without inspecting Buildooor internals.
   */
  private _appendExtraOutputs(
    outputs: TxOut[],
    extraOutputs?: TxBuildRequest['extraOutputs']
  ): void {
    if (!extraOutputs || extraOutputs.length === 0) return;
    for (let i = 0; i < extraOutputs.length; i++) {
      const extra = extraOutputs[i];
      const value = this._buildLedgerValue(BigInt(extra.lovelaceAmount), extra.assets);
      const refScript = this._parseReferenceScript(extra.referenceScript);
      const txOut = this._buildTxOut(Address.fromString(extra.address), value, extra.inlineDatum, refScript);
      const minLovelaces = this.txBuilder.getMinimumOutputLovelaces(txOut);
      if (BigInt(extra.lovelaceAmount) < minLovelaces) {
        throw new TransactionValidationError(
          `extraOutputs[${i}].lovelaceAmount (${extra.lovelaceAmount}) is below required min-ADA ${minLovelaces.toString()} for the given address/assets/datum`
        );
      }
      outputs.push(txOut);
    }
  }

  //---------------------------------------------------------------------------
  // UTxO Mapping & Configuration Helpers
  //---------------------------------------------------------------------------

  /**
   * Validity window (slots) from the request. Script builds default to `now - 2 min` / `now + 1 h`;
   * plain transfers pass explicit bounds through without defaulting.
   */
  private _resolveValiditySlots(req: Pick<TxBuildRequest, 'validityStartMs' | 'validityEndMs'>, mode: 'script' | 'passthrough'): { invalidBefore?: bigint; invalidAfter?: bigint } {
    const hasStart = req.validityStartMs !== undefined && req.validityStartMs !== null && req.validityStartMs !== '';
    const hasEnd = req.validityEndMs !== undefined && req.validityEndMs !== null && req.validityEndMs !== '';

    if (mode === 'passthrough') {
      const result: { invalidBefore?: bigint; invalidAfter?: bigint } = {};
      if (hasStart) result.invalidBefore = BigInt(this.txBuilder.posixToSlot(Number(req.validityStartMs)));
      if (hasEnd) result.invalidAfter = BigInt(this.txBuilder.posixToSlot(Number(req.validityEndMs)));
      return result;
    }

    const nowMs = Date.now();
    const startMs = hasStart ? Number(req.validityStartMs) : nowMs - DEFAULT_VALIDITY_START_OFFSET_MS;
    const endMs = hasEnd ? Number(req.validityEndMs) : nowMs + DEFAULT_VALIDITY_END_OFFSET_MS;

    const startSlot = this.txBuilder.posixToSlot(startMs);
    const endSlot = this.txBuilder.posixToSlot(endMs);

    return {
      invalidBefore: BigInt(startSlot),
      invalidAfter: BigInt(endSlot),
    };
  }

  /**
   * Map LedgerProtocolParameter to Buildooor's ProtocolParameters. Every field is null-guarded so a
   * missing value keeps the library default instead of degrading to 0 (e.g. utxoCostPerByte = 0
   * disables min-ADA); cost models and ExUnit prices feed scriptDataHash and the fee math.
   */
  private _mapLedgerParametersToBuildooorParams(protocolParameters: LedgerProtocolParameter): ProtocolParameters {
    const pp = protocolParameters;
    const d = defaultProtocolParameters;
    const mapped: ProtocolParameters = {
      ...d,
      txFeePerByte: toUInt(pp.minFeeA) ?? d.txFeePerByte,
      txFeeFixed: toUInt(pp.minFeeB) ?? d.txFeeFixed,
      utxoCostPerByte: toUInt(pp.coinsPerUtxoSize) ?? d.utxoCostPerByte,
      maxTxSize: toUInt(pp.maxTxSize) ?? d.maxTxSize,
      maxValueSize: toUInt(pp.maxValSize) ?? d.maxValueSize,
      maxBlockBodySize: toUInt(pp.maxBlockSize) ?? d.maxBlockBodySize,
      maxBlockHeaderSize: toUInt(pp.maxBlockHeaderSize) ?? d.maxBlockHeaderSize,
      stakeAddressDeposit: toUInt(pp.keyDeposit) ?? d.stakeAddressDeposit,
      stakePoolDeposit: toUInt(pp.poolDeposit) ?? d.stakePoolDeposit,
      minPoolCost: toUInt(pp.minPoolCost) ?? d.minPoolCost,
      poolRetireMaxEpoch: toUInt(pp.eMax) ?? d.poolRetireMaxEpoch,
      stakePoolTargetNum: toUInt(pp.nOpt) ?? d.stakePoolTargetNum,
      collateralPercentage: toUInt(pp.collateralPercent) ?? d.collateralPercentage,
      maxCollateralInputs: toUInt(pp.maxCollateralInputs) ?? d.maxCollateralInputs,
    };

    const maxTxExMem = toUInt(pp.maxTxExMem);
    const maxTxExSteps = toUInt(pp.maxTxExSteps);
    if (maxTxExMem !== undefined && maxTxExSteps !== undefined) {
      mapped.maxTxExecutionUnits = { memory: maxTxExMem, steps: maxTxExSteps };
    }

    const maxBlockExMem = toUInt(pp.maxBlockExMem);
    const maxBlockExSteps = toUInt(pp.maxBlockExSteps);
    if (maxBlockExMem !== undefined && maxBlockExSteps !== undefined) {
      mapped.maxBlockExecutionUnits = { memory: maxBlockExMem, steps: maxBlockExSteps };
    }

    const priceMemory = toPositiveNumber(pp.priceMem);
    const priceSteps = toPositiveNumber(pp.priceStep);
    if (priceMemory !== undefined && priceSteps !== undefined) {
      mapped.executionUnitPrices = { priceMemory, priceSteps };
    }

    const costModels = this._mapCostModels(pp.costModels);
    if (costModels) {
      mapped.costModels = costModels;
    } else {
      logger.warn(
        'Protocol parameters carry no usable cost models — keeping library defaults. ' +
        'scriptDataHash of script transactions may not match the ledger (PPViewHashesDontMatch risk).'
      );
    }

    return mapped;
  }

  /**
   * Parse the cost-models JSON (keys 'PlutusVN', 'plutus:vN' or 'PlutusScriptVN') into Buildooor's
   * CostModels; undefined when nothing usable is found. Also (re)sets this.rawCostModelArrays with
   * the unclamped chain arrays, which the scriptDataHash must cover (see _languageViewCostModels).
   */
  private _mapCostModels(costModelsJson: string | null | undefined): CostModels | undefined {
    this.rawCostModelArrays = {};
    if (!costModelsJson) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(costModelsJson);
    } catch {
      logger.warn('Failed to parse protocol-parameter cost models JSON');
      return undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

    const KEY_MAP: Record<string, 'PlutusScriptV1' | 'PlutusScriptV2' | 'PlutusScriptV3'> = {
      PlutusV1: 'PlutusScriptV1', 'plutus:v1': 'PlutusScriptV1', PlutusScriptV1: 'PlutusScriptV1',
      PlutusV2: 'PlutusScriptV2', 'plutus:v2': 'PlutusScriptV2', PlutusScriptV2: 'PlutusScriptV2',
      PlutusV3: 'PlutusScriptV3', 'plutus:v3': 'PlutusScriptV3', PlutusScriptV3: 'PlutusScriptV3',
    };
    // Buildooor's CEK Machine rejects array-form cost models — convert to named-key objects.
    const result: Record<string, unknown> = {};
    const rawArrays: RawCostModelArrays = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const target = KEY_MAP[key];
      if (!target || !Array.isArray(value)) continue;
      const arr = (value as unknown[]).map(Number);
      try {
        if (target === 'PlutusScriptV1') result[target] = toCostModelV1(arr as Parameters<typeof toCostModelV1>[0]);
        else if (target === 'PlutusScriptV2') result[target] = toCostModelV2(arr as Parameters<typeof toCostModelV2>[0]);
        else result[target] = toCostModelV3(arr as Parameters<typeof toCostModelV3>[0]);
        // Non-finite entries would break the language-view CBOR; without a raw array
        // the hash falls back to the clamped named-key form for this version.
        if (arr.every(Number.isFinite)) rawArrays[target] = arr;
      } catch {
        logger.warn(`Cost-model array for ${key} has unexpected length (${value.length}) — skipping`);
      }
    }
    if (Object.keys(result).length === 0) return undefined;
    if (!isCostModels(result)) {
      // Buildooor would silently substitute default cost models — surface it instead.
      logger.warn('Mapped cost models failed Buildooor validation — keeping library defaults');
      return undefined;
    }
    this.rawCostModelArrays = rawArrays;
    return result as CostModels;
  }

  /** Map an ADA-only UTxO to a Ledger UTxO. */
  private _mapOdatanoUtxoToLedgerUtxo(utxos: OdatanoUtxo): LedgerUTxO {
    assertAdaOnly(utxos);

    return new LedgerUTxO({
      utxoRef: new TxOutRef({ id: utxos.txHash, index: utxos.outputIndex }),
      resolved: new TxOut({
        address: Address.fromString(utxos.address),
        value: Value.lovelaces(getLovelace(utxos)),
        datum: undefined,
        refScript: this._buildInputRefScript(utxos)
      })
    });
  }

  /** Map a UTxO (with multi-assets) to a Ledger UTxO. */
  private _mapMultiAssetUtxoToLedgerUtxo(utxo: OdatanoUtxo): LedgerUTxO {
    const value = this._buildLedgerValue(getLovelace(utxo), utxo.amount);
    // Inline datum wins; otherwise carry the datum HASH: Buildooor only puts a provided datum
    // preimage into the witness set when the spent output is marked with its Hash32.
    const datumValue = utxo.inlineDatum
      ? dataFromCbor(utxo.inlineDatum)
      : utxo.datumHash
        ? new Hash32(utxo.datumHash)
        : undefined;

    return new LedgerUTxO({
      utxoRef: new TxOutRef({ id: utxo.txHash, index: utxo.outputIndex }),
      resolved: new TxOut({
        address: Address.fromString(utxo.address),
        value,
        datum: datumValue,
        refScript: this._buildInputRefScript(utxo)
      })
    });
  }

  /** Map metadata JSON (label -> value) to Ledger TxMetadata. */
  private _mapOdatanoMetadataToLedgerMetadata(metadataJson: JSONValue | undefined): TxMetadata {
    if (!metadataJson) {
      return new TxMetadata({});
    }

    const metadata: { [label: number]: TxMetadatum } = {};

    for (const [label, value] of Object.entries(metadataJson)) {
      if (!/^\d+$/.test(label)) {
        throw new TransactionValidationError(
          `Invalid metadata label "${label}" — labels must be non-negative integers`
        );
      }
      metadata[Number(label)] = this._jsonToTxMetadatum(value, label);
    }

    return new TxMetadata(metadata);
  }

  /**
   * Recursively convert a JSON value to TxMetadatum, enforcing ledger rules: integers only, text/bytes
   * over 64 BYTES chunked into a list, "0x..." strings become bytes, over-long map keys rejected.
   * @param path label-rooted position of `value` (e.g. "721.files[0].src"), named in every rejection
   */
  private _jsonToTxMetadatum(value: JSONValue, path: string): TxMetadatum {
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (typeof value === 'number' && !Number.isInteger(value)) {
        throw new TransactionValidationError(
          `Metadata numbers must be integers (got ${value} at ${path}) — encode decimals as strings`
        );
      }
      return new TxMetadatumInt(BigInt(value));
    }

    if (typeof value === 'string') {
      if (/^0x([0-9a-fA-F]{2})+$/.test(value)) {
        const bytes = Buffer.from(value.slice(2), 'hex');
        if (bytes.length <= METADATA_BYTE_LIMIT) return new TxMetadatumBytes(bytes);
        const chunks: TxMetadatum[] = [];
        for (let i = 0; i < bytes.length; i += METADATA_BYTE_LIMIT) {
          chunks.push(new TxMetadatumBytes(bytes.subarray(i, i + METADATA_BYTE_LIMIT)));
        }
        return new TxMetadatumList(chunks);
      }
      const chunks = chunkUtf8(value, METADATA_BYTE_LIMIT);
      if (chunks.length === 1) return new TxMetadatumText(value);
      return new TxMetadatumList(chunks.map(c => new TxMetadatumText(c)));
    }

    if (Array.isArray(value)) {
      return new TxMetadatumList(value.map((v, i) => this._jsonToTxMetadatum(v, `${path}[${i}]`)));
    }

    if (typeof value === 'object' && value !== null) {
      const map: Array<{ k: TxMetadatum; v: TxMetadatum }> = [];
      for (const [k, v] of Object.entries(value)) {
        if (Buffer.byteLength(k, 'utf8') > METADATA_BYTE_LIMIT) {
          throw new TransactionValidationError(
            `Metadata map key exceeds ${METADATA_BYTE_LIMIT} bytes (UTF-8) at ${path}: "${k.slice(0, 32)}…"`
          );
        }
        map.push({
          k: new TxMetadatumText(k),
          v: this._jsonToTxMetadatum(v, `${path}.${k}`)
        });
      }
      return new TxMetadatumMap(map);
    }

    throw new TransactionValidationError(
      `Unsupported metadata value type: ${value === null ? 'null' : typeof value} at ${path}` +
      (typeof value === 'boolean' ? ' — on-chain metadata has no boolean; encode as string or 0/1' : '')
    );
  }
}
