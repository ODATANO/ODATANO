import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import blake2b from "blake2b";
import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue } from "../../utils/types";
import logger from "../../utils/logger";
import { assertAdaOnly, getLovelace } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cardano from "../cardano-client";

/**
 * CSLTxBuilder - Implementation of CardanoTxBuilder using cardano-serialization-lib (CSL)
 */
export class CSLTxBuilder implements CardanoTxBuilder {
  public readonly name = "csl";
  private txBuilderConfig!: CSL.TransactionBuilderConfig;

  /**
   * Initialize the builder
   */
  public async init(): Promise<void> {
    const protocolParams = await cardano.getProtocolParameters();
    this.txBuilderConfig = this._createTxBuilderConfig(protocolParams);
    logger.info(`[CSLTxBuilder] TxBuilder initialized with protocol parameters.`);
  }

  /**
   * Build unsigned ADA transfer transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // prepare addresses
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

    // map ODATANO UTxOs -> CSL TransactionUnspentOutputs
    const cslUtxos = this._mapOdatanoUtxosToCslUtxos(ctx.utxos);

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

    logger.info(`[CSLTxBuilder] Built unsigned transaction successfully.`);

    return {
      unsignedTxCbor,
      txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
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
  }

  //---------------------------------------------------------------------------
  // Private Helper Methods
  //---------------------------------------------------------------------------

  /**
   * Map ODATANO UTxOs to CSL TransactionUnspentOutputs (ADA-only for now)
   * @param utxos ODATANO UTxO array
   * @returns CSL TransactionUnspentOutputs
   */
  private _mapOdatanoUtxosToCslUtxos(utxos: OdatanoUtxo[]): CSL.TransactionUnspentOutputs {
    const outs = CSL.TransactionUnspentOutputs.new();

    for (const u of utxos) {
      assertAdaOnly(u);

      const txHashBytes = Buffer.from(u.txHash, "hex");
      const txHash = CSL.TransactionHash.from_bytes(txHashBytes);
      const input = CSL.TransactionInput.new(txHash, u.outputIndex);

      const addr = CSL.Address.from_bech32(u.address);
      const value = CSL.Value.new(CSL.BigNum.from_str(getLovelace(u).toString()));
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

    const cfg = CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(feeAlgo)
      .pool_deposit(CSL.BigNum.from_str(String(poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(keyDeposit)))
      .max_tx_size(Number(maxTxSize))
      .max_value_size(Number(maxValueSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(coinsPerUtxoByte)))
      .build();

    logger.info(`[CSLTxBuilder] TransactionBuilderConfig created from protocol parameters.`);
    return cfg;
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // prepare addresses
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

    // map ODATANO UTxOs -> CSL TransactionUnspentOutputs
    const cslUtxos = this._mapOdatanoUtxosToCslUtxos(ctx.utxos);

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

    logger.info(`[CSLTxBuilder] Built unsigned transaction with metadata successfully.`);

    return {
      unsignedTxCbor,
      txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
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
  }

  public async buildUnsignedMultiAssetTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    throw new Error("[CSLTxBuilder] buildUnsignedMultiAssetTransaction not yet implemented");
  }

  public async buildUnsignedPlutusTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    throw new Error("[CSLTxBuilder] buildUnsignedPlutusTransaction not yet implemented");
  }

  /**
   * Map ODATANO metadata JSON to CSL GeneralTransactionMetadata
   * @param metadataJson JSON metadata object
   * @returns CSL GeneralTransactionMetadata
   */
  private _mapOdatanoMetadataToCSLMetadata(metadataJson: JSONValue | undefined): CSL.GeneralTransactionMetadata {
    if (!metadataJson) {
      return CSL.GeneralTransactionMetadata.new();
    }

    // Metadata must be an object with labels as keys
    if (typeof metadataJson !== 'object' || Array.isArray(metadataJson) || metadataJson === null) {
      throw new Error(`[CSLTxBuilder] Invalid metadata format. Expected object, got ${typeof metadataJson}`);
    }

    const metadata = CSL.GeneralTransactionMetadata.new();

    for (const [label, value] of Object.entries(metadataJson)) {
      // Convert label to BigNum
      const numericLabel = parseInt(label, 10);
      if (isNaN(numericLabel)) {
        throw new Error(`[CSLTxBuilder] Invalid metadata label: ${label}. Labels must be numeric.`);
      }
      // Convert JSON Value to CSL TransactionMetadatum
      const txMetadatum = this._jsonToCSLMetadatum(value);
      logger.debug(`[CSLTxBuilder] Created TransactionMetadatum for label ${numericLabel}`);
      metadata.insert(CSL.BigNum.from_str(String(numericLabel)), txMetadatum);
    }

    logger.debug(`[CSLTxBuilder] Created metadata with ${metadata.len()} labels`);
    return metadata;
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
