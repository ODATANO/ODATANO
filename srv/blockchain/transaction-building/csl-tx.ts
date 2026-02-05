import cds from '@sap/cds'
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import blake2b from "blake2b";
import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue, LedgerProtocolParameters } from "../../utils/types";
import { getLovelace } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import { InsufficientFundsError } from "../../utils/errors";
import { CardanoClient } from '../cardano-client';
import { DEFAULT_EXECUTION_UNITS, HIGH_EXECUTION_UNITS, EXECUTION_UNIT_BUFFER } from '../../utils/const';

const logger = cds.log('CSLTxBuilder');

/**
 * Maps builder errors to typed BackendErrors
 * @param err Error from builder
 * @param assetUnit Asset unit that caused the error (default: 'lovelace')
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: any, assetUnit: string = 'lovelace'): never {
  // CSL throws String errors, not Error objects - need to handle both
  const msg = (err?.message || err?.toString?.() || String(err)).toLowerCase();

  // Check for insufficient funds patterns
  if (msg.includes('not enough') ||
      msg.includes('insufficient') ||
      msg.includes('balance')) {
    throw new InsufficientFundsError(assetUnit, 0n, 0n, err);
  }

  // Re-throw original error if not mappable
  throw err;
}

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

      // add recipient & output (lovelace)
      const amount = CSL.BigNum.from_str(String(req.lovelaceAmount));
      const outValue = CSL.Value.new(amount);
      const out = CSL.TransactionOutput.new(recipientAddress, outValue);
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

        const { policyId, assetName } = this._parseAssetUnit(asset.unit);
      
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

      // Create output with all assets
      const recipientOutput = CSL.TransactionOutput.new(recipientAddress, outputValue);
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

    // Map ODATANO UTxOs -> CSL TransactionUnspentOutputs (with multi-asset support for burn transactions)
    const cslUtxos = this._mapMultiAssetUtxosToCslUtxos(ctx.utxos);

    // Create Transaction Builder
    const txb = CSL.TransactionBuilder.new(this.txBuilderConfig);

    // Parse the Plutus script from CBOR hex
    const scriptBytes = Buffer.from(req.mintingPolicyScript, 'hex');

    // Create PlutusV3 script with language version
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
      const { assetName } = this._parseAssetUnit(mintAction.assetUnit);

      // Create asset name
      const assetNameBytes = Buffer.from(assetName, 'hex');
      const cslAssetName = CSL.AssetName.new(assetNameBytes);

      // Create mint quantity (can be negative for burning)
      const mintQuantity = CSL.Int.new_i32(Number(mintAction.quantity));

      // Create redeemer with specified execution units
      const redeemerData = CSL.PlutusData.new_integer(CSL.BigInt.from_str('0'));
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

    // Create output with minted assets + minimum lovelace
    const minLovelace = CSL.BigNum.from_str(String(req.lovelaceAmount));
    const outputValue = CSL.Value.new(minLovelace);
    const finalOutputValue = outputValue.checked_add(totalMintedValue);

    const recipientOutput = CSL.TransactionOutput.new(recipientAddress, finalOutputValue);
    txb.add_output(recipientOutput);

    // Add collateral for Plutus script execution
    if (ctx.utxos.length > 0) {
      const collateralUtxo = ctx.utxos[0];
      const collateralBuilder = CSL.TxInputsBuilder.new();

      const txHash = CSL.TransactionHash.from_bytes(Buffer.from(collateralUtxo.txHash, 'hex'));
      const input = CSL.TransactionInput.new(txHash, collateralUtxo.outputIndex);
      const address = CSL.Address.from_bech32(collateralUtxo.address);
      const value = CSL.Value.new(CSL.BigNum.from_str(getLovelace(collateralUtxo).toString()));

      collateralBuilder.add_regular_input(address, input, value);
      txb.set_collateral(collateralBuilder);
    }

    // Add inputs via coin selection
    txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);

    // Calculate script data hash BEFORE add_change_if_needed
    // Always call calc_script_data_hash for Plutus transactions - CSL requires it
    const costModels = this._createCostModels('v3');
    txb.calc_script_data_hash(costModels);

    // Now add change
    txb.add_change_if_needed(changeAddress);

    // Build and return transaction
    return txb.build_tx();
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
          const { policyId, assetName } = this._parseAssetUnit(asset.unit);
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
   * Parse asset unit string into policyId and assetName
   * Format: policyId (56 hex chars) + assetName (remaining hex)
   * This is the standard Cardano asset unit format
   */
  private _parseAssetUnit(assetUnit: string): { policyId: string; assetName: string } {
      return {
        policyId: assetUnit.substring(0, 56),
        assetName: assetUnit.substring(56)
    }
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

    try {
      // Parse cost models JSON from protocol parameters
      // Format: { "plutus:v1": [array of 166 numbers], "plutus:v2": [array of 175 numbers], ... }
      const costModelsJson = JSON.parse(this.protocolParameters.costModels || '{}');

      // PlutusV3 cost model (check both "plutus:v3" and "PlutusV3" formats)
      if (!version || version === 'v3') {
        const plutusV3Costs = costModelsJson['plutus:v3'] || costModelsJson['PlutusV3'];
        if (plutusV3Costs && Array.isArray(plutusV3Costs)) {
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

