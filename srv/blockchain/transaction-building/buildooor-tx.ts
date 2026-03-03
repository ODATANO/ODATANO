import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters } from "../../utils/types";
import { TxBuilder, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace, mapBuilderError, parseAssetUnit, jsonToPlutusData } from "../../utils/tx-build-helper";
import { InsufficientFundsError } from "../../utils/errors";
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
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));
      const allInputs = ledgerUtxos.map(utxo => ({ utxo }));

      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
      const amount = BigInt(String(req.lovelaceAmount));

      // Build output value (lovelace + optional native assets)
      let outputValue = Value.lovelaces(amount);
      if (req.assets && req.assets.length > 0) {
        outputValue = this._buildLedgerValue(amount, req.assets);
      }

      const outputs = [this._buildTxOut(recipientAddress, outputValue, req.outputDatum)];

      // Coin selection: only include UTxOs needed to cover the output value
      const inputs = this.txBuilder.keepRelevant(outputValue, allInputs);
      logger.debug(`Coin selection: ${inputs.length}/${allInputs.length} UTxOs selected for transfer`);

      const tx = await this.txBuilder.build({ inputs, outputs, changeAddress });

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx));
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));
      const allInputs = ledgerUtxos.map(utxo => ({ utxo }));

      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
      const amount = BigInt(String(req.lovelaceAmount));
      const metadata = this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson);

      const outputValue = Value.lovelaces(amount);
      const outputs = [new TxOut({ address: recipientAddress, value: outputValue })];

      // Coin selection: only include UTxOs needed to cover the output value
      const inputs = this.txBuilder.keepRelevant(outputValue, allInputs);
      logger.debug(`Coin selection: ${inputs.length}/${allInputs.length} UTxOs selected for metadata transfer`);

      const tx = await this.txBuilder.build({ inputs, outputs, changeAddress, metadata });

      logger.debug(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx));
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

      // Helper to build mints array with specified execution units
      const buildMints = (exUnits: { mem: number; cpu: number }) => {
        const mints = [];
        for (const mintAction of req.mintActions) {
          const { assetName } = parseAssetUnit(mintAction.assetUnit);
          mints.push({
            value: Value.singleAsset(script.hash, Buffer.from(assetName, 'hex'), BigInt(mintAction.quantity)),
            script: {
              inline: script,
              redeemer: req.mintRedeemer
                ? jsonToPlutusData(req.mintRedeemer)
                : new DataI(mintAction.redeemer ?? 0),
              executionUnits: exUnits
            }
          });
        }
        return mints;
      };

      // Calculate total mint value for output (only positive quantities - mints, not burns)
      let mintValue = Value.lovelaces(0n);
      for (const mintAction of req.mintActions) {
        const quantity = BigInt(mintAction.quantity);
        if (quantity > 0n) {
          const { assetName } = parseAssetUnit(mintAction.assetUnit);
          mintValue = Value.add(mintValue, Value.singleAsset(script.hash, Buffer.from(assetName, 'hex'), quantity));
        }
      }

      // Build output — recipient gets the minted assets + min ADA
      let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      outputValue = Value.add(outputValue, mintValue);
      const outputs = [this._buildTxOut(recipientAddress, outputValue, req.inlineDatum)];

      // Collateral + funding separation
      const { collateralUtxos, fundingUtxos } = this._setupCollateral(ctx.utxos);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));
      const allFundingInputs = fundingLedgerUtxos.map(utxo => ({ utxo }));

      // Coin selection: only need enough ADA from funding UTxOs (minted tokens come from thin air)
      const requiredFundingValue = Value.lovelaces(BigInt(req.lovelaceAmount));
      const inputs = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);
      logger.debug(`Coin selection: ${inputs.length}/${allFundingInputs.length} UTxOs selected for mint`);

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
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { scriptHash: script.hash.toString() });
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

      // Convert redeemer JSON to PlutusData
      const redeemerData = jsonToPlutusData(plutusScriptExecution.redeemer);

      // Determine datum: "inline" if no datum provided (assumes inline datum on UTxO), otherwise convert
      if (!plutusScriptExecution.datum) {
        // When no explicit datum is provided, the UTxO must have an inline datum.
        // If neither exists, the Plutus validator will fail with a cryptic error.
        logger.debug('No datumJson provided — expecting inline datum on script UTxO');
      }
      const datum = plutusScriptExecution.datum
        ? jsonToPlutusData(plutusScriptExecution.datum)
        : "inline" as const;

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

      // Build output — include multi-assets from script UTxO in continuing output
      const scriptNonAdaAssets = scriptOdatanoUtxo.amount.filter(
        a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n
      );
      let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE));
      if (scriptNonAdaAssets.length > 0) {
        outputValue = this._buildLedgerValue(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE), scriptOdatanoUtxo.amount);
      }
      const outputs = [this._buildTxOut(recipientAddress, outputValue, req.inlineDatum)];

      // Collateral + funding separation (from sender UTxOs only)
      const { collateralUtxos, fundingUtxos } = this._setupCollateral(senderUtxos);
      const fundingLedgerUtxos: LedgerUTxO[] = fundingUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // Coin selection: funding UTxOs only need to cover fee + min change (script UTxO covers the output)
      const allFundingInputs = fundingLedgerUtxos.map(utxo => ({ utxo }));
      const requiredFundingValue = Value.lovelaces(BigInt(req.lovelaceAmount || MIN_CHANGE_LOVELACE));
      const selectedFundingInputs = this.txBuilder.keepRelevant(requiredFundingValue, allFundingInputs);
      logger.debug(`Coin selection: ${selectedFundingInputs.length}/${allFundingInputs.length} UTxOs selected for Plutus spend`);

      // Helper to build inputs with specified execution units
      const buildInputs = (exUnits: { mem: number; cpu: number }) => {
        const scriptInput = {
          utxo: scriptLedgerUtxo,
          inputScript: { script, datum, redeemer: redeemerData, executionUnits: exUnits }
        };
        return [scriptInput, ...selectedFundingInputs];
      };

      // Evaluate execution units
      const finalExUnits = await this._evaluateExUnits(
        async () => {
          const evalTx = await this.txBuilder.build({
            inputs: buildInputs(HIGH_EXECUTION_UNITS), outputs, changeAddress,
            collaterals: collateralUtxos, requiredSigners: req.requiredSigners
          });
          return toHex(evalTx.toCbor().toBuffer());
        },
        ctx.evaluateTransaction
      );

      // Build with final execution units + witness buffer
      const inputs = buildInputs(finalExUnits);
      const tx = await this._buildWithWitnessBuffer({
        inputs, outputs, changeAddress,
        collaterals: collateralUtxos, requiredSigners: req.requiredSigners
      });

      logger.debug(`Built unsigned Plutus spending transaction successfully with fee: ${tx.body.fee.toString()}`);
      return this._buildResult(req, ctx, this._extractTxDetails(tx), { scriptHash: script.hash.toString() });
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
    extra?: { scriptHash?: string }
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
    const datumValue = utxo.inlineDatum ? dataFromCbor(utxo.inlineDatum) : undefined;

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
