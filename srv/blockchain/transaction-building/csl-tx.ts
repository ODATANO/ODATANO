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
   * Build unsigned ADA transfer transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      // prepare addresses
      const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
      const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

      // map ODATANO UTxOs -> CSL TransactionUnspentOutputs (with multi-asset support)
      // This allows spending UTxOs that contain native assets - they will be returned in the change output
      const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);

      // create Transaction Builder from stored config
      const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

      // add recipient & output (lovelace + optional assets), with optional inline datum
      const amount = CSL.BigNum.from_str(String(req.lovelaceAmount));
      const outValue = CSL.Value.new(amount);

      // Optional: add native assets to the output (for locking tokens at script address)
      if (req.assets && req.assets.length > 0) {
        const multiAsset = CSL.MultiAsset.new();
        for (const asset of req.assets) {
          if (asset.unit === 'lovelace') continue;
          const { policyId, assetName } = parseAssetUnit(asset.unit);
          const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
          let assets = multiAsset.get(policyHash);
          if (!assets) assets = CSL.Assets.new();
          assets.insert(CSL.AssetName.new(Buffer.from(assetName, 'hex')), CSL.BigNum.from_str(asset.quantity));
          multiAsset.insert(policyHash, assets);
        }
        outValue.set_multiasset(multiAsset);
      }

      const out = CSL.TransactionOutput.new(recipientAddress, outValue);
      if (req.outputDatum) {
        const plutusData = CSL.PlutusData.from_json(
          JSON.stringify(req.outputDatum),
          CSL.PlutusDatumSchema.DetailedSchema
        );
        out.set_plutus_data(plutusData);
      }
      txb.add_output(out);

      // add inputs via coin selection + add change
      txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      txb.add_change_if_needed(changeAddress);

      // build unsigned tx
      const unsignedTx = txb.build_tx();

      // Export the complete transaction (with empty witness set) for cardano-cli
      const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString("hex");

      // hash + fee + outputs
      const body = unsignedTx.body();
      const bodyBytes = body.to_bytes();
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      const txBodyHash = hash;
      const feeLovelace = body.fee().to_str();

      const outputs: Array<{ address: string; lovelace: string }> = [];
      const txOuts = body.outputs();
      for (let i = 0; i < txOuts.len(); i++) {
        const o = txOuts.get(i);
        outputs.push({
          address: o.address().to_bech32(),
          lovelace: o.amount().coin().to_str(),
        });
      }

      logger.info(`Built unsigned transaction successfully.`);

      return {
        unsignedTxCbor,
        txBodyHash,
        senderAddress: req.senderAddress,
        network: this.cardanoClient.network,
        sizeBytes: unsignedTxCbor.length / 2, // hex to bytes
        builderEngine: this.name,
        feeLovelace: feeLovelace,
        inputs: ctx.utxos.map(u => ({
          txHash: u.txHash,
          index: u.outputIndex,
          lovelace: getLovelace(u).toString(),
        })),
        outputs,
        warnings: [],
      };
    } catch (err: any) {
      mapBuilderError(err, 'lovelace');
    }
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      // prepare addresses
      const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
      const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

      // map ODATANO UTxOs -> CSL TransactionUnspentOutputs (with multi-asset support)
      // This allows spending UTxOs that contain native assets - they will be returned in the change output
      const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);

      // create Transaction Builder from stored config
      const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

      // add recipient & output (lovelace)
      const amount = CSL.BigNum.from_str(String(req.lovelaceAmount));
      const outValue = CSL.Value.new(amount);
      const out = CSL.TransactionOutput.new(recipientAddress, outValue);
      txb.add_output(out);

      // add metadata if provided
      if (req.metadataJson) {
        const metadata = this._mapOdatanoMetadataToCSLMetadata(req.metadataJson);
        txb.set_metadata(metadata);
      }

      // add inputs via coin selection + add change
      txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      txb.add_change_if_needed(changeAddress);

      // build unsigned tx
      const unsignedTx = txb.build_tx();

      // Export the complete transaction (with empty witness set) for cardano-cli
      const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString("hex");

      // hash + fee + outputs
      const body = unsignedTx.body();
      const bodyBytes = body.to_bytes();
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      const txBodyHash = hash;
      const feeLovelace = body.fee().to_str();

      const outputs: Array<{ address: string; lovelace: string }> = [];
      const txOuts = body.outputs();
      for (let i = 0; i < txOuts.len(); i++) {
        const o = txOuts.get(i);
        outputs.push({
          address: o.address().to_bech32(),
          lovelace: o.amount().coin().to_str(),
        });
      }

      logger.info(`Built unsigned transaction with metadata successfully.`);

      return {
        unsignedTxCbor,
        txBodyHash,
        senderAddress: req.senderAddress,
        network: this.cardanoClient.network,
        sizeBytes: unsignedTxCbor.length / 2, // hex to bytes
        builderEngine: this.name,
        feeLovelace,
        inputs: ctx.utxos.map(u => ({
          txHash: u.txHash,
          index: u.outputIndex,
          lovelace: getLovelace(u).toString(),
        })),
        outputs,
        warnings: [],
      };
    } catch (err: any) {
      mapBuilderError(err, 'lovelace');
    }
  }

  public async buildUnsignedMultiAssetTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    if (!req.assets || req.assets.length === 0) {
      throw new Error('[CSLTxBuilder] buildUnsignedMultiAssetTransaction requires assets to be specified');
    }

    try {
      // prepare addresses
      const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
      const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

      // map ODATANO UTxOs -> CSL TransactionUnspentOutputs (with multi-asset support)
      const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);

      // create Transaction Builder from stored config
      const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

      // Build output value with ADA + multi-assets
      const lovelace = CSL.BigNum.from_str(String(req.lovelaceAmount));
      const outputValue = CSL.Value.new(lovelace);

      // Create MultiAsset structure for native tokens
      const multiAsset = CSL.MultiAsset.new();

      for (const asset of req.assets) {
        // Skip 'lovelace' unit (already handled above)
        if (asset.unit === 'lovelace') continue;

        const { policyId, assetName } = parseAssetUnit(asset.unit);
      
      // Get or create Assets for this policy
      const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
      let assets = multiAsset.get(policyHash);
      
      if (!assets) {
        assets = CSL.Assets.new();
      }

      // Add asset with quantity
      const assetNameBytes = Buffer.from(assetName, 'hex');
      const cslAssetName = CSL.AssetName.new(assetNameBytes);
      const quantity = CSL.BigNum.from_str(asset.quantity);
      
      assets.insert(cslAssetName, quantity);
      multiAsset.insert(policyHash, assets);
    }

    // Set multi-asset on output value
    outputValue.set_multiasset(multiAsset);

      // Create output with all assets + optional inline datum
      const recipientOutput = CSL.TransactionOutput.new(recipientAddress, outputValue);
      if (req.outputDatum) {
        const plutusData = CSL.PlutusData.from_json(
          JSON.stringify(req.outputDatum),
          CSL.PlutusDatumSchema.DetailedSchema
        );
        recipientOutput.set_plutus_data(plutusData);
      }
      txb.add_output(recipientOutput);

      // add inputs via coin selection + add change
      txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      txb.add_change_if_needed(changeAddress);

      // build unsigned tx
      const unsignedTx = txb.build_tx();

      // Export the complete transaction (with empty witness set) for cardano-cli
      const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString("hex");

      // hash + fee + outputs
      const body = unsignedTx.body();
      const bodyBytes = body.to_bytes();
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      const txBodyHash = hash;
      const feeLovelace = body.fee().to_str();

      const outputs: Array<{ address: string; lovelace: string }> = [];
      const txOuts = body.outputs();
      for (let i = 0; i < txOuts.len(); i++) {
        const o = txOuts.get(i);
        outputs.push({
          address: o.address().to_bech32(),
          lovelace: o.amount().coin().to_str(),
        });
      }

      logger.info(`Built unsigned multi-asset transaction successfully.`);

      return {
        unsignedTxCbor,
        txBodyHash,
        senderAddress: req.senderAddress,
        network: this.cardanoClient.network,
        sizeBytes: unsignedTxCbor.length / 2, // hex to bytes
        builderEngine: this.name,
        feeLovelace,
        inputs: ctx.utxos.map(u => ({
          txHash: u.txHash,
          index: u.outputIndex,
          lovelace: getLovelace(u).toString(),
        })),
        outputs,
        warnings: [],
      };
    } catch (err: any) {
      // Extract asset unit from error message if possible
      const assetMatch = err?.message?.match(/not enough\s+([a-f0-9.]+)/i);
      const assetUnit = assetMatch?.[1] || 'assets';
      mapBuilderError(err, assetUnit);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      // Determine execution units based on evaluator availability
      let finalExUnits = {
        mem: String(DEFAULT_EXECUTION_UNITS.mem),
        cpu: String(DEFAULT_EXECUTION_UNITS.cpu)
      };

      if (ctx.evaluateTransaction) {
        // Build first pass with high execution units for evaluation
        logger.debug(`[CSLTxBuilder] Building evaluation pass with high execution units`);
        const evalTx = this._buildMintTx(req, ctx, {
          mem: String(HIGH_EXECUTION_UNITS.mem),
          cpu: String(HIGH_EXECUTION_UNITS.cpu)
        });
        const evalTxCbor = Buffer.from(evalTx.to_bytes()).toString('hex');

        try {
          // Evaluate to get exact execution units
          const evalResults = await ctx.evaluateTransaction(evalTxCbor);
          logger.debug(`[CSLTxBuilder] Evaluation results: ${JSON.stringify(evalResults)}`);

          if (evalResults && evalResults.length > 0) {
            // Use the evaluated budget (take first result for single script)
            const budget = evalResults[0].budget;
            // Add safety margin to evaluated units
            finalExUnits = {
              mem: Math.ceil(budget.memory * EXECUTION_UNIT_BUFFER).toString(),
              cpu: Math.ceil(budget.cpu * EXECUTION_UNIT_BUFFER).toString()
            };
            logger.info(`[CSLTxBuilder] Using evaluated execution units: mem=${finalExUnits.mem}, cpu=${finalExUnits.cpu}`);
          }
        } catch (evalError: any) {
          logger.warn(`[CSLTxBuilder] Evaluation failed, using default units: ${evalError.message}`);
          // Fall back to defaults on evaluation failure
        }
      } else {
        logger.debug(`[CSLTxBuilder] No evaluator available, using default execution units`);
      }

      // Build final transaction with determined execution units
      const unsignedTx = this._buildMintTx(req, ctx, finalExUnits);

      logger.debug(`[CSLTxBuilder] Transaction built successfully`);

      // Export as CBOR hex
      const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString('hex');

      // Extract transaction details from the transaction
      const body = unsignedTx.body();
      const bodyBytes = body.to_bytes();
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      const txBodyHash = hash;
      const feeLovelace = body.fee().to_str();

      // Extract outputs
      const outputs: Array<{ address: string; lovelace: string }> = [];
      const txOuts = body.outputs();
      for (let i = 0; i < txOuts.len(); i++) {
        const o = txOuts.get(i);
        outputs.push({
          address: o.address().to_bech32(),
          lovelace: o.amount().coin().to_str(),
        });
      }

      // Compute script hash from the minting policy script (= policy ID)
      const mintScriptBytes = Buffer.from(req.mintingPolicyScript, 'hex');
      const mintPlutusScript = CSL.PlutusScript.new_v3(mintScriptBytes);
      const mintScriptHash = Buffer.from(mintPlutusScript.hash().to_bytes()).toString('hex');

      logger.info(`[CSLTxBuilder] Built unsigned minting transaction successfully. Fee: ${feeLovelace}`);

      return {
        unsignedTxCbor,
        txBodyHash,
        senderAddress: req.senderAddress,
        network: this.cardanoClient.network,
        sizeBytes: unsignedTxCbor.length / 2, // hex to bytes
        builderEngine: this.name,
        feeLovelace,
        inputs: ctx.utxos.map(u => ({
          txHash: u.txHash,
          index: u.outputIndex,
          lovelace: getLovelace(u).toString(),
        })),
        outputs,
        scriptHash: mintScriptHash,
        warnings: [],
      };
    } catch (error: any) {
      logger.error(`[CSLTxBuilder] buildUnsignedMintTransaction error: ${error?.message || error}`);
      mapBuilderError(error, 'lovelace');
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
    // Prepare addresses
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

    // Create Transaction Builder
    const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

    // Parse the Plutus script from CBOR hex (CBOR-wrapped flat UPLC bytecode)
    const scriptBytes = Buffer.from(req.mintingPolicyScript, 'hex');
    const plutusScript = CSL.PlutusScript.new_v3(scriptBytes);
    const scriptHash = plutusScript.hash();

    // Create PlutusScriptSource - wrapper for the script
    const scriptSource = CSL.PlutusScriptSource.new(plutusScript);

    // Create MintBuilder
    const mintBuilder = CSL.MintBuilder.new();

    // Track total minted value for output
    let totalMintedValue = CSL.Value.new(CSL.BigNum.from_str('0'));

    // Process each mint action
    for (const mintAction of req.mintActions) {
      const { assetName } = parseAssetUnit(mintAction.assetUnit);

      // Create asset name
      const assetNameBytes = Buffer.from(assetName, 'hex');
      const cslAssetName = CSL.AssetName.new(assetNameBytes);

      // Create mint quantity (can be negative for burning)
      const mintQuantity = CSL.Int.new_i32(Number(mintAction.quantity));

      // Create redeemer with specified execution units
      let redeemerData;
      if (req.mintRedeemer) {
        redeemerData = CSL.PlutusData.from_json(
          JSON.stringify(req.mintRedeemer),
          CSL.PlutusDatumSchema.DetailedSchema
        );
      } else {
        redeemerData = CSL.PlutusData.new_integer(CSL.BigInt.from_str(String(mintAction.redeemer ?? 0)));
      }
      const redeemer = CSL.Redeemer.new(
        CSL.RedeemerTag.new_mint(),
        CSL.BigNum.from_str('0'),
        redeemerData,
        CSL.ExUnits.new(
          CSL.BigNum.from_str(exUnits.mem),
          CSL.BigNum.from_str(exUnits.cpu)
        )
      );

      // Create MintWitness directly from PlutusScriptSource + Redeemer
      const mintWitness = CSL.MintWitness.new_plutus_script(
        scriptSource,
        redeemer
      );

      // Add to mint builder
      mintBuilder.add_asset(mintWitness, cslAssetName, mintQuantity);

      // Add to total minted value for output construction (only if quantity > 0)
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

    // Set the mint builder on transaction
    txb.set_mint_builder(mintBuilder);

    // Add required signers if specified (for Plutus validators checking extra_signatories)
    if (req.requiredSigners?.length) {
      for (const signerHex of req.requiredSigners) {
        txb.add_required_signer(CSL.Ed25519KeyHash.from_bytes(Buffer.from(signerHex, 'hex')));
      }
    }

    // Create output with minted assets + minimum lovelace
    const minLovelace = CSL.BigNum.from_str(String(req.lovelaceAmount));
    const outputValue = CSL.Value.new(minLovelace);
    const finalOutputValue = outputValue.checked_add(totalMintedValue);

    const recipientOutput = CSL.TransactionOutput.new(recipientAddress, finalOutputValue);
    if (req.inlineDatum) {
      const datumData = CSL.PlutusData.from_json(
        JSON.stringify(req.inlineDatum),
        CSL.PlutusDatumSchema.DetailedSchema
      );
      recipientOutput.set_plutus_data(datumData);
    }
    txb.add_output(recipientOutput);

    // Find an ADA-only UTxO for collateral
    const collateralOdatanoUtxo = ctx.utxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));

    if (collateralOdatanoUtxo) {
      const collateralBuilder = CSL.TxInputsBuilder.new();

      const txHash = CSL.TransactionHash.from_bytes(Buffer.from(collateralOdatanoUtxo.txHash, 'hex'));
      const input = CSL.TransactionInput.new(txHash, collateralOdatanoUtxo.outputIndex);
      const address = CSL.Address.from_bech32(collateralOdatanoUtxo.address);
      const value = CSL.Value.new(CSL.BigNum.from_str(getLovelace(collateralOdatanoUtxo).toString()));

      collateralBuilder.add_regular_input(address, input, value);
      txb.set_collateral(collateralBuilder);
    }

    // Exclude collateral UTxO so it is not consumed on successful tx.
    let fundingUtxos = collateralOdatanoUtxo
      ? ctx.utxos.filter(u => !(u.txHash === collateralOdatanoUtxo.txHash && u.outputIndex === collateralOdatanoUtxo.outputIndex))
      : ctx.utxos;
    if (fundingUtxos.length === 0 && ctx.utxos.length > 0) {
      logger.debug('[CSLTxBuilder] No funding UTxOs after collateral exclusion, including collateral in funding pool');
      fundingUtxos = ctx.utxos;
    }

    // Add all funding UTxOs as explicit inputs instead of using coin selection.
    // CSL's add_inputs_from does not properly forward native tokens from selected
    // inputs to the change output during Plutus minting transactions, causing
    // ValueNotConservedUTxO when inputs contain existing native assets.
    const fundingInputsBuilder = CSL.TxInputsBuilder.new();
    for (const u of fundingUtxos) {
      const fTxHash = CSL.TransactionHash.from_bytes(Buffer.from(u.txHash, 'hex'));
      const fInput = CSL.TransactionInput.new(fTxHash, u.outputIndex);
      const fAddress = CSL.Address.from_bech32(u.address);
      const fLovelace = CSL.BigNum.from_str(getLovelace(u).toString());
      const fValue = CSL.Value.new(fLovelace);
      const fNonAdaAssets = u.amount.filter(a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n);
      if (fNonAdaAssets.length > 0) {
        const fMultiAsset = CSL.MultiAsset.new();
        for (const asset of fNonAdaAssets) {
          const { policyId, assetName } = parseAssetUnit(asset.unit);
          const pH = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
          let assets = fMultiAsset.get(pH);
          if (!assets) assets = CSL.Assets.new();
          assets.insert(CSL.AssetName.new(Buffer.from(assetName, 'hex')), CSL.BigNum.from_str(asset.quantity));
          fMultiAsset.insert(pH, assets);
        }
        fValue.set_multiasset(fMultiAsset);
      }
      fundingInputsBuilder.add_regular_input(fAddress, fInput, fValue);
    }
    txb.set_inputs(fundingInputsBuilder);

    // Create explicit change output for native tokens from funding UTxOs.
    // CSL's add_change_if_needed does not forward native tokens from inputs
    // to the change output during Plutus minting transactions.
    const fundingNativeAssets = new Map<string, Map<string, bigint>>();
    for (const u of fundingUtxos) {
      for (const a of u.amount) {
        if (a.unit.toLowerCase() === 'lovelace') continue;
        if (BigInt(a.quantity) <= 0n) continue;
        const { policyId: pid, assetName: an } = parseAssetUnit(a.unit);
        if (!fundingNativeAssets.has(pid)) fundingNativeAssets.set(pid, new Map());
        const policy = fundingNativeAssets.get(pid)!;
        policy.set(an, (policy.get(an) || 0n) + BigInt(a.quantity));
      }
    }
    // Adjust for burned tokens (negative mint quantities) — those tokens are
    // destroyed, so the change output must not include them.
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
      logger.debug('[CSLTxBuilder] Added explicit change output for existing native tokens from funding UTxOs');
    }

    // Calculate script data hash BEFORE add_change_if_needed
    // Always call calc_script_data_hash for Plutus transactions - CSL requires it
    const costModels = this._createCostModels('v3');
    txb.calc_script_data_hash(costModels);

    // Now add change
    txb.add_change_if_needed(changeAddress);

    // Build transaction and patch scriptDataHash (CSL's is incorrect for Conway PlutusV3)
    const tx = txb.build_tx();
    return this._patchScriptDataHash(tx);
  }

  public async buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      // Determine execution units - default or from evaluator
      let finalExUnits = {
        mem: DEFAULT_EXECUTION_UNITS.mem.toString(),
        cpu: DEFAULT_EXECUTION_UNITS.cpu.toString()
      };

      if (ctx.evaluateTransaction) {
        // Build evaluation pass with high execution units
        logger.debug(`[CSLTxBuilder] Building evaluation pass for Plutus spending`);
        const highExUnits = {
          mem: HIGH_EXECUTION_UNITS.mem.toString(),
          cpu: HIGH_EXECUTION_UNITS.cpu.toString()
        };
        const evalTx = this._buildPlutusSpendTx(req, ctx, highExUnits);
        const evalTxCbor = Buffer.from(evalTx.to_bytes()).toString('hex');

        try {
          const evalResults = await ctx.evaluateTransaction(evalTxCbor);
          logger.debug(`[CSLTxBuilder] Evaluation results: ${JSON.stringify(evalResults)}`);

          if (evalResults && evalResults.length > 0) {
            const budget = evalResults[0].budget;
            finalExUnits = {
              mem: Math.ceil(budget.memory * EXECUTION_UNIT_BUFFER).toString(),
              cpu: Math.ceil(budget.cpu * EXECUTION_UNIT_BUFFER).toString()
            };
            logger.info(`[CSLTxBuilder] Using evaluated execution units: mem=${finalExUnits.mem}, cpu=${finalExUnits.cpu}`);
          }
        } catch (evalError: any) {
          logger.warn(`[CSLTxBuilder] Evaluation failed, using default units: ${evalError.message}`);
        }
      } else {
        logger.debug(`[CSLTxBuilder] No evaluator available, using default execution units`);
      }

      // Build final transaction with determined execution units
      const unsignedTx = this._buildPlutusSpendTx(req, ctx, finalExUnits);

      // Export as CBOR hex
      const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString('hex');

      // Extract transaction details
      const body = unsignedTx.body();
      const bodyBytes = body.to_bytes();
      const hash = blake2b(32).update(bodyBytes).digest('hex');
      const txBodyHash = hash;
      const feeLovelace = body.fee().to_str();

      // Extract outputs
      const outputs: Array<{ address: string; lovelace: string }> = [];
      const txOuts = body.outputs();
      for (let i = 0; i < txOuts.len(); i++) {
        const o = txOuts.get(i);
        outputs.push({
          address: o.address().to_bech32(),
          lovelace: o.amount().coin().to_str(),
        });
      }

      // Compute script hash from the validator script
      const spendScriptBytes = Buffer.from(req.plutusScriptExecution!.validatorScript, 'hex');
      const spendPlutusScript = CSL.PlutusScript.new_v3(spendScriptBytes);
      const spendScriptHash = Buffer.from(spendPlutusScript.hash().to_bytes()).toString('hex');

      logger.info(`[CSLTxBuilder] Built unsigned Plutus spending transaction. Fee: ${feeLovelace}`);

      return {
        unsignedTxCbor,
        txBodyHash,
        senderAddress: req.senderAddress,
        network: this.cardanoClient.network,
        sizeBytes: unsignedTxCbor.length / 2,
        builderEngine: this.name,
        feeLovelace,
        inputs: ctx.utxos.map(u => ({
          txHash: u.txHash,
          index: u.outputIndex,
          lovelace: getLovelace(u).toString(),
        })),
        outputs,
        scriptHash: spendScriptHash,
        warnings: [],
      };
    } catch (error: any) {
      logger.error(`[CSLTxBuilder] buildUnsignedPlutusSpendTransaction error: ${error?.message || error}`);
      mapBuilderError(error, 'lovelace');
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

    // Prepare addresses
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

    // Create Transaction Builder
    const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

    // Parse the Plutus validator script from CBOR hex (CBOR-wrapped flat UPLC bytecode)
    const scriptBytes = Buffer.from(plutusScriptExecution.validatorScript, 'hex');
    const plutusScript = CSL.PlutusScript.new_v3(scriptBytes);
    const scriptSource = CSL.PlutusScriptSource.new(plutusScript);

    // Build redeemer (using DetailedSchema: { "constructor": 0, "fields": [] } format)
    const redeemerPlutusData = CSL.PlutusData.from_json(
      JSON.stringify(plutusScriptExecution.redeemer),
      CSL.PlutusDatumSchema.DetailedSchema
    );
    const redeemer = CSL.Redeemer.new(
      CSL.RedeemerTag.new_spend(),
      CSL.BigNum.from_str('0'), // index will be corrected by CSL
      redeemerPlutusData,
      CSL.ExUnits.new(
        CSL.BigNum.from_str(exUnits.mem),
        CSL.BigNum.from_str(exUnits.cpu)
      )
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
      throw new Error(`[CSLTxBuilder] Script UTxO ${scriptUtxoRef.txHash}#${scriptUtxoRef.outputIndex} not found in provided UTxOs`);
    }

    // Build full multi-asset value for the script UTxO (lovelace + native assets)
    const scriptUtxoValue = CSL.Value.new(CSL.BigNum.from_str(getLovelace(scriptOdatanoUtxo).toString()));
    const scriptNonAdaAssets = scriptOdatanoUtxo.amount.filter(
      a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n
    );
    if (scriptNonAdaAssets.length > 0) {
      const scriptMultiAsset = CSL.MultiAsset.new();
      for (const asset of scriptNonAdaAssets) {
        const { policyId, assetName } = parseAssetUnit(asset.unit);
        const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
        let assets = scriptMultiAsset.get(policyHash);
        if (!assets) assets = CSL.Assets.new();
        assets.insert(CSL.AssetName.new(Buffer.from(assetName, 'hex')), CSL.BigNum.from_str(asset.quantity));
        scriptMultiAsset.insert(policyHash, assets);
      }
      scriptUtxoValue.set_multiasset(scriptMultiAsset);
    }

    // Build PlutusWitness: datum handling depends on whether UTxO has inline datum
    let plutusWitness: CSL.PlutusWitness;
    if (plutusScriptExecution.datum) {
      // Hash-based datum — add to witness set
      const datumPlutusData = CSL.PlutusData.from_json(
        JSON.stringify(plutusScriptExecution.datum),
        CSL.PlutusDatumSchema.DetailedSchema
      );
      const datumSource = CSL.DatumSource.new(datumPlutusData);
      plutusWitness = CSL.PlutusWitness.new_with_ref(scriptSource, datumSource, redeemer);
    } else {
      // Inline datum on UTxO — no datum witness needed
      plutusWitness = CSL.PlutusWitness.new_with_ref_without_datum(scriptSource, redeemer);
    }

    // Add Plutus script input
    scriptInputsBuilder.add_plutus_script_input(
      plutusWitness,
      scriptInput,
      scriptUtxoValue
    );

    txb.set_inputs(scriptInputsBuilder);

    // Add required signers if specified (for Plutus validators checking extra_signatories)
    if (req.requiredSigners?.length) {
      for (const signerHex of req.requiredSigners) {
        txb.add_required_signer(CSL.Ed25519KeyHash.from_bytes(Buffer.from(signerHex, 'hex')));
      }
    }

    // Separate sender UTxOs (excluding script UTxO)
    const senderUtxos = ctx.utxos.filter(
      u => !(u.txHash === scriptUtxoRef.txHash && u.outputIndex === scriptUtxoRef.outputIndex)
    );

    // Find an ADA-only UTxO for collateral (from sender UTxOs only)
    const collateralOdatanoUtxo = senderUtxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));

    if (collateralOdatanoUtxo) {
      const collateralBuilder = CSL.TxInputsBuilder.new();

      const colTxHash = CSL.TransactionHash.from_bytes(Buffer.from(collateralOdatanoUtxo.txHash, 'hex'));
      const colInput = CSL.TransactionInput.new(colTxHash, collateralOdatanoUtxo.outputIndex);
      const colAddress = CSL.Address.from_bech32(collateralOdatanoUtxo.address);
      const colValue = CSL.Value.new(CSL.BigNum.from_str(getLovelace(collateralOdatanoUtxo).toString()));

      collateralBuilder.add_regular_input(colAddress, colInput, colValue);
      txb.set_collateral(collateralBuilder);
    }

    // Create output for recipient BEFORE coin selection so CSL knows the full
    // output requirements (lovelace + assets + fee) when selecting funding UTxOs.
    // Include multi-assets from the script UTxO in the continuing output.
    const outputValue = CSL.Value.new(CSL.BigNum.from_str(String(req.lovelaceAmount || 2_000_000)));
    if (scriptNonAdaAssets.length > 0) {
      const outputMultiAsset = CSL.MultiAsset.new();
      for (const asset of scriptNonAdaAssets) {
        const { policyId, assetName } = parseAssetUnit(asset.unit);
        const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
        let assets = outputMultiAsset.get(policyHash);
        if (!assets) assets = CSL.Assets.new();
        assets.insert(CSL.AssetName.new(Buffer.from(assetName, 'hex')), CSL.BigNum.from_str(asset.quantity));
        outputMultiAsset.insert(policyHash, assets);
      }
      outputValue.set_multiasset(outputMultiAsset);
    }
    const recipientOutput = CSL.TransactionOutput.new(recipientAddress, outputValue);
    if (req.inlineDatum) {
      const datumData = CSL.PlutusData.from_json(
        JSON.stringify(req.inlineDatum),
        CSL.PlutusDatumSchema.DetailedSchema
      );
      recipientOutput.set_plutus_data(datumData);
    }
    txb.add_output(recipientOutput);

    // Exclude collateral UTxO from coin selection so it is not consumed on successful tx.
    // This preserves the dedicated collateral UTxO for future Plutus transactions.
    // If no funding UTxOs remain after excluding collateral, fall back to including it —
    // the same UTxO can appear in both inputs and collateral_inputs (consumed either way).
    let fundingUtxos = collateralOdatanoUtxo
      ? senderUtxos.filter(u => !(u.txHash === collateralOdatanoUtxo.txHash && u.outputIndex === collateralOdatanoUtxo.outputIndex))
      : senderUtxos;
    if (fundingUtxos.length === 0 && senderUtxos.length > 0) {
      logger.debug('[CSLTxBuilder] No funding UTxOs after collateral exclusion, including collateral in funding pool');
      fundingUtxos = senderUtxos;
    }
    const cslFundingUtxos = this._mapMultiAssetUtxosToCslUtxos(fundingUtxos);
    txb.add_inputs_from(cslFundingUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);

    // Calculate script data hash
    const costModels = this._createCostModels('v3');
    txb.calc_script_data_hash(costModels);

    // Add change
    txb.add_change_if_needed(changeAddress);

    // Build transaction and patch scriptDataHash (CSL's is incorrect for Conway PlutusV3)
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

    // 1. Get redeemers CBOR from the built transaction
    const redeemersBytes = Buffer.from(redeemers.to_bytes());

    // 2. Get datums CBOR if any (hash-based datums in witness set)
    const plutusData = witnesses.plutus_data();
    const datumsBytes = plutusData && plutusData.len() > 0
      ? Buffer.from(plutusData.to_bytes())
      : Buffer.alloc(0);

    // 3. Compute correct language views using costModelsToLanguageViewCbor
    //    Cost models are already correctly ordered by normalizeCostModels (uses toCostModelArrV3)
    const costModelsJson = JSON.parse(this.protocolParameters.costModels || '{}');
    const costModelsObj: Record<string, number[]> = {};
    const v3 = costModelsJson['plutus:v3'] || costModelsJson['PlutusV3'];
    if (Array.isArray(v3) && v3.length > 0) {
      costModelsObj.PlutusScriptV3 = Array.from(toCostModelArrV3(v3 as any)).map(Number);
    }

    const languageViews = Buffer.from(
      costModelsToLanguageViewCbor(costModelsObj as any, { mustHaveV3: !!costModelsObj.PlutusScriptV3 }).toBuffer()
    );

    // 4. Compute: blake2b256(redeemers || datums || languageViews)
    const hashInput = Buffer.concat([redeemersBytes, datumsBytes, languageViews]);
    const hashOutput = Buffer.alloc(32);
    blake2b(32).update(hashInput).digest(hashOutput);

    // 5. Patch at raw byte level (CSL caches serialized bytes internally,
    //    so set_script_data_hash + Transaction.new doesn't change the output)
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

    // 6. Reconstruct transaction from patched bytes
    return CSL.Transaction.from_bytes(txBytes);
  }

  //---------------------------------------------------------------------------
  // Private Helper Methods
  //---------------------------------------------------------------------------

  /**
   * Map ODATANO UTxOs to CSL TransactionUnspentOutputs (with multi-asset support)
   * @param utxos ODATANO UTxO array
   * @returns CSL TransactionUnspentOutputs
   */
  private _mapMultiAssetUtxosToCslUtxos(utxos: OdatanoUtxo[]): CSL.TransactionUnspentOutputs {
    const outs = CSL.TransactionUnspentOutputs.new();

    logger.debug(`Mapping ${utxos.length} UTxOs to CSL format`);

    for (const u of utxos) {
      logger.debug(`UTxO ${u.txHash}:${u.outputIndex} has ${u.amount.length} amounts: ${JSON.stringify(u.amount)}`);

      const txHashBytes = Buffer.from(u.txHash, "hex");
      const txHash = CSL.TransactionHash.from_bytes(txHashBytes);
      const input = CSL.TransactionInput.new(txHash, u.outputIndex);

      const addr = CSL.Address.from_bech32(u.address);
      
      // Build value with ADA + all native assets
      const lovelace = CSL.BigNum.from_str(getLovelace(u).toString());
      const value = CSL.Value.new(lovelace);

      // Add native assets if any
      const nonAdaAssets = u.amount.filter(a => a.unit.toLowerCase() !== 'lovelace' && BigInt(a.quantity) > 0n);
      
      if (nonAdaAssets.length > 0) {
        const multiAsset = CSL.MultiAsset.new();
        
        for (const asset of nonAdaAssets) {
          const { policyId, assetName } = parseAssetUnit(asset.unit);
          const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyId, 'hex'));
          
          let assets = multiAsset.get(policyHash);
          if (!assets) {
            assets = CSL.Assets.new();
          }
          
          const assetNameBytes = Buffer.from(assetName, 'hex');
          const assetNameObj = CSL.AssetName.new(assetNameBytes);
          assets.insert(assetNameObj, CSL.BigNum.from_str(asset.quantity));
          multiAsset.insert(policyHash, assets);
        }
        
        value.set_multiasset(multiAsset);
      }

      const output = CSL.TransactionOutput.new(addr, value);
      outs.add(CSL.TransactionUnspentOutput.new(input, output));
    }

    return outs;
  }

  /**
   * Create a CSL TransactionBuilderConfig from protocol parameters
   * This config is created once and reused for all transactions
   * @param protocolParams LedgerProtocolParameter
   * @returns CSL.TransactionBuilderConfig
   */
  private _createTxBuilderConfig(protocolParams: LedgerProtocolParameter): CSL.TransactionBuilderConfig {
    
    // required values for CSL config
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
    // Protocol params may contain decimal prices (e.g., 0.0577) - convert to integer numerators
    const priceMemValue = protocolParams.priceMem;
    const priceStepValue = protocolParams.priceStep;

    // Convert decimal prices to integer numerators (or use defaults if already integers or missing)
    const priceMemNumerator = (typeof priceMemValue === 'number' && priceMemValue < 1)
      ? Math.round(priceMemValue * 10000)  // 0.0577 -> 577
      : (priceMemValue || 577);
    const priceStepNumerator = (typeof priceStepValue === 'number' && priceStepValue < 1)
      ? Math.round(priceStepValue * 10000000)  // 0.0000721 -> 721
      : (priceStepValue || 721);

    const exUnitPrices = CSL.ExUnitPrices.new(
      CSL.UnitInterval.new(
        CSL.BigNum.from_str(String(priceMemNumerator)),    // numerator
        CSL.BigNum.from_str('10000')                        // denominator (0.0577 per memory unit)
      ),
      CSL.UnitInterval.new(
        CSL.BigNum.from_str(String(priceStepNumerator)),   // numerator
        CSL.BigNum.from_str('10000000')                     // denominator (0.0000721 per CPU step)
      )
    );

    const cfg = CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(feeAlgo)
      .pool_deposit(CSL.BigNum.from_str(String(poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(keyDeposit)))
      .max_tx_size(Number(maxTxSize))
      .max_value_size(Number(maxValueSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(coinsPerUtxoByte)))
      .ex_unit_prices(exUnitPrices)  // Critical for Plutus fee calculation
      .build();

    logger.info(`TransactionBuilderConfig created with Plutus execution unit prices.`);
    return cfg;
  }

  /**
   * Map ODATANO metadata JSON to CSL GeneralTransactionMetadata
   * @param metadataJson JSON metadata object
   * @returns CSL GeneralTransactionMetadata
   */
  private _mapOdatanoMetadataToCSLMetadata(metadataJson: JSONValue | undefined): CSL.GeneralTransactionMetadata {

    // Metadata must be an object with labels as keys
    if (typeof metadataJson !== 'object' || Array.isArray(metadataJson) || metadataJson === null) {
      throw new Error(`[CSLTxBuilder] Invalid metadata format. Expected object, got ${typeof metadataJson}`);
    }

    const metadata = CSL.GeneralTransactionMetadata.new();

    for (const [label, value] of Object.entries(metadataJson)) {
      // Convert label to BigNum
      const numericLabel = parseInt(label, 10);
      // Convert JSON Value to CSL TransactionMetadatum
      const txMetadatum = this._jsonToCSLMetadatum(value);
      logger.debug(`Created TransactionMetadatum for label ${numericLabel}`);
      metadata.insert(CSL.BigNum.from_str(String(numericLabel)), txMetadatum);
    }

    logger.debug(`Created metadata with ${metadata.len()} labels`);
    return metadata;
  }

  /**
   * Create Costmdls from protocol parameters for specific Plutus version
   * Required for correct script integrity hash calculation
   * @param version - Optional: specific Plutus version ('v1', 'v2', 'v3'). If not provided, adds all versions.
   * @returns CSL.Costmdls
   */
  private _createCostModels(version?: 'v1' | 'v2' | 'v3'): CSL.Costmdls {
    const costModels = CSL.Costmdls.new();

    // Blockfrost returns cost models as objects ({name: value}), CSL expects arrays.
    // Convert object format to sorted-key array defensively (normalizeCostModels in mappers.ts
    // already does this at the backend level, but handle it here too for robustness).
    const toArray = (costs: unknown): number[] | null => {
      if (Array.isArray(costs)) return costs;
      if (costs && typeof costs === 'object') {
        return Object.keys(costs as Record<string, number>).sort().map(k => (costs as Record<string, number>)[k]);
      }
      return null;
    };

    try {
      // Parse cost models JSON from protocol parameters
      // Format: { "plutus:v1": [array of 166 numbers], "plutus:v2": [array of 175 numbers], ... }
      const costModelsJson = JSON.parse(this.protocolParameters.costModels || '{}');

      // PlutusV1 cost model
      if (!version || version === 'v1') {
        const plutusV1Costs = toArray(costModelsJson['plutus:v1'] || costModelsJson['PlutusV1']);
        if (plutusV1Costs) {
          const plutusV1CostModel = CSL.CostModel.new();
          for (let i = 0; i < plutusV1Costs.length; i++) {
            plutusV1CostModel.set(i, CSL.Int.new_i32(plutusV1Costs[i]));
          }
          costModels.insert(CSL.Language.new_plutus_v1(), plutusV1CostModel);
          logger.debug(`[CSLTxBuilder] Added PlutusV1 cost model with ${plutusV1Costs.length} parameters`);
        }
      }

      // PlutusV2 cost model
      if (!version || version === 'v2') {
        const plutusV2Costs = toArray(costModelsJson['plutus:v2'] || costModelsJson['PlutusV2']);
        if (plutusV2Costs) {
          const plutusV2CostModel = CSL.CostModel.new();
          for (let i = 0; i < plutusV2Costs.length; i++) {
            plutusV2CostModel.set(i, CSL.Int.new_i32(plutusV2Costs[i]));
          }
          costModels.insert(CSL.Language.new_plutus_v2(), plutusV2CostModel);
          logger.debug(`[CSLTxBuilder] Added PlutusV2 cost model with ${plutusV2Costs.length} parameters`);
        }
      }

      // PlutusV3 cost model (check both "plutus:v3" and "PlutusV3" formats)
      if (!version || version === 'v3') {
        const plutusV3CostsRaw = toArray(costModelsJson['plutus:v3'] || costModelsJson['PlutusV3']);
        if (plutusV3CostsRaw) {
          // Pad to 297 parameters (Conway Chang 2) using defaults from cardano-costmodels-ts.
          // Blockfrost may return only 251 (Chang 1). The node expects 297 for scriptDataHash.
          // toCostModelArrV3() fills missing params with default values — same as Buildooor.
          const plutusV3Costs: number[] = Array.from(toCostModelArrV3(plutusV3CostsRaw as any)).map(Number);

          const plutusV3CostModel = CSL.CostModel.new();
          for (let i = 0; i < plutusV3Costs.length; i++) {
            plutusV3CostModel.set(i, CSL.Int.new_i32(plutusV3Costs[i]));
          }
          costModels.insert(CSL.Language.new_plutus_v3(), plutusV3CostModel);
          logger.debug(`[CSLTxBuilder] Added PlutusV3 cost model with ${plutusV3Costs.length} parameters`);
        }
      }

    } catch (error) {
      logger.warn(`[CSLTxBuilder] Failed to parse cost models: ${error}. Using empty cost models.`);
    }

    return costModels;
  }

  /**
   * Convert JSON value to CSL TransactionMetadatum
   * @param value JSON value
   * @returns CSL TransactionMetadatum
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

    throw new Error(`[CSLTxBuilder] Unsupported metadata value type: ${typeof value}`);
  }
}

