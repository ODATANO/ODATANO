import cds from '@sap/cds'
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import blake2b from "blake2b";
import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters } from "../../utils/types";
import { getLovelace, mapBuilderError, parseAssetUnit } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import { CardanoClient } from '../cardano-client';
import { DEFAULT_EXECUTION_UNITS, HIGH_EXECUTION_UNITS, EXECUTION_UNIT_BUFFER } from '../../utils/const';
import { toCostModelArrV3, costModelsToLanguageViewCbor } from '@harmoniclabs/cardano-costmodels-ts';

const logger = cds.log('CSLTxBuilder');

/**
 * CSLTxBuilder - Implementation of CardanoTxBuilder using cardano-serialization-lib (CSL)
 */
export class CSLTxBuilder implements CardanoTxBuilder {
  public readonly name = "CslTxBuilder";
  private txBuilderConfig!: CSL.TransactionBuilderConfig;
  private protocolParameters!: LedgerProtocolParameter; // Store for cost models
  private cardanoClient!: CardanoClient;

  /**
   * Initialize the builder
   * @param cardanoClient - The CardanoClient instance
   * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
   */
  public async init(cardanoClient: CardanoClient, protocolParams?: LedgerProtocolParameters): Promise<void> {
    this.protocolParameters = protocolParams ?? await cardanoClient.getProtocolParameters();
    this.txBuilderConfig = this._createTxBuilderConfig(this.protocolParameters);
    this.cardanoClient = cardanoClient;
    logger.info(`Initialized with protocol parameters.`);
  }

