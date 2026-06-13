import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters, TxEvaluator, MintAction } from "../../utils/types";
import { TxBuilder, getScriptDataHash, costModelsToLanguageViewCbor, ExBudget, isCostModels, toCostModelV1, toCostModelV2, toCostModelV3, type CostModels, type ITxBuildArgs, type ITxBuildOptions } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace, mapBuilderError, parseAssetUnit, jsonToPlutusData } from "../../utils/tx-build-helper";
import { ConfigError, InsufficientFundsError, TransactionValidationError } from "../../utils/errors";
import { resolveIndexPlaceholders, sortInputsLikeBuildooor, type InputRef } from "../../utils/plutus-placeholders";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cds from "@sap/cds";
import {
  type ProtocolParameters,
  defaultProtocolParameters,
  Address,
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

// Metadata classes are imported from the DIST paths ON PURPOSE: buildooor's
// AuxiliaryData/TxMetadata do internal `instanceof` checks against these exact
// dist-class identities, which differ from the package-root re-exports. Mixing
// root + dist identities breaks those checks at runtime. (See cbor-parse.test.)
import { TxMetadata } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata";
import {
  type TxMetadatum,
  TxMetadatumInt,
  TxMetadatumText,
  TxMetadatumList,
  TxMetadatumMap,
  TxMetadatumBytes
} from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { DataI, dataFromCbor } from "@harmoniclabs/plutus-data";
import { CardanoClient } from "../cardano-client";
import { EXECUTION_UNIT_BUFFER, ABS_CPU_BUFFER, ABS_MEM_BUFFER, MIN_CHANGE_LOVELACE, COLLATERAL_LOVELACE, GENESIS_INFOS_BY_NETWORK, DEFAULT_VALIDITY_START_OFFSET_MS, DEFAULT_VALIDITY_END_OFFSET_MS } from '../../utils/const'

const logger = cds.log('BuildooorTxBuilder');

/** A redeemer whose script failed Buildooor's local CEK evaluation during build(). */
interface LocalEvalFailure {
  tag: TxRedeemerTag;
  index: number;
  logs: string[];
}

/** Execution units as bigints (matching ExBudget's mem/cpu). */
type ExUnitsBig = { mem: bigint; cpu: bigint };

/**
 * Build options for script-bearing transactions.
 *
 * Buildooor evaluates every Plutus script locally during `build()` and unconditionally
 * stamps each redeemer with the budget its local CEK run consumed (`onEvaluationResult`
 * in TxBuilder) — execution units passed in the build args are never read. Without an
 * `onScriptInvalid` handler a local evaluation failure aborts the build; *with* one the
 * redeemer is left carrying the partial budget consumed up to the error, which would
 * fail phase-2 on-chain and forfeit the collateral if signed and submitted.
 *
 * We therefore only record local failures here; `_buildScriptTx` decides afterwards:
 * an authoritative Ogmios evaluation overrides the local result (so local false
 * negatives — e.g. cost-model drift — don't block the build), while a failure without
 * Ogmios aborts with a clear error instead of returning an unsubmittable transaction.
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
 * Parse a ledger protocol-parameter value (number or decimal string) into a
 * non-negative safe integer. Returns undefined for null/undefined/empty/invalid
 * input so callers can fall back to library defaults instead of silently
 * coercing to 0 (which e.g. disables min-ADA when applied to utxoCostPerByte).
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

/**
 * Stable identity of a protocol-parameter set. Params only change at epoch
 * boundaries, so network#epoch is sufficient; fall back to full JSON when
 * either field is missing.
 */
function protocolParamsFingerprint(p: LedgerProtocolParameter): string {
  if (p.network && p.epoch !== undefined && p.epoch !== null) return `${p.network}#${p.epoch}`;
  return JSON.stringify(p);
}

/** Ledger limit for a single text/bytes metadatum (bytes, not characters). */
const METADATA_BYTE_LIMIT = 64;

/**
 * Split a string into pieces of at most maxBytes UTF-8 bytes each, never
 * splitting inside a code point (which would produce invalid UTF-8 on-chain).
 */
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
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = 'BuildooorTxBuilder';
  private txBuilder!: TxBuilder;
  private cardanoClient!: CardanoClient;
  private genesisInfos!: NonNullable<ConstructorParameters<typeof TxBuilder>[1]>;
  private paramsFingerprint: string | undefined;

  /**
   * Initialize the builder
   * @param client - The CardanoClient instance
   * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
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
   * Rebuild the TxBuilder when the per-request protocol parameters differ from
   * the ones the current TxBuilder was constructed with. Buildooor's TxBuilder
   * has no setter for protocol params, but its constructor is cheap, so we
   * rebuild on change (effectively once per epoch) instead of staying frozen
   * at init-time parameters for the process lifetime.
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

  /**
   * Build unsigned transfer transaction (ADA-only or with native assets).
   */
  public buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    return this._buildSimpleTransfer(req, ctx, 'transfer');
  }

  /**
   * Build unsigned transfer transaction with attached metadata.
   */
  public buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    return this._buildSimpleTransfer(req, ctx, 'metadata transfer');
  }

  /**
   * Shared non-script transfer build. The two public entry points only differ in
   * the optional pieces of the request they carry (assets/outputDatum on the
   * plain-transfer path, metadataJson on the metadata path) — all handled here
   * conditionally on the field being present, so behaviour matches both.
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

      // Build output value (lovelace + optional native assets)
      let outputValue = Value.lovelaces(amount);
      if (req.assets && req.assets.length > 0) {
        outputValue = this._buildLedgerValue(amount, req.assets);
      }

      const refScript = this._parseReferenceScript(req.referenceScript);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, req.outputDatum, refScript)];

      // Partition: forced UTxOs become fixed inputs; rest is the coin-selection pool
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs);
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
      const tx = await this.txBuilder.build({ inputs, outputs, changeAddress, ...(metadata && { metadata }), ...validity });

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { forcedInputsUsed: forcedInputs.length });
    } catch (err: unknown) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      this._ensureCurrentProtocolParameters(ctx);
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

      // Parse the minting policy script once
      const script = this._parsePlutusV3Script(req.mintingPolicyScript, 'mintingPolicyScript');

      // Calculate total mint value for output (only positive quantities - mints, not burns)
      let mintValue = Value.lovelaces(0n);
      for (const mintAction of req.mintActions) {
        const quantity = BigInt(mintAction.quantity);
        if (quantity > 0n) {
          const { assetName } = parseAssetUnit(mintAction.assetUnit);
          mintValue = Value.add(mintValue, Value.singleAsset(script.hash, Buffer.from(assetName, 'hex'), quantity));
        }
      }

      // Partition forced vs candidate UTxOs. Forced inputs are already committed;
      // collateral and coin selection operate on the remainder only.
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Collateral + funding separation (from candidates only — forced inputs cannot double as collateral)
      const { collateralUtxos, fundingUtxos, collateralReturn } = this._setupCollateral(rest);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));
      const allFundingInputs = fundingLedgerUtxos.map(utxo => ({ utxo }));

      // Coin selection: only need enough ADA from funding UTxOs (minted tokens come from thin air)
      const requiredFundingValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      const selectedFunding = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);
      const inputs = [...forcedInputs, ...selectedFunding];
      logger.debug(`Coin selection: ${selectedFunding.length}/${allFundingInputs.length} UTxOs selected (${forcedInputs.length} forced) for mint`);

      // FR-3: resolve __INPUT_IDX__ placeholders in mintRedeemer + inlineDatum after final input order is known.
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

      // Build output — recipient gets the minted assets + min ADA
      let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      outputValue = Value.add(outputValue, mintValue);
      const refScript = this._parseReferenceScript(req.referenceScript);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedInlineDatum, refScript)];

      // Mint entries for the build args (uses pre-resolved redeemer). Note: Buildooor
      // ignores caller-supplied execution units — the real units are stamped into the
      // redeemers post-build by _buildScriptTx.
      const mints = this._buildMintEntries(req.mintActions, script, resolvedMintRedeemer);

      // CIP-31: map resolved reference input UTxOs to Buildooor LedgerUTxO format
      const readonlyRefInputs = this._mapReferenceInputs(ctx.referenceInputUtxos);

      // Resolve validity bounds once — both passes must share them so redeemer ExUnits
      // and fee computation stay consistent (a mismatch would force re-evaluation).
      const { invalidBefore, invalidAfter } = this._resolveValiditySlots(req, 'script');

      // CIP-20 / label-674 etc. auxiliary metadata. Must be identical across eval + final
      // passes since auxiliary_data affects both tx size (→ fee) and script data hash (indirectly via tx hash).
      const mintMetadata = req.metadataJson
        ? this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson)
        : undefined;

      // Single set of build args — both internal passes and the Ogmios evaluation share
      // validity bounds and metadata so redeemer ExUnits and fee stay consistent.
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
      mapBuilderError(err);
    }
  }

  public async buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      this._ensureCurrentProtocolParameters(ctx);
      const { plutusScriptExecution } = req;

      // Parse the validator script
      const script = this._parsePlutusV3Script(plutusScriptExecution.validatorScript, 'plutusScriptExecution.validatorScript');

      if (!plutusScriptExecution.datum) {
        // When no explicit datum is provided, the UTxO must have an inline datum.
        // If neither exists, the Plutus validator will fail with a cryptic error.
        logger.debug('No datumJson provided — expecting inline datum on script UTxO');
      }

      // Find the specific script UTxO in the provided context UTxOs
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
      const { forced, rest } = this._partitionForcedInputs(senderUtxos, forceInputsFiltered);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Collateral + funding separation (from candidates only — forced inputs cannot double as collateral)
      const { collateralUtxos, fundingUtxos, collateralReturn } = this._setupCollateral(rest);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // Coin selection: funding UTxOs only need to cover fee + min change (script UTxO covers the output).
      // Extra outputs (FR-2) add their lovelace + assets to the requirement; assets that the script UTxO
      // already provides will net out, so over-requesting is harmless — keepRelevant prefers smaller sets.
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

      // FR-3: compute the final input order (replicates Buildooor's lex sort) and resolve any
      // __INPUT_IDX__ placeholders in redeemer / datum / output datums BEFORE PlutusData encoding.
      const sortedInputs = this._computeSortedInputs(scriptUtxoRef, forced, this._extractFundingRefs(selectedFundingInputs));
      const resolveCtx = { sortedInputs };
      const resolvedRedeemer = resolveIndexPlaceholders(plutusScriptExecution.redeemer, resolveCtx);
      const redeemerData = jsonToPlutusData(resolvedRedeemer);
      const datum = plutusScriptExecution.datum
        ? jsonToPlutusData(resolveIndexPlaceholders(plutusScriptExecution.datum, resolveCtx))
        : "inline" as const;
      const resolvedPrimaryInlineDatum = req.inlineDatum
        ? resolveIndexPlaceholders(req.inlineDatum, resolveCtx)
        : undefined;
      const resolvedExtraOutputs = this._resolveExtraOutputPlaceholders(req.extraOutputs, resolveCtx);
      const resolvedMintRedeemer = req.mintRedeemer
        ? resolveIndexPlaceholders(req.mintRedeemer, resolveCtx)
        : undefined;

      // FR-1: combined spend+mint flow. When mintActions are present, build mints alongside the spend input.
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
        for (const action of req.mintActions!) {
          const qty = BigInt(action.quantity);
          if (qty > 0n) {
            const { assetName } = parseAssetUnit(action.assetUnit);
            outputValue = Value.add(outputValue, Value.singleAsset(mintScript!.hash, Buffer.from(assetName, 'hex'), qty));
          }
        }
      }
      const primaryRefScript = this._parseReferenceScript(req.referenceScript);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedPrimaryInlineDatum, primaryRefScript)];

      // Append extra outputs (FR-2). Each is independently min-ADA checked so consumers
      // get a clear, field-attributed error before Buildooor's coin selection runs.
      this._appendExtraOutputs(outputs, resolvedExtraOutputs);

      // Mint entries (FR-1) and inputs for the build args. Note: Buildooor ignores
      // caller-supplied execution units — the real units are stamped into the
      // redeemers post-build by _buildScriptTx.
      const mints = hasMint
        ? this._buildMintEntries(req.mintActions!, mintScript!, resolvedMintRedeemer)
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

      // Single set of build args — both internal passes and the Ogmios evaluation share
      // validity bounds so redeemer ExUnits and fee stay consistent.
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
      mapBuilderError(err);
    }
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
    };
  }

  /** Build the standard TxBuildResult object */
  private _buildResult(
    req: TxBuildRequest, ctx: TxBuildContext,
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
      ...extra,
      warnings: [],
    };
  }

  /**
   * Build a script-bearing transaction whose redeemers carry *real* execution units and
   * whose fee covers them.
   *
   * Background (verified against the vendored Buildooor source): `initTxBuild` constructs
   * every redeemer with a dummy budget — caller-supplied execution units in the build args
   * are never read — and `onEvaluationResult` unconditionally stamps each redeemer with
   * the budget the local CEK run consumed, even when the script failed (partial budget).
   * So the declared units are whatever the *local* evaluation produced, and any cushion
   * passed into the args silently evaporates. This method makes the declared units real:
   *
   *   1. First pass: build once; redeemers now carry the local CEK budgets.
   *   2. Evaluate that CBOR via Ogmios (when configured) for authoritative per-redeemer
   *      budgets, cushioned by EXECUTION_UNIT_BUFFER / ABS_*_BUFFER.
   *   3. Resolve target units per redeemer (Ogmios beats buffered-local; a local failure
   *      without an Ogmios result aborts — see makeScriptBuildOpts).
   *   4. Second pass with a fee floor covering the target units (Buildooor prices the fee
   *      from its own local budgets, so the floor adds the price + encoding-size delta).
   *   5. Stamp the target units into the redeemers and recompute scriptDataHash.
   */
  private async _buildScriptTx(buildParams: ITxBuildArgs, evaluator?: TxEvaluator): Promise<LedgerTx> {
    const pass1Failures: LocalEvalFailure[] = [];
    const tx1 = await this.txBuilder.build(buildParams, makeScriptBuildOpts(pass1Failures));
    if (!tx1) {
      throw new TransactionValidationError('Buildooor txBuilder.build() returned null — check inputs, datum, and collateral configuration');
    }
    const rdmrs1 = tx1.witnesses.redeemers ?? [];
    if (rdmrs1.length === 0) {
      // Defensive — callers always attach a script. Nothing to evaluate or stamp,
      // and Buildooor's calcMinFee already budgets the vkey witnesses to come.
      return tx1;
    }

    // The first-pass CBOR is exactly what a dedicated "evaluation build" would produce
    // (identical args ⇒ identical tx, since passed ExUnits are ignored anyway).
    const evaluatedUnits = evaluator
      ? await this._evaluateExUnitsByRedeemer(toHex(tx1.toCbor()), evaluator)
      : undefined;
    if (!evaluator) {
      logger.debug('No evaluator available — falling back to buffered local execution units');
    }

    const targets1 = this._resolveTargetExUnits(rdmrs1, evaluatedUnits, pass1Failures);

    // Fee floor: Buildooor's fee covers its local budgets AND the vkey witnesses to
    // come (calcMinFee budgets 104 bytes per estimated signer); add only the price
    // delta of the stamped units, their (slightly longer) CBOR encoding, and a small
    // pad for change-output size wobble between the two passes.
    const feeFloor = BigInt(tx1.body.fee.toString())
      + this._exUnitsPriceDelta(rdmrs1, targets1)
      + this._exUnitsSizeDelta(rdmrs1, targets1) * this._txFeePerByte()
      + 10n * this._txFeePerByte();

    const pass2Failures: LocalEvalFailure[] = [];
    const tx2 = await this.txBuilder.build({ ...buildParams, fee: feeFloor }, makeScriptBuildOpts(pass2Failures));
    const rdmrs2 = tx2.witnesses.redeemers ?? [];
    const targets2 = this._resolveTargetExUnits(rdmrs2, evaluatedUnits, pass2Failures);
    return this._stampExecUnits(tx2, targets2);
  }

  /**
   * Evaluate a transaction via Ogmios and return cushioned budgets keyed per redeemer
   * (`tag:index`). Returns undefined when the evaluation is unusable (transient backend
   * failure, empty result) so callers fall back to buffered local units. A
   * TransactionValidationError from the evaluator is authoritative (the script really
   * failed) and is rethrown.
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
          // Legacy "purpose:index" form
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
      if (evalError instanceof TransactionValidationError) {
        // Authoritative: the evaluator executed the script and it failed.
        throw evalError;
      }
      const msg = evalError instanceof Error ? evalError.message : String(evalError);
      logger.warn(`Evaluation failed (transient), falling back to local execution units: ${msg}`);
      return undefined;
    }
  }

  /**
   * Combined cushion: relative multiplier catches proportional drift on large
   * validators, absolute floor catches sub-percent drift on small ones (observed
   * when metadata affects the real tx body vs the evaluator's ScriptContext).
   */
  private _applyExUnitBuffer(mem: number | bigint, cpu: number | bigint): ExUnitsBig {
    return {
      mem: BigInt(Math.ceil(Number(mem) * EXECUTION_UNIT_BUFFER) + ABS_MEM_BUFFER),
      cpu: BigInt(Math.ceil(Number(cpu) * EXECUTION_UNIT_BUFFER) + ABS_CPU_BUFFER)
    };
  }

  /**
   * Decide the execution units each redeemer must declare.
   * - Local run succeeded + Ogmios result → max of both (local is a real lower bound).
   * - Local run succeeded, no Ogmios → buffered local (cushions local↔ledger drift).
   * - Local run failed + Ogmios result → Ogmios (the local partial budget is meaningless).
   * - Local run failed, no Ogmios → abort: declaring unreliable units would forfeit the
   *   collateral of whoever signs and submits the returned CBOR.
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
   * Replace the redeemers' execution units and recompute scriptDataHash.
   *
   * Not implemented via TxBuilder.overrideTxRedeemers: that method computes the script
   * data hash from the OLD witness set (library bug), which would yield a phase-1
   * rejection (PPViewHashesDontMatch). We rebuild the witness set first and hash it with
   * the same exported getScriptDataHash + language views the build itself uses.
   */
  private _stampExecUnits(tx: LedgerTx, targets: ExUnitsBig[]): LedgerTx {
    const rdmrs = tx.witnesses.redeemers ?? [];
    const unchanged = rdmrs.every((r, i) =>
      BigInt(r.execUnits.mem) === targets[i].mem && BigInt(r.execUnits.cpu) === targets[i].cpu
    );
    if (unchanged) return tx;

    const stamped = rdmrs.map((r, i) => new TxRedeemer({
      tag: r.tag,
      index: r.index,
      data: r.data,
      execUnits: new ExBudget({ mem: targets[i].mem, cpu: targets[i].cpu })
    }));
    const newWitnesses = new TxWitnessSet({ ...tx.witnesses, vkeyWitnesses: [], redeemers: stamped });
    const languageViews = costModelsToLanguageViewCbor(
      this.txBuilder.protocolParamters.costModels,
      this._usedLanguageViewOpts(tx)
    );
    const newBody = new TxBody({ ...tx.body, scriptDataHash: getScriptDataHash(newWitnesses, languageViews) });
    const finalTx = new LedgerTx({ ...tx, body: newBody, witnesses: newWitnesses });
    logger.info(`Stamped execution units into ${stamped.length} redeemer(s): ` +
      stamped.map(s => `${txRedeemerTagToString(s.tag)}:${s.index} mem=${s.execUnits.mem} cpu=${s.execUnits.cpu}`).join('; '));
    return finalTx;
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
   * Split UTxOs into forced inputs (must be consumed) and remaining candidates (free for
   * coin selection / collateral). Refs in forceInputs that are not present in utxos are
   * silently ignored — the resolver upstream has already validated existence.
   */
  private _partitionForcedInputs(
    utxos: OdatanoUtxo[],
    forceInputs?: Array<{ txHash: string; outputIndex: number }>
  ): { forced: OdatanoUtxo[]; rest: OdatanoUtxo[] } {
    if (!forceInputs || forceInputs.length === 0) return { forced: [], rest: utxos };
    const forcedKeys = new Set(forceInputs.map(r => `${r.txHash}#${r.outputIndex}`));
    const forced: OdatanoUtxo[] = [];
    const rest: OdatanoUtxo[] = [];
    for (const u of utxos) {
      if (forcedKeys.has(`${u.txHash}#${u.outputIndex}`)) forced.push(u);
      else rest.push(u);
    }
    return { forced, rest };
  }

  /**
   * Map resolved CIP-31 reference input UTxOs to Buildooor LedgerUTxO format.
   * Returns empty array when no reference inputs are provided.
   */
  private _mapReferenceInputs(referenceInputUtxos?: OdatanoUtxo[]): LedgerUTxO[] {
    if (!referenceInputUtxos || referenceInputUtxos.length === 0) return [];
    return referenceInputUtxos.map(u => this._mapMultiAssetUtxoToLedgerUtxo(u));
  }

  /**
   * Build the Buildooor mint-entry array shared by the mint-only flow and the
   * combined spend+mint flow (Buildooor ignores caller-supplied execution units;
   * they are stamped into the redeemers post-build by _buildScriptTx).
   */
  private _buildMintEntries(mintActions: MintAction[], mintScript: Script, resolvedMintRedeemer: JSONValue | undefined) {
    return mintActions.map(action => {
      const { assetName } = parseAssetUnit(action.assetUnit);
      return {
        value: Value.singleAsset(mintScript.hash, Buffer.from(assetName, 'hex'), BigInt(action.quantity)),
        script: {
          inline: mintScript,
          redeemer: resolvedMintRedeemer
            ? jsonToPlutusData(resolvedMintRedeemer)
            : new DataI(action.redeemer ?? 0)
        }
      };
    });
  }

  /**
   * Pick a collateral UTxO and return remaining funding UTxOs.
   * Throws if no ADA-only UTxO is available.
   *
   * Selection: the SMALLEST ADA-only UTxO that still covers the static
   * COLLATERAL_LOVELACE floor (5 ADA ≳ collateralPercentage × any realistic fee).
   * The previous "first ADA-only" pick failed both ways: a dust UTxO below
   * collateralPercentage × fee is rejected at submit, and a large UTxO is
   * fully forfeited on phase-2 failure (Buildooor sets no collateralReturn
   * for ADA-only collateral). Everything above the floor is therefore handed
   * back via an explicit collateralReturn when the excess satisfies min-ADA.
   */
  private _setupCollateral(utxos: OdatanoUtxo[]): {
    collateralUtxos: LedgerUTxO[]; fundingUtxos: OdatanoUtxo[];
    collateralReturn?: { address: Address; value: Value };
  } {
    const adaOnly = utxos.filter(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));
    if (adaOnly.length === 0) {
      throw new TransactionValidationError('No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral.');
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
      // excess below min-ADA: no return output possible — whole UTxO stays at risk,
      // but by selection it is the smallest sufficient one.
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
   * Parse a consumer-provided, CBOR-wrapped Plutus script and reject UPLC 1.0.0
   * code (PlutusV1/V2). `Script.fromCbor` defaults to PlutusV3, so V1/V2 bytes
   * would be hashed with the 0x03 prefix — a silently wrong script hash, i.e.
   * wrong policy IDs and unspendable script addresses with no error anywhere
   * down the line. The UPLC version is the first three flat-encoded naturals
   * of the unwrapped script: [1,0,0] (V1/V2) vs [1,1,0] (V3).
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
    return this._parsePlutusV3Script(hex, 'referenceScript');
  }

  /**
   * Map an input UTxO's scriptRef field to a Buildooor Script when possible.
   * UTxO.scriptRef is overloaded across backends: Blockfrost/Ogmios set it to a 28-byte
   * hash (56 hex chars), Koios sets it to the full CBOR script bytes. Only full bytes
   * are usable here — hash-only entries are preserved only on-chain, not in local eval.
   */
  private _buildInputRefScript(utxo: OdatanoUtxo): Script | undefined {
    if (!utxo.scriptRef) return undefined;
    if (utxo.scriptRef.length <= 56) {
      logger.debug(`UTxO ${utxo.txHash}#${utxo.outputIndex} carries scriptRef hash only — local Plutus eval will not see the script`);
      return undefined;
    }
    try {
      const script = Script.fromCbor(Buffer.from(utxo.scriptRef, 'hex'));
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
   * Compute the post-sort input order so __INPUT_IDX__ placeholders (FR-3) resolve to the
   * same indices Buildooor will assign during build(). Order: script-input first by convention,
   * then forced + funding sorted lexicographically on (txHash, outputIndex).
   * Buildooor sorts ALL inputs together; we mirror that exact behaviour via sortInputsLikeBuildooor.
   */
  private _computeSortedInputs(
    scriptUtxoRef: { txHash: string; outputIndex: number },
    forcedUtxos: OdatanoUtxo[],
    fundingRefs: InputRef[]
  ): InputRef[] {
    const all: InputRef[] = [
      { txHash: scriptUtxoRef.txHash, outputIndex: scriptUtxoRef.outputIndex },
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

  /**
   * Resolve __INPUT_IDX__ placeholders (FR-3) inside each extraOutput.inlineDatum.
   * Returns a new array with resolved datums; non-datum fields pass through unchanged.
   */
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
   * Append parsed extraOutputs (FR-2) to the outputs array, enforcing min-ADA per entry.
   * Throws TransactionValidationError with the required min-ADA in the message so consumers
   * can adjust without having to inspect Buildooor internals.
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
   * Resolve the transaction's validity window (slots) from the request.
   * Falls back to `now - 2 min` / `now + 1 h` when the request omits bounds.
   * Script-validated builds must call this; plain transfers pass their own
   * explicit bounds through (no defaulting) so replay behavior is opt-in.
   */
  private _resolveValiditySlots(req: TxBuildRequest, mode: 'script' | 'passthrough'): { invalidBefore?: bigint; invalidAfter?: bigint } {
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
   * Map ODATANO LedgerProtocolParameter to Buildooor's ProtocolParameters shape.
   *
   * Every field is null-guarded: a missing/null source value keeps the library
   * default instead of degrading to 0 (`Number(null) === 0` previously set
   * utxoCostPerByte = 0, disabling min-ADA checks entirely). Cost models and
   * execution-unit prices are mapped because they feed the scriptDataHash
   * (language views) and the fee/ExUnits math — stale defaults there cause
   * PPViewHashesDontMatch or fee underestimation on-chain.
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
   * Parse the cost-models JSON blob (backend-normalized number arrays, keys
   * 'PlutusV1'/'PlutusV2'/'PlutusV3' or Ogmios 'plutus:vN') into Buildooor's
   * CostModels shape ('PlutusScriptVN' keys). Returns undefined when nothing
   * usable is found, so the caller can keep defaults and warn.
   */
  private _mapCostModels(costModelsJson: string | null | undefined): CostModels | undefined {
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
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const target = KEY_MAP[key];
      if (!target || !Array.isArray(value)) continue;
      const arr = (value as unknown[]).map(Number);
      try {
        if (target === 'PlutusScriptV1') result[target] = toCostModelV1(arr as Parameters<typeof toCostModelV1>[0]);
        else if (target === 'PlutusScriptV2') result[target] = toCostModelV2(arr as Parameters<typeof toCostModelV2>[0]);
        else result[target] = toCostModelV3(arr as Parameters<typeof toCostModelV3>[0]);
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
    return result as CostModels;
  }

  /**
   * Map ODATANO UTxO to Ledger UTxO (ADA-only)
   */
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

  /**
   * Map ODATANO UTxO to Ledger UTxO (with multi-asset support)
   */
  private _mapMultiAssetUtxoToLedgerUtxo(utxo: OdatanoUtxo): LedgerUTxO {
    const value = this._buildLedgerValue(getLovelace(utxo), utxo.amount);
    // Inline datum wins; otherwise carry the datum HASH into the resolved TxOut —
    // Buildooor only includes a provided datum preimage in the witness set when the
    // spent output is marked with its Hash32 (pushWitDatum). Dropping the hash here
    // silently discards the preimage → MissingRequiredDatums on submit.
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

  /**
   * Map ODATANO metadata JSON to Ledger TxMetadata
   */
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
      metadata[Number(label)] = this._jsonToTxMetadatum(value);
    }

    return new TxMetadata(metadata);
  }

  /**
   * Recursively convert JSON value to TxMetadatum.
   *
   * Ledger rules enforced here (instead of a node-side rejection or a raw 500):
   * - numbers must be integers (BigInt(1.5) would throw a bare RangeError)
   * - text and byte values are limited to 64 BYTES per metadatum — longer values
   *   are chunked into a list of ≤64-byte pieces (the established convention,
   *   e.g. CIP-25 long strings)
   * - strings prefixed with "0x" (even hex length) become byte metadata
   * - map keys are not auto-chunked (readers match on the literal key) — over-long
   *   keys are rejected with a clear 400
   */
  private _jsonToTxMetadatum(value: JSONValue): TxMetadatum {
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (typeof value === 'number' && !Number.isInteger(value)) {
        throw new TransactionValidationError(
          `Metadata numbers must be integers (got ${value}) — encode decimals as strings`
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
      return new TxMetadatumList(value.map(v => this._jsonToTxMetadatum(v)));
    }

    if (typeof value === 'object' && value !== null) {
      const map: Array<{ k: TxMetadatum; v: TxMetadatum }> = [];
      for (const [k, v] of Object.entries(value)) {
        if (Buffer.byteLength(k, 'utf8') > METADATA_BYTE_LIMIT) {
          throw new TransactionValidationError(
            `Metadata map key exceeds ${METADATA_BYTE_LIMIT} bytes (UTF-8): "${k.slice(0, 32)}…"`
          );
        }
        map.push({
          k: new TxMetadatumText(k),
          v: this._jsonToTxMetadatum(v)
        });
      }
      return new TxMetadatumMap(map);
    }

    throw new TransactionValidationError(`Unsupported metadata value type: ${typeof value}`);
  }
}
