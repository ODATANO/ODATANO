import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters } from "../../utils/types";
import { TxBuilder, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace, mapBuilderError, parseAssetUnit, jsonToPlutusData } from "../../utils/tx-build-helper";
import { InsufficientFundsError, TransactionValidationError } from "../../utils/errors";
import { resolveIndexPlaceholders, sortInputsLikeBuildooor, type InputRef } from "../../utils/plutus-placeholders";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cds from "@sap/cds";
import {
  defaultProtocolParameters,
  Address,
  UTxO as LedgerUTxO,
  Value,
  TxOut,
  TxOutRef,
  Script,
  Hash28
} from "@harmoniclabs/cardano-ledger-ts";

import { TxMetadata } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata";
import {
  type TxMetadatum,
  TxMetadatumInt,
  TxMetadatumText,
  TxMetadatumList,
  TxMetadatumMap
} from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { DataI, dataFromCbor } from "@harmoniclabs/plutus-data";
import { CardanoClient } from "../cardano-client";
import { DEFAULT_EXECUTION_UNITS, HIGH_EXECUTION_UNITS, EXECUTION_UNIT_BUFFER, WITNESS_BUFFER_BYTES, MIN_CHANGE_LOVELACE } from '../../utils/const'

const logger = cds.log('BuildooorTxBuilder');