  /**
   * Build unsigned transfer transaction (ADA-only or with native assets)
   */
  public async buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
      const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);
      const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);
      const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

      // Build output value (lovelace + optional native assets)
      const outValue = CSL.Value.new(CSL.BigNum.from_str(String(req.lovelaceAmount)));
      if (req.assets && req.assets.length > 0) {
        outValue.set_multiasset(this._buildCslMultiAsset(req.assets));
      }

      const out = CSL.TransactionOutput.new(recipientAddress, outValue);
      this._attachInlineDatum(out, req.outputDatum);
      txb.add_output(out);

      txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      txb.add_change_if_needed(changeAddress);

      const unsignedTx = txb.build_tx();
      const txDetails = this._extractTxDetails(unsignedTx);
      logger.info(`Built unsigned transaction successfully.`);
      return this._buildResult(req, ctx, txDetails);
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
      const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);
      const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);
      const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

      const amount = CSL.BigNum.from_str(String(req.lovelaceAmount));
      const outValue = CSL.Value.new(amount);
      const out = CSL.TransactionOutput.new(recipientAddress, outValue);
      txb.add_output(out);

      if (req.metadataJson) {
        const metadata = this._mapOdatanoMetadataToCSLMetadata(req.metadataJson);
        txb.set_metadata(metadata);
      }

      txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      txb.add_change_if_needed(changeAddress);

      const unsignedTx = txb.build_tx();
      const txDetails = this._extractTxDetails(unsignedTx);
      logger.info(`Built unsigned transaction with metadata successfully.`);
      return this._buildResult(req, ctx, txDetails);
    } catch (err: any) {
      mapBuilderError(err);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const finalExUnits = await this._evaluateExUnits(
        (exUnits) => this._buildMintTx(req, ctx, exUnits),
        ctx.evaluateTransaction
      );

      const unsignedTx = this._buildMintTx(req, ctx, finalExUnits);
      const txDetails = this._extractTxDetails(unsignedTx);
      const { hashHex: scriptHash } = this._computeScriptHash(req.mintingPolicyScript);

      logger.info(`Built unsigned minting transaction successfully. Fee: ${txDetails.feeLovelace}`);
      return this._buildResult(req, ctx, txDetails, { scriptHash });
    } catch (error: any) {
      logger.error(`BuildUnsignedMintTransaction error: ${error?.message || error}`);
      mapBuilderError(error);
    }
  }

  /**
   * Helper to build mint transaction with specified execution units
   */
  private _buildMintTx(
    req: TxBuildMintRequest,
    ctx: TxBuildContext,
    exUnits: { mem: string; cpu: string }
  ): CSL.Transaction {
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);
    const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

    const { plutusScript, cslHash: scriptHash } = this._computeScriptHash(req.mintingPolicyScript);
    const scriptSource = CSL.PlutusScriptSource.new(plutusScript);

    // Create MintBuilder and track total minted value for output
    const mintBuilder = CSL.MintBuilder.new();
    let totalMintedValue = CSL.Value.new(CSL.BigNum.from_str('0'));

    for (const mintAction of req.mintActions) {
      const { assetName } = parseAssetUnit(mintAction.assetUnit);
      const cslAssetName = CSL.AssetName.new(Buffer.from(assetName, 'hex'));
      const mintQuantity = CSL.Int.new_i32(Number(mintAction.quantity));

      const redeemerData = req.mintRedeemer
        ? this._toPlutusData(req.mintRedeemer)
        : CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(mintAction.redeemer ?? 0)));

      const redeemer = CSL.Redeemer.new(
        CSL.RedeemerTag.new_mint(),
        CSL.BigNum.from_str('0'),
        redeemerData,
        CSL.ExUnits.new(CSL.BigNum.from_str(exUnits.mem), CSL.BigNum.from_str(exUnits.cpu))
      );

      const mintWitness = CSL.MintWitness.new_plutus_script(scriptSource, redeemer);
      mintBuilder.add_asset(mintWitness, cslAssetName, mintQuantity);

      if (Number(mintAction.quantity) > 0) {
        const assetValue = CSL.Value.new(CSL.BigNum.from_str('0'));
        const multiAsset = CSL.MultiAsset.new();
        const assets = CSL.Assets.new();
        assets.insert(cslAssetName, CSL.BigNum.from_str(String(mintAction.quantity)));
        multiAsset.insert(scriptHash, assets);
        assetValue.set_multiasset(multiAsset);
        totalMintedValue = totalMintedValue.checked_add(assetValue);
      }
    }

    txb.set_mint_builder(mintBuilder);
    this._addRequiredSigners(txb, req.requiredSigners);

    // Create output with minted assets + minimum lovelace
    const outputValue = CSL.Value.new(CSL.BigNum.from_str(String(req.lovelaceAmount)));
    const finalOutputValue = outputValue.checked_add(totalMintedValue);
    const recipientOutput = CSL.TransactionOutput.new(recipientAddress, finalOutputValue);
    this._attachInlineDatum(recipientOutput, req.inlineDatum);
    txb.add_output(recipientOutput);

    // Collateral + funding UTxO separation
    const { fundingUtxos } = this._setupCollateral(txb, ctx.utxos);

    // Greedy coin selection: only include funding UTxOs until we have enough ADA.
    // We still add inputs explicitly (not via add_inputs_from) because CSL does not
    // properly forward native tokens from selected inputs to the change output
    // during Plutus minting transactions, causing ValueNotConservedUTxO.
    const requiredLovelace = BigInt(req.lovelaceAmount) + 5_000_000n; // output + buffer for fee + min change
    const selectedFundingUtxos = this._selectMinimalUtxos(fundingUtxos, requiredLovelace);
    logger.debug(`Coin selection: ${selectedFundingUtxos.length}/${fundingUtxos.length} UTxOs selected for CSL mint`);

    const fundingInputsBuilder = CSL.TxInputsBuilder.new();
    for (const u of selectedFundingUtxos) {
      const fTxHash = CSL.TransactionHash.from_bytes(Buffer.from(u.txHash, 'hex'));
      const fInput = CSL.TransactionInput.new(fTxHash, u.outputIndex);
      const fAddress = CSL.Address.from_bech32(u.address);
      const fValue = this._buildCslValue(getLovelace(u), u.amount);
      fundingInputsBuilder.add_regular_input(fAddress, fInput, fValue);
    }
    txb.set_inputs(fundingInputsBuilder);

    // Create explicit change output for native tokens from selected funding UTxOs.
    // CSL's add_change_if_needed does not forward native tokens from inputs
    // to the change output during Plutus minting transactions.
    const fundingNativeAssets = new Map<string, Map<string, bigint>>();
    for (const u of selectedFundingUtxos) {
      for (const a of u.amount) {
        if (a.unit.toLowerCase() === 'lovelace') continue;
        if (BigInt(a.quantity) <= 0n) continue;
        const { policyId: pid, assetName: an } = parseAssetUnit(a.unit);
        if (!fundingNativeAssets.has(pid)) fundingNativeAssets.set(pid, new Map());
        const policy = fundingNativeAssets.get(pid)!;
        policy.set(an, (policy.get(an) || 0n) + BigInt(a.quantity));
      }
    }
    // Adjust for burned tokens (negative mint quantities)
    const scriptHashHex = Buffer.from(scriptHash.to_bytes()).toString('hex');
    for (const mintAction of req.mintActions) {
      const qty = BigInt(mintAction.quantity);
      if (qty >= 0n) continue;
      const { assetName: burnAssetName } = parseAssetUnit(mintAction.assetUnit);
      const burnAmount = -qty;
      const policyAssets = fundingNativeAssets.get(scriptHashHex);
      if (policyAssets) {
        const currentQty = policyAssets.get(burnAssetName) || 0n;
        const newQty = currentQty - burnAmount;
        if (newQty <= 0n) {
          policyAssets.delete(burnAssetName);
          if (policyAssets.size === 0) fundingNativeAssets.delete(scriptHashHex);
        } else {
          policyAssets.set(burnAssetName, newQty);
        }
      }
    }
    if (fundingNativeAssets.size > 0) {
      const nativeChangeMA = CSL.MultiAsset.new();
      for (const [pid, assets] of fundingNativeAssets) {
        const ph = CSL.ScriptHash.from_bytes(Buffer.from(pid, 'hex'));
        const cslAssets = CSL.Assets.new();
        for (const [an, qty] of assets) {
          cslAssets.insert(CSL.AssetName.new(Buffer.from(an, 'hex')), CSL.BigNum.from_str(qty.toString()));
        }
        nativeChangeMA.insert(ph, cslAssets);
      }
      const nativeChangeValue = CSL.Value.new(CSL.BigNum.from_str('2000000'));
      nativeChangeValue.set_multiasset(nativeChangeMA);
      txb.add_output(CSL.TransactionOutput.new(changeAddress, nativeChangeValue));
      logger.debug(`Added explicit change output for existing native tokens from funding UTxOs`);
    }

    const costModels = this._createCostModels('v3');
    txb.calc_script_data_hash(costModels);
    txb.add_change_if_needed(changeAddress);

    const tx = txb.build_tx();
    return this._patchScriptDataHash(tx);
  }

  public async buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      const finalExUnits = await this._evaluateExUnits(
        (exUnits) => this._buildPlutusSpendTx(req, ctx, exUnits),
        ctx.evaluateTransaction
      );

      const unsignedTx = this._buildPlutusSpendTx(req, ctx, finalExUnits);
      const txDetails = this._extractTxDetails(unsignedTx);
      const { hashHex: scriptHash } = this._computeScriptHash(req.plutusScriptExecution!.validatorScript);

      logger.info(`Built unsigned Plutus spending transaction. Fee: ${txDetails.feeLovelace}`);
      return this._buildResult(req, ctx, txDetails, { scriptHash });
    } catch (error: any) {
      logger.error(`buildUnsignedPlutusSpendTransaction error: ${error?.message || error}`);
      mapBuilderError(error);
    }
  }

  /**
   * Helper to build Plutus spending transaction with specified execution units
   */
  private _buildPlutusSpendTx(
    req: TxBuildPlutusSpendRequest,
    ctx: TxBuildContext,
    exUnits: { mem: string; cpu: string }
  ): CSL.Transaction {
    const { plutusScriptExecution } = req;
    const scriptUtxoRef = plutusScriptExecution.scriptUtxo;

    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);
    const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

    const { plutusScript } = this._computeScriptHash(plutusScriptExecution.validatorScript);
    const scriptSource = CSL.PlutusScriptSource.new(plutusScript);

    // Build redeemer
    const redeemerPlutusData = this._toPlutusData(plutusScriptExecution.redeemer);
    const redeemer = CSL.Redeemer.new(
      CSL.RedeemerTag.new_spend(),
      CSL.BigNum.from_str('0'), // index will be corrected by CSL
      redeemerPlutusData,
      CSL.ExUnits.new(CSL.BigNum.from_str(exUnits.mem), CSL.BigNum.from_str(exUnits.cpu))
    );

    // Add the script input using TxInputsBuilder
    const scriptInputsBuilder = CSL.TxInputsBuilder.new();
    const scriptTxHash = CSL.TransactionHash.from_bytes(Buffer.from(scriptUtxoRef.txHash, 'hex'));
    const scriptInput = CSL.TransactionInput.new(scriptTxHash, scriptUtxoRef.outputIndex);

    // Find the script UTxO to get its value
    const scriptOdatanoUtxo = ctx.utxos.find(
      u => u.txHash === scriptUtxoRef.txHash && u.outputIndex === scriptUtxoRef.outputIndex
    );
    if (!scriptOdatanoUtxo) {
      throw new Error(`Script UTxO ${scriptUtxoRef.txHash}#${scriptUtxoRef.outputIndex} not found in provided UTxOs`);
    }

    const scriptNonAdaAssets = scriptOdatanoUtxo.amount.filter(
      a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n
    );
    const scriptUtxoValue = this._buildCslValue(getLovelace(scriptOdatanoUtxo), scriptOdatanoUtxo.amount);

    // Build PlutusWitness: datum handling depends on whether UTxO has inline datum
    let plutusWitness: CSL.PlutusWitness;
    if (plutusScriptExecution.datum) {
      const datumSource = CSL.DatumSource.new(this._toPlutusData(plutusScriptExecution.datum));
      plutusWitness = CSL.PlutusWitness.new_with_ref(scriptSource, datumSource, redeemer);
    } else {
      plutusWitness = CSL.PlutusWitness.new_with_ref_without_datum(scriptSource, redeemer);
    }

    scriptInputsBuilder.add_plutus_script_input(plutusWitness, scriptInput, scriptUtxoValue);
    txb.set_inputs(scriptInputsBuilder);

    this._addRequiredSigners(txb, req.requiredSigners);

    // Separate sender UTxOs (excluding script UTxO)
    const senderUtxos = ctx.utxos.filter(
      u => !(u.txHash === scriptUtxoRef.txHash && u.outputIndex === scriptUtxoRef.outputIndex)
    );

    // Collateral + funding UTxO separation (from sender UTxOs only)
    const { fundingUtxos } = this._setupCollateral(txb, senderUtxos);

    // Create output for recipient with multi-assets from the script UTxO
    const outputValue = CSL.Value.new(CSL.BigNum.from_str(String(req.lovelaceAmount || 2_000_000)));
    if (scriptNonAdaAssets.length > 0) {
      outputValue.set_multiasset(this._buildCslMultiAsset(scriptNonAdaAssets));
    }
    const recipientOutput = CSL.TransactionOutput.new(recipientAddress, outputValue);
    this._attachInlineDatum(recipientOutput, req.inlineDatum);
    txb.add_output(recipientOutput);

    // Coin selection from funding UTxOs
    const cslFundingUtxos = this._mapMultiAssetUtxosToCslUtxos(fundingUtxos);
    txb.add_inputs_from(cslFundingUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);

    const costModels = this._createCostModels('v3');
    txb.calc_script_data_hash(costModels);
    txb.add_change_if_needed(changeAddress);

    const tx = txb.build_tx();
    return this._patchScriptDataHash(tx);
  }

  /**
   * Post-process a CSL-built Plutus transaction to fix the scriptDataHash.
   * CSL v15's calc_script_data_hash() produces incorrect language view CBOR
   * for Conway-era PlutusV3 transactions. This method recomputes the correct
   * hash using costModelsToLanguageViewCbor from @harmoniclabs/cardano-costmodels-ts.
   */
  private _patchScriptDataHash(tx: CSL.Transaction): CSL.Transaction {
    const witnesses = tx.witness_set();
    const redeemers = witnesses.redeemers();
    if (!redeemers || redeemers.len() === 0) return tx;

    const redeemersBytes = Buffer.from(redeemers.to_bytes());

    const plutusData = witnesses.plutus_data();
    const datumsBytes = plutusData && plutusData.len() > 0
      ? Buffer.from(plutusData.to_bytes())
      : Buffer.alloc(0);

    const costModelsJson = JSON.parse(this.protocolParameters.costModels || '{}');
    const costModelsObj: Record<string, number[]> = {};
    const v3 = costModelsJson['plutus:v3'] || costModelsJson['PlutusV3'];
    if (Array.isArray(v3) && v3.length > 0) {
      costModelsObj.PlutusScriptV3 = Array.from(toCostModelArrV3(v3 as any)).map(Number);
    }

    const languageViews = Buffer.from(
      costModelsToLanguageViewCbor(costModelsObj as any, { mustHaveV3: !!costModelsObj.PlutusScriptV3 }).toBuffer()
    );

    // blake2b256(redeemers || datums || languageViews)
    const hashInput = Buffer.concat([redeemersBytes, datumsBytes, languageViews]);
    const hashOutput = Buffer.alloc(32);
    blake2b(32).update(hashInput).digest(hashOutput);

    const wrongHash = tx.body().script_data_hash();
    if (!wrongHash) return tx;
    const wrongHashBytes = Buffer.from(wrongHash.to_bytes());

    if (wrongHashBytes.equals(hashOutput)) {
      return tx;
    }

    const txBytes = Buffer.from(tx.to_bytes());
    const idx = txBytes.indexOf(wrongHashBytes);
    if (idx === -1) {
      logger.warn('Could not find scriptDataHash in transaction bytes - skipping patch');
      return tx;
    }
    hashOutput.copy(txBytes, idx);

    logger.info(`_patchScriptDataHash: patched ${wrongHashBytes.toString('hex').slice(0, 16)}... → ${hashOutput.toString('hex').slice(0, 16)}...`);

    return CSL.Transaction.from_bytes(txBytes);
  }

  //---------------------------------------------------------------------------
  // Shared Helper Methods
  //---------------------------------------------------------------------------

  /** Convert JSON PlutusData to CSL PlutusData using DetailedSchema */
  private _toPlutusData(json: JSONValue): CSL.PlutusData {
    return CSL.PlutusData.from_json(JSON.stringify(json), CSL.PlutusDatumSchema.DetailedSchema);
  }

  /** Build CSL MultiAsset from an array of { unit, quantity } (skips lovelace entries) */
  private _buildCslMultiAsset(assets: Array<{ unit: string; quantity: string }>): CSL.MultiAsset {
    const multiAsset = CSL.MultiAsset.new();
    for (const asset of assets) {
      if (asset.unit.toLowerCase() === 'lovelace') continue;
      const { policyId, assetName } = parseAssetUnit(asset.unit);
      const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
      let existing = multiAsset.get(policyHash);
      if (!existing) existing = CSL.Assets.new();
      existing.insert(CSL.AssetName.new(Buffer.from(assetName, 'hex')), CSL.BigNum.from_str(asset.quantity));
      multiAsset.insert(policyHash, existing);
    }
    return multiAsset;
  }

  /** Build CSL Value from lovelace + optional assets array */
  private _buildCslValue(lovelace: string | bigint, assets?: Array<{ unit: string; quantity: string }>): CSL.Value {
    const value = CSL.Value.new(CSL.BigNum.from_str(String(lovelace)));
    const nonAda = assets?.filter(a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n);
    if (nonAda && nonAda.length > 0) {
      value.set_multiasset(this._buildCslMultiAsset(nonAda));
    }
    return value;
  }

  /** Extract CBOR, hash, fee, inputs and outputs from a built CSL Transaction */
  private _extractTxDetails(unsignedTx: CSL.Transaction): {
    unsignedTxCbor: string; txBodyHash: string; feeLovelace: string;
    inputRefs: Array<{ txHash: string; index: number }>;
    outputs: Array<{ address: string; lovelace: string }>; sizeBytes: number;
  } {
    const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString("hex");
    const body = unsignedTx.body();
    const txBodyHash = blake2b(32).update(body.to_bytes()).digest('hex');
    const feeLovelace = body.fee().to_str();

    const txInputs = body.inputs();
    const inputRefs: Array<{ txHash: string; index: number }> = [];
    for (let i = 0; i < txInputs.len(); i++) {
      const inp = txInputs.get(i);
      inputRefs.push({
        txHash: Buffer.from(inp.transaction_id().to_bytes()).toString('hex'),
        index: inp.index()
      });
    }

    const outputs: Array<{ address: string; lovelace: string }> = [];
    const txOuts = body.outputs();
    for (let i = 0; i < txOuts.len(); i++) {
      const o = txOuts.get(i);
      outputs.push({ address: o.address().to_bech32(), lovelace: o.amount().coin().to_str() });
    }
    return { unsignedTxCbor, txBodyHash, feeLovelace, inputRefs, outputs, sizeBytes: unsignedTxCbor.length / 2 };
  }

  /** Build the standard TxBuildResult object */
  private _buildResult(
    req: TxBuildRequest, ctx: TxBuildContext,
    txDetails: ReturnType<CSLTxBuilder['_extractTxDetails']>,
    extra?: { scriptHash?: string }
  ): TxBuildResult {
    // Map actual tx inputs (from built CBOR) back to context UTxOs for lovelace amounts
    const inputs = txDetails.inputRefs.map(ref => {
      const ctxUtxo = ctx.utxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.index);
      return {
        txHash: ref.txHash,
        index: ref.index,
        lovelace: ctxUtxo ? getLovelace(ctxUtxo).toString() : "0",
      };
    });

    return {
      unsignedTxCbor: txDetails.unsignedTxCbor,
      txBodyHash: txDetails.txBodyHash,
      senderAddress: req.senderAddress,
      network: this.cardanoClient.network,
      sizeBytes: txDetails.sizeBytes,
      builderEngine: this.name,
      feeLovelace: txDetails.feeLovelace,
      inputs,
      outputs: txDetails.outputs,
      ...extra,
      warnings: [],
    };
  }

  /** Add required signers (Ed25519 key hashes) to the transaction builder */
  private _addRequiredSigners(txb: CSL.TransactionBuilder, signers?: string[]): void {
    if (signers?.length) {
      for (const signerHex of signers) {
        txb.add_required_signer(CSL.Ed25519KeyHash.from_bytes(Buffer.from(signerHex, 'hex')));
      }
    }
  }

  /** Attach inline PlutusData datum to a transaction output */
  private _attachInlineDatum(output: CSL.TransactionOutput, datum?: JSONValue): void {
    if (datum) {
      output.set_plutus_data(this._toPlutusData(datum));
    }
  }

  /** Parse PlutusV3 script hex and compute its hash */
  private _computeScriptHash(scriptHex: string): { plutusScript: CSL.PlutusScript; hashHex: string; cslHash: CSL.ScriptHash } {
    const plutusScript = CSL.PlutusScript.new_v3(Buffer.from(scriptHex, 'hex'));
    const cslHash = plutusScript.hash();
    return { plutusScript, hashHex: Buffer.from(cslHash.to_bytes()).toString('hex'), cslHash };
  }

  /**
   * Evaluate execution units via a two-pass build: first with high units for evaluation,
   * then apply the evaluated budget with a safety buffer. Falls back to defaults on failure.
   */
  private async _evaluateExUnits(
    buildFn: (exUnits: { mem: string; cpu: string }) => CSL.Transaction,
    evaluator?: (cbor: string) => Promise<Array<{ budget: { memory: number; cpu: number } }>>
  ): Promise<{ mem: string; cpu: string }> {
    const defaultUnits = {
      mem: String(DEFAULT_EXECUTION_UNITS.mem),
      cpu: String(DEFAULT_EXECUTION_UNITS.cpu)
    };

    if (!evaluator) {
      logger.debug('No evaluator available, using default execution units');
      return defaultUnits;
    }

    logger.debug('Building evaluation pass with high execution units');
    const evalTx = buildFn({
      mem: String(HIGH_EXECUTION_UNITS.mem),
      cpu: String(HIGH_EXECUTION_UNITS.cpu)
    });
    const evalTxCbor = Buffer.from(evalTx.to_bytes()).toString('hex');

    try {
      const evalResults = await evaluator(evalTxCbor);
      logger.debug(`Evaluation results: ${JSON.stringify(evalResults)}`);

      if (evalResults && evalResults.length > 0) {
        const budget = evalResults[0].budget;
        const result = {
          mem: Math.ceil(budget.memory * EXECUTION_UNIT_BUFFER).toString(),
          cpu: Math.ceil(budget.cpu * EXECUTION_UNIT_BUFFER).toString()
        };
        logger.info(`Using evaluated execution units: mem=${result.mem}, cpu=${result.cpu}`);
        return result;
      }
    } catch (evalError: any) {
      logger.warn(`Evaluation failed, using default units: ${evalError.message}`);
    }

    return defaultUnits;
  }

  /**
   * Find an ADA-only UTxO for collateral, set it on the builder,
   * and return the remaining funding UTxOs with collateral excluded.
   */
  private _setupCollateral(txb: CSL.TransactionBuilder, utxos: OdatanoUtxo[]): {
    collateralUtxo?: OdatanoUtxo; fundingUtxos: OdatanoUtxo[];
  } {
    const collateralUtxo = utxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));

    if (collateralUtxo) {
      const collateralBuilder = CSL.TxInputsBuilder.new();
      const txHash = CSL.TransactionHash.from_bytes(Buffer.from(collateralUtxo.txHash, 'hex'));
      const input = CSL.TransactionInput.new(txHash, collateralUtxo.outputIndex);
      const address = CSL.Address.from_bech32(collateralUtxo.address);
      const value = CSL.Value.new(CSL.BigNum.from_str(getLovelace(collateralUtxo).toString()));
      collateralBuilder.add_regular_input(address, input, value);
      txb.set_collateral(collateralBuilder);
    }

    let fundingUtxos = collateralUtxo
      ? utxos.filter(u => !(u.txHash === collateralUtxo.txHash && u.outputIndex === collateralUtxo.outputIndex))
      : utxos;
    if (fundingUtxos.length === 0 && utxos.length > 0) {
      logger.debug('No funding UTxOs after collateral exclusion, including collateral in funding pool');
      fundingUtxos = utxos;
    }

    return { collateralUtxo, fundingUtxos };
  }

  /**
   * Greedy coin selection: sort UTxOs by lovelace descending (largest first),
   * collect until requiredLovelace is satisfied. Falls back to all UTxOs if
   * the full set is needed.
   */
  private _selectMinimalUtxos(utxos: OdatanoUtxo[], requiredLovelace: bigint): OdatanoUtxo[] {
    const sorted = [...utxos].sort((a, b) => {
      const aLov = BigInt(getLovelace(a));
      const bLov = BigInt(getLovelace(b));
      return bLov > aLov ? 1 : bLov < aLov ? -1 : 0;
    });
    const selected: OdatanoUtxo[] = [];
    let accumulated = 0n;
    for (const u of sorted) {
      selected.push(u);
      accumulated += BigInt(getLovelace(u));
      if (accumulated >= requiredLovelace) break;
    }
    return selected;
  }

  //---------------------------------------------------------------------------
  // CSL Mapping & Configuration Helpers
  //---------------------------------------------------------------------------

  /**
   * Map ODATANO UTxOs to CSL TransactionUnspentOutputs (with multi-asset support)
   */
  private _mapMultiAssetUtxosToCslUtxos(utxos: OdatanoUtxo[]): CSL.TransactionUnspentOutputs {
    const outs = CSL.TransactionUnspentOutputs.new();
    logger.debug(`Mapping ${utxos.length} UTxOs to CSL format`);

    for (const u of utxos) {
      logger.debug(`UTxO ${u.txHash}:${u.outputIndex} has ${u.amount.length} amounts: ${JSON.stringify(u.amount)}`);

      const txHash = CSL.TransactionHash.from_bytes(Buffer.from(u.txHash, "hex"));
      const input = CSL.TransactionInput.new(txHash, u.outputIndex);
      const addr = CSL.Address.from_bech32(u.address);
      const value = this._buildCslValue(getLovelace(u), u.amount);
      const output = CSL.TransactionOutput.new(addr, value);
      outs.add(CSL.TransactionUnspentOutput.new(input, output));
    }

    return outs;
  }

  /**
   * Create a CSL TransactionBuilderConfig from protocol parameters
   */
  private _createTxBuilderConfig(protocolParams: LedgerProtocolParameter): CSL.TransactionBuilderConfig {
    const minFeeA = protocolParams.minFeeA;
    const minFeeB = protocolParams.minFeeB;
    const poolDeposit = protocolParams.poolDeposit;
    const keyDeposit = protocolParams.keyDeposit;
    const maxTxSize = protocolParams.maxTxSize;
    const maxValueSize = protocolParams.maxValSize;
    const coinsPerUtxoByte = protocolParams.coinsPerUtxoSize;

    const feeAlgo = CSL.LinearFee.new(
      CSL.BigNum.from_str(String(minFeeA)),
      CSL.BigNum.from_str(String(minFeeB)),
    );

    // Plutus execution unit prices for script fee calculation
    const priceMemValue = protocolParams.priceMem;
    const priceStepValue = protocolParams.priceStep;

    const priceMemNumerator = (typeof priceMemValue === 'number' && priceMemValue < 1)
      ? Math.round(priceMemValue * 10000)
      : (priceMemValue || 577);
    const priceStepNumerator = (typeof priceStepValue === 'number' && priceStepValue < 1)
      ? Math.round(priceStepValue * 10000000)
      : (priceStepValue || 721);

    const exUnitPrices = CSL.ExUnitPrices.new(
      CSL.UnitInterval.new(
        CSL.BigNum.from_str(String(priceMemNumerator)),
        CSL.BigNum.from_str('10000')
      ),
      CSL.UnitInterval.new(
        CSL.BigNum.from_str(String(priceStepNumerator)),
        CSL.BigNum.from_str('10000000')
      )
    );

    const cfg = CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(feeAlgo)
      .pool_deposit(CSL.BigNum.from_str(String(poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(keyDeposit)))
      .max_tx_size(Number(maxTxSize))
      .max_value_size(Number(maxValueSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(coinsPerUtxoByte)))
      .ex_unit_prices(exUnitPrices)
      .build();

    logger.info(`TransactionBuilderConfig created with Plutus execution unit prices.`);
    return cfg;
  }

  /**
   * Map ODATANO metadata JSON to CSL GeneralTransactionMetadata
   */
  private _mapOdatanoMetadataToCSLMetadata(metadataJson: JSONValue | undefined): CSL.GeneralTransactionMetadata {
    if (typeof metadataJson !== 'object' || Array.isArray(metadataJson) || metadataJson === null) {
      throw new Error(`Invalid metadata format. Expected object, got ${typeof metadataJson}`);
    }

    const metadata = CSL.GeneralTransactionMetadata.new();

    for (const [label, value] of Object.entries(metadataJson)) {
      const numericLabel = parseInt(label, 10);
      const txMetadatum = this._jsonToCSLMetadatum(value);
      logger.debug(`Created TransactionMetadatum for label ${numericLabel}`);
      metadata.insert(CSL.BigNum.from_str(String(numericLabel)), txMetadatum);
    }

    logger.debug(`Created metadata with ${metadata.len()} labels`);
    return metadata;
  }

  /**
   * Create Costmdls from protocol parameters for specific Plutus version
   */
  private _createCostModels(version?: 'v1' | 'v2' | 'v3'): CSL.Costmdls {
    const costModels = CSL.Costmdls.new();

    const toArray = (costs: unknown): number[] | null => {
      if (Array.isArray(costs)) return costs;
      if (costs && typeof costs === 'object') {
        return Object.keys(costs as Record<string, number>).sort().map(k => (costs as Record<string, number>)[k]);
      }
      return null;
    };

    const addCostModel = (language: CSL.Language, costs: number[], label: string): void => {
      const costModel = CSL.CostModel.new();
      for (let i = 0; i < costs.length; i++) {
        costModel.set(i, CSL.Int.new_i32(costs[i]));
      }
      costModels.insert(language, costModel);
      logger.debug(`Added ${label} cost model with ${costs.length} parameters`);
    };

    try {
      const costModelsJson = JSON.parse(this.protocolParameters.costModels || '{}');

      if (!version || version === 'v1') {
        const v1Costs = toArray(costModelsJson['plutus:v1'] || costModelsJson['PlutusV1']);
        if (v1Costs) addCostModel(CSL.Language.new_plutus_v1(), v1Costs, 'PlutusV1');
      }

      if (!version || version === 'v2') {
        const v2Costs = toArray(costModelsJson['plutus:v2'] || costModelsJson['PlutusV2']);
        if (v2Costs) addCostModel(CSL.Language.new_plutus_v2(), v2Costs, 'PlutusV2');
      }

      if (!version || version === 'v3') {
        const v3CostsRaw = toArray(costModelsJson['plutus:v3'] || costModelsJson['PlutusV3']);
        if (v3CostsRaw) {
          // Pad to 297 parameters (Conway Chang 2) using defaults from cardano-costmodels-ts
          const v3Costs: number[] = Array.from(toCostModelArrV3(v3CostsRaw as any)).map(Number);
          addCostModel(CSL.Language.new_plutus_v3(), v3Costs, 'PlutusV3');
        }
      }
    } catch (error) {
      logger.warn(`Failed to parse cost models: ${error}. Using empty cost models.`);
    }

    return costModels;
  }

  /**
   * Convert JSON value to CSL TransactionMetadatum
   */
  private _jsonToCSLMetadatum(value: JSONValue): CSL.TransactionMetadatum {
    if (typeof value === 'number' || typeof value === 'bigint') {
      const intValue = CSL.Int.new_i32(Number(value));
      return CSL.TransactionMetadatum.new_int(intValue);
    }

    if (typeof value === 'string') {
      return CSL.TransactionMetadatum.new_text(value);
    }

    if (Array.isArray(value)) {
      const list = CSL.MetadataList.new();
      for (const item of value) {
        list.add(this._jsonToCSLMetadatum(item));
      }
      return CSL.TransactionMetadatum.new_list(list);
    }

    if (typeof value === 'object' && value !== null) {
      const map = CSL.MetadataMap.new();
      for (const [k, v] of Object.entries(value)) {
        const key = CSL.TransactionMetadatum.new_text(k);
        const val = this._jsonToCSLMetadatum(v);
        map.insert(key, val);
      }
      return CSL.TransactionMetadatum.new_map(map);
    }

    throw new Error(`Unsupported metadata value type: ${typeof value}`);
  }
}