/**
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = 'BuildooorTxBuilder';
  private txBuilder!: TxBuilder;
  private cardanoClient!: CardanoClient;

  /**
   * Initialize the builder
   * @param client - The CardanoClient instance
   * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
   */
  public async init(client: CardanoClient, protocolParams?: LedgerProtocolParameters): Promise<void> {
    this.cardanoClient = client;
    const params = protocolParams ?? await client.getProtocolParameters();
    const txbParameters = this._mapLedgerParametersToBuildooorParams(params);
    this.txBuilder = new TxBuilder(txbParameters);
    logger.debug(`Initialized with protocol parameters`);
  }

  /**
   * Build unsigned transfer transaction (ADA-only or with native assets)
   */
  public async buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
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

      const outputs = [this._buildTxOut(recipientAddress, outputValue, req.outputDatum)];

      // Partition: forced UTxOs become fixed inputs; rest is the coin-selection pool
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));
      const candidateInputs = rest.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      // Coin selection on candidates only; forced inputs are prepended unconditionally
      const selected = this.txBuilder.keepRelevant(outputValue, candidateInputs);
      const inputs = [...forcedInputs, ...selected];
      logger.debug(`Coin selection: ${selected.length}/${candidateInputs.length} UTxOs selected (${forcedInputs.length} forced) for transfer`);

      const tx = await this.txBuilder.build({ inputs, outputs, changeAddress });

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { forcedInputsUsed: forcedInputs.length });
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
      const amount = BigInt(String(req.lovelaceAmount));
      const metadata = this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson);

      const outputValue = Value.lovelaces(amount);
      const outputs = [new TxOut({ address: recipientAddress, value: outputValue })];

      // Partition: forced UTxOs become fixed inputs; rest is the coin-selection pool
      const { forced, rest } = this._partitionForcedInputs(ctx.utxos, req.forceInputs);
      const forcedInputs = forced.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));
      const candidateInputs = rest.map(u => ({ utxo: this._mapMultiAssetUtxoToLedgerUtxo(u) }));

      const selected = this.txBuilder.keepRelevant(outputValue, candidateInputs);
      const inputs = [...forcedInputs, ...selected];
      logger.debug(`Coin selection: ${selected.length}/${candidateInputs.length} UTxOs selected (${forcedInputs.length} forced) for metadata transfer`);

      const tx = await this.txBuilder.build({ inputs, outputs, changeAddress, metadata });

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { forcedInputsUsed: forcedInputs.length });
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

      // Parse the minting policy script once
      const scriptBytes = Buffer.from(req.mintingPolicyScript, 'hex');
      const script = Script.fromCbor(scriptBytes);

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
      const { collateralUtxos, fundingUtxos } = this._setupCollateral(rest);
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
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedInlineDatum)];

      // Helper to build mints array with specified execution units (uses pre-resolved redeemer)
      const buildMints = (exUnits: { mem: number; cpu: number }) => {
        const mints = [];
        for (const mintAction of req.mintActions) {
          const { assetName } = parseAssetUnit(mintAction.assetUnit);
          mints.push({
            value: Value.singleAsset(script.hash, Buffer.from(assetName, 'hex'), BigInt(mintAction.quantity)),
            script: {
              inline: script,
              redeemer: resolvedMintRedeemer
                ? jsonToPlutusData(resolvedMintRedeemer)
                : new DataI(mintAction.redeemer ?? 0),
              executionUnits: exUnits
            }
          });
        }
        return mints;
      };

      // Evaluate execution units
      const finalExUnits = await this._evaluateExUnits(
        async () => {
          const evalTx = await this.txBuilder.build({
            inputs, outputs, changeAddress, mints: buildMints(HIGH_EXECUTION_UNITS),
            collaterals: collateralUtxos, requiredSigners: req.requiredSigners
          });
          return toHex(evalTx.toCbor().toBuffer());
        },
        ctx.evaluateTransaction
      );

      // Build with final execution units + witness buffer
      const mints = buildMints(finalExUnits);
      const tx = await this._buildWithWitnessBuffer({
        inputs, outputs, changeAddress, mints,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners
      });

      logger.debug(`Built unsigned minting transaction successfully with fee: ${tx.body.fee.toString()}`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { scriptHash: script.hash.toString(), forcedInputsUsed: forcedInputs.length });
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const { plutusScriptExecution } = req;

      // Parse the validator script
      const scriptBytes = Buffer.from(plutusScriptExecution.validatorScript, 'hex');
      const script = Script.fromCbor(scriptBytes);

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
        throw new Error(`Script UTxO ${scriptUtxoRef.txHash}#${scriptUtxoRef.outputIndex} not found in provided UTxOs`);
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
      const { collateralUtxos, fundingUtxos } = this._setupCollateral(rest);
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
        mintScript = Script.fromCbor(Buffer.from(req.mintingPolicyScript!, 'hex'));
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
      const outputs = [this._buildTxOut(recipientAddress, outputValue, resolvedPrimaryInlineDatum)];

      // Append extra outputs (FR-2). Each is independently min-ADA checked so consumers
      // get a clear, field-attributed error before Buildooor's coin selection runs.
      this._appendExtraOutputs(outputs, resolvedExtraOutputs);

      // Helper to build mints array (FR-1) with specified execution units
      const buildMints = hasMint
        ? (exUnits: { mem: number; cpu: number }) => req.mintActions!.map(action => {
            const { assetName } = parseAssetUnit(action.assetUnit);
            return {
              value: Value.singleAsset(mintScript!.hash, Buffer.from(assetName, 'hex'), BigInt(action.quantity)),
              script: {
                inline: mintScript!,
                redeemer: resolvedMintRedeemer
                  ? jsonToPlutusData(resolvedMintRedeemer)
                  : new DataI(action.redeemer ?? 0),
                executionUnits: exUnits
              }
            };
          })
        : undefined;

      // Helper to build inputs with specified execution units
      const buildInputs = (exUnits: { mem: number; cpu: number }) => {
        const scriptInput = {
          utxo: scriptLedgerUtxo,
          inputScript: { script, datum, redeemer: redeemerData, executionUnits: exUnits }
        };
        return [scriptInput, ...forcedInputs, ...selectedFundingInputs];
      };

      // Evaluate execution units
      const finalExUnits = await this._evaluateExUnits(
        async () => {
          const evalTx = await this.txBuilder.build({
            inputs: buildInputs(HIGH_EXECUTION_UNITS), outputs, changeAddress,
            mints: buildMints?.(HIGH_EXECUTION_UNITS),
            collaterals: collateralUtxos, requiredSigners: req.requiredSigners
          });
          if (!evalTx) {
            throw new Error('Buildooor txBuilder.build() returned null — check inputs, datum, and collateral configuration');
          }
          return toHex(evalTx.toCbor().toBuffer());
        },
        ctx.evaluateTransaction
      );

      // Build with final execution units + witness buffer
      const inputs = buildInputs(finalExUnits);
      const mints = buildMints?.(finalExUnits);
      const tx = await this._buildWithWitnessBuffer({
        inputs, outputs, changeAddress,
        mints,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners
      });

      logger.debug(`Built unsigned Plutus spending transaction successfully with fee: ${tx.body.fee.toString()}`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), {
        scriptHash: script.hash.toString(),
        mintScriptHash,
        forcedInputsUsed: forcedInputs.length
      });
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  //---------------------------------------------------------------------------
  // Shared Helper Methods
  //---------------------------------------------------------------------------

  /** Extract CBOR, hash, fee, size, inputs and outputs from a built Buildooor Tx */
  private _extractTxDetails(tx: any): {
    unsignedTxCbor: string; txBodyHash: string; sizeBytes: number;
    feeLovelace: string;
    inputRefs: Array<{ txHash: string; index: number }>;
    outputs: Array<{ address: string; lovelace: string }>;
  } {
    const unsignedTxBytes = tx.toCbor().toBuffer();
    return {
      unsignedTxCbor: toHex(unsignedTxBytes),
      txBodyHash: tx.hash.toString(),
      sizeBytes: unsignedTxBytes.length,
      feeLovelace: tx.body.fee.toString(),
      inputRefs: tx.body.inputs.map((inp: any) => ({
        txHash: inp.utxoRef.id.toString(),
        index: inp.utxoRef.index
      })),
      outputs: tx.body.outputs.map((o: any) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
    };
  }

  /** Build the standard TxBuildResult object */
  private _buildResult(
    req: TxBuildRequest, ctx: TxBuildContext,
    txDetails: ReturnType<BuildooorTxBuilder['_extractTxDetails']>,
    extra?: { scriptHash?: string; mintScriptHash?: string; forcedInputsUsed?: number }
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
   * Evaluate execution units via callback. Caller provides an async function
   * that builds the evaluation tx and returns its CBOR hex.
   */
  private async _evaluateExUnits(
    buildEvalTx: () => Promise<string>,
    evaluator?: (cbor: string) => Promise<Array<{ budget: { memory: number; cpu: number } }>>
  ): Promise<{ mem: number; cpu: number }> {
    if (!evaluator) {
      logger.debug('No evaluator available, using default execution units');
      return DEFAULT_EXECUTION_UNITS;
    }

    logger.debug('Building evaluation pass with high execution units');
    const evalTxCbor = await buildEvalTx();

    try {
      const evalResults = await evaluator(evalTxCbor);
      logger.debug(`Evaluation results: ${JSON.stringify(evalResults)}`);

      if (evalResults && evalResults.length > 0) {
        const budget = evalResults[0].budget;
        const result = {
          mem: Math.ceil(budget.memory * EXECUTION_UNIT_BUFFER),
          cpu: Math.ceil(budget.cpu * EXECUTION_UNIT_BUFFER)
        };
        logger.info(`Using evaluated execution units: mem=${result.mem}, cpu=${result.cpu}`);
        return result;
      }
    } catch (evalError: any) {
      logger.warn(`Evaluation failed, using default units: ${evalError.message}`);
    }

    return DEFAULT_EXECUTION_UNITS;
  }

  /** Two-pass build: first build to calculate fee, then rebuild with witness buffer */
  private async _buildWithWitnessBuffer(buildParams: ITxBuildArgs): Promise<any> {
    const txFirstPass = await this.txBuilder.build(buildParams);
    const calculatedFee = BigInt(txFirstPass.body.fee.toString());
    const adjustedMinFee = calculatedFee + BigInt(WITNESS_BUFFER_BYTES);
    logger.debug(`First pass fee: ${calculatedFee}, rebuilding with witness buffer: ${adjustedMinFee}`);
    return this.txBuilder.build({ ...buildParams, fee: adjustedMinFee });
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
   * Find an ADA-only UTxO for collateral, map it, and return remaining funding UTxOs.
   * Throws if no ADA-only UTxO is available.
   */
  private _setupCollateral(utxos: OdatanoUtxo[]): {
    collateralUtxos: LedgerUTxO[]; fundingUtxos: OdatanoUtxo[];
  } {
    const adaOnlyUtxo = utxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));
    if (!adaOnlyUtxo) {
      throw new Error('No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral.');
    }
    const collateralUtxos = [this._mapOdatanoUtxoToLedgerUtxo(adaOnlyUtxo)];
    const fundingUtxos = utxos.filter(
      u => !(u.txHash === adaOnlyUtxo.txHash && u.outputIndex === adaOnlyUtxo.outputIndex)
    );
    return { collateralUtxos, fundingUtxos };
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

  /** Build a TxOut with optional inline datum */
  private _buildTxOut(address: Address, value: Value, datum?: JSONValue): TxOut {
    const params: ConstructorParameters<typeof TxOut>[0] = { address, value };
    if (datum) {
      params.datum = jsonToPlutusData(datum);
    }
    return new TxOut(params);
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
  private _extractFundingRefs(fundingInputs: Array<{ utxo: { utxoRef: { id: any; index: number } } }>): InputRef[] {
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
      const txOut = this._buildTxOut(Address.fromString(extra.address), value, extra.inlineDatum);
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
   * Map ODATANO LedgerProtocolParameter to Buildooor's ProtocolParameters shape
   */
  private _mapLedgerParametersToBuildooorParams(protocolParameters: LedgerProtocolParameter): any {
    return {
      ...defaultProtocolParameters,
      txFeePerByte: Number(protocolParameters.minFeeA),
      txFeeFixed: Number(protocolParameters.minFeeB),
      utxoCostPerByte: Number(protocolParameters.coinsPerUtxoSize),
      poolDeposit: Number(protocolParameters.poolDeposit),
      keyDeposit: Number(protocolParameters.keyDeposit),
      maxTxSize: Number(protocolParameters.maxTxSize),
      maxValueSize: Number(protocolParameters.maxValSize),
    };
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
        refScript: undefined
      })
    });
  }

  /**
   * Map ODATANO UTxO to Ledger UTxO (with multi-asset support)
   */
  private _mapMultiAssetUtxoToLedgerUtxo(utxo: OdatanoUtxo): LedgerUTxO {
    const value = this._buildLedgerValue(getLovelace(utxo), utxo.amount);
    const datumValue = utxo.inlineDatum ? this._parseInlineDatum(utxo.inlineDatum) : undefined;

    return new LedgerUTxO({
      utxoRef: new TxOutRef({ id: utxo.txHash, index: utxo.outputIndex }),
      resolved: new TxOut({
        address: Address.fromString(utxo.address),
        value,
        datum: datumValue,
        refScript: undefined
      })
    });
  }

  /**
   * Parse inline datum from backend UTxO data.
   * Backends return inline datums in different formats:
   * - Koios UTxOs: JSON.stringify(datum) → JSON string
   * - Koios tx_info / Blockfrost: raw JSON object
   * - CBOR hex string (even-length hex)
   */
  private _parseInlineDatum(inlineDatum: string | object): ReturnType<typeof dataFromCbor> {
    if (typeof inlineDatum === 'string') {
      // Check if it's CBOR hex (even-length hex string)
      if (/^[0-9a-fA-F]+$/.test(inlineDatum) && inlineDatum.length % 2 === 0) {
        return dataFromCbor(inlineDatum);
      }
      // Otherwise it's a JSON string — parse and convert
      return jsonToPlutusData(JSON.parse(inlineDatum));
    }
    // Raw JSON object from backend — guard against hollow objects (all null values)
    const values = Object.values(inlineDatum);
    if (values.length > 0 && values.every(v => v === null)) {
      throw new Error('Inline datum object has only null values — UTxO likely uses datum hash, not inline datum');
    }
    return jsonToPlutusData(inlineDatum as JSONValue);
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
      const numericLabel = parseInt(label, 10);
      const txMetadatum = this._jsonToTxMetadatum(value);
      logger.debug(`Created TxMetadatum for label ${numericLabel}: ${txMetadatum.constructor.name}`);
      metadata[numericLabel] = txMetadatum;
    }

    logger.debug(`Creating TxMetadata with ${Object.keys(metadata).length} labels`);
    const txMetadata = new TxMetadata(metadata);
    logger.debug(`TxMetadata created: ${txMetadata.constructor.name}, instanceof check: ${txMetadata instanceof TxMetadata}`);
    return txMetadata;
  }

  /**
   * Recursively convert JSON value to TxMetadatum
   */
  private _jsonToTxMetadatum(value: JSONValue): TxMetadatum {
    if (typeof value === 'number' || typeof value === 'bigint') {
      return new TxMetadatumInt(BigInt(value));
    }

    if (typeof value === 'string') {
      return new TxMetadatumText(value);
    }

    if (Array.isArray(value)) {
      return new TxMetadatumList(value.map(v => this._jsonToTxMetadatum(v)));
    }

    if (typeof value === 'object' && value !== null) {
      const map: Array<{ k: TxMetadatum; v: TxMetadatum }> = [];
      for (const [k, v] of Object.entries(value)) {
        map.push({
          k: new TxMetadatumText(k),
          v: this._jsonToTxMetadatum(v)
        });
      }
      return new TxMetadatumMap(map);
    }

    throw new Error(`Unsupported metadata value type: ${typeof value}`);
  }
}
