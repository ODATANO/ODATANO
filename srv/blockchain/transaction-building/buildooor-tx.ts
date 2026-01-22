import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue } from "../../utils/types";
import { TxBuilder } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace, selectUtxosForAsset } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cardano from "../cardano-client";
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
import { DataI } from "@harmoniclabs/plutus-data";

const logger = cds.log('BuildooorTxBuilder');

/** 
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = 'BuildooorTxBuilder';
  private txBuilder!: TxBuilder;

  /** 
   * Initialize the builder
   */
  public async init(): Promise<void> {
    const protocolParams = await cardano.getProtocolParameters();
    const txbParameters = this._mapLedgerParametersToBuildooorParams(protocolParams);
    this.txBuilder = new TxBuilder(txbParameters);
    logger.debug(`TxBuilder initialized with protocol parameters`);
  }

  /**
   * Build unsigned ADA transfer transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {

    // mapping of ODATANO UTxO Type to ledger-ts UTxO objects
    const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapOdatanoUtxoToLedgerUtxo(utxo));

    // and map to Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));

    // set Addresses
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);
    // set Amount
    const amount = BigInt(String(req.lovelaceAmount));

    // build new outputs for recipient
    const outputs = [
      new TxOut({
        address: recipientAddress,
        value: Value.lovelaces(amount)
      })
    ];
    // build the transaction
    const tx = await this.txBuilder.build({
      inputs,
      outputs,
      changeAddress,
    });

    // full unsigned tx cbor (4-tuple, witness empty)
    const unsignedTxBytes = tx.toCbor().toBuffer();
    const unsignedTxCbor = toHex(unsignedTxBytes);
    const txBodyHash = tx.hash.toString();

    logger.debug(`Built unsigned transaction successfully.`);

    return {
      unsignedTxCbor: unsignedTxCbor,
      txBodyHash: txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
      builderEngine: this.name,
      feeLovelace: tx.body.fee.toString(),
      inputs: ctx.utxos.map(u => ({
        txHash: u.txHash,
        index: u.outputIndex,
        lovelace: getLovelace(u).toString()
      })),
      outputs: tx.body.outputs.map((o: any) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
      warnings: []
    };
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // mapping of ODATANO UTxO Type to ledger-ts UTxO objects
    const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapOdatanoUtxoToLedgerUtxo(utxo));

    // Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));
    // Addresses
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);
    // Amount
    const amount = BigInt(String(req.lovelaceAmount));

    const metadata = this._mapOdatanoMetadataToLedgerMetadata(req.metadataJson);

    // build new outputs for recipient
    const outputs = [
      new TxOut({
        address: recipientAddress,
        value: Value.lovelaces(amount)
      })
    ];
    // build the transaction
    const tx = await this.txBuilder.build({
      inputs,
      outputs,
      changeAddress,
      metadata
    });

    // full unsigned tx cbor (4-tuple, witness empty)
    const unsignedTxBytes = tx.toCbor().toBuffer();
    const unsignedTxCbor = toHex(unsignedTxBytes);
    const txBodyHash = tx.hash.toString();

    logger.debug(`Built unsigned transaction successfully.`);

    return {
      unsignedTxCbor: unsignedTxCbor,
      txBodyHash: txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
      builderEngine: this.name,
      feeLovelace: tx.body.fee.toString(),
      inputs: ctx.utxos.map(u => ({
        txHash: u.txHash,
        index: u.outputIndex,
        lovelace: getLovelace(u).toString()
      })),
      outputs: tx.body.outputs.map((o: any) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
      warnings: []
    };
  }

  public async buildUnsignedMultiAssetTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    if (!req.assets || req.assets.length === 0) {
      throw new Error('[BuildooorTxBuilder] buildUnsignedMultiAssetTransaction requires assets to be specified');
    }

    // Select UTxOs for each required asset
    const selectedUtxos: OdatanoUtxo[] = [];
    const requiredAssets = new Map<string, bigint>();

    // Add lovelace requirement
    requiredAssets.set('lovelace', BigInt(req.lovelaceAmount));

    // Add all asset requirements
    for (const asset of req.assets) {
      const existing = requiredAssets.get(asset.unit) ?? 0n;
      requiredAssets.set(asset.unit, existing + BigInt(asset.quantity));
    }

    // Select UTxOs for each asset
    for (const [assetUnit, targetAmount] of requiredAssets.entries()) {
      const utxosForAsset = selectUtxosForAsset(ctx.utxos, assetUnit, targetAmount);

      // Add new UTxOs that haven't been selected yet
      for (const utxo of utxosForAsset) {
        if (!selectedUtxos.some(u => u.txHash === utxo.txHash && u.outputIndex === utxo.outputIndex)) {
          selectedUtxos.push(utxo);
        }
      }
    }

    logger.debug(`Selected ${selectedUtxos.length} UTxOs for multi-asset transaction`);

    // Map to ledger UTxOs for Buildooor
    const ledgerUtxos: LedgerUTxO[] = selectedUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

    // Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));

    // Addresses
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);

    // Build output value with ADA + assets
    let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount));

    for (const asset of req.assets) {
      // Parse policyId and assetName from unit (format: policyId.assetName or policyId+assetName)
      const { policyId, assetName } = this._parseAssetUnit(asset.unit);
      const policyHash = new Hash28(policyId);
      const assetValue = Value.singleAsset(policyHash, Buffer.from(assetName, 'hex'), BigInt(asset.quantity));
      outputValue = Value.add(outputValue, assetValue);
    }

    // Build output
    const outputs = [
      new TxOut({
        address: recipientAddress,
        value: outputValue
      })
    ];

    // Build the transaction
    const tx = await this.txBuilder.build({
      inputs,
      outputs,
      changeAddress,
    });

    // Full unsigned tx cbor (4-tuple, witness empty)
    const unsignedTxBytes = tx.toCbor().toBuffer();
    const unsignedTxCbor = toHex(unsignedTxBytes);
    const txBodyHash = tx.hash.toString();

    logger.debug(`Built unsigned multi-asset transaction successfully.`);

    return {
      unsignedTxCbor: unsignedTxCbor,
      txBodyHash: txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
      builderEngine: this.name,
      feeLovelace: tx.body.fee.toString(),
      inputs: selectedUtxos.map(u => ({
        txHash: u.txHash,
        index: u.outputIndex,
        lovelace: getLovelace(u).toString()
      })),
      outputs: tx.body.outputs.map((o: any) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
      warnings: []
    };
  }

  public async buildUnsignedMintTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {

    if (!req.mintActions || req.mintActions.length === 0) {
      throw new Error('[BuildooorTxBuilder] buildUnsignedMintTransaction requires mintActions to be specified');
    }

    if (!req.mintingPolicyScript) {
      throw new Error('[BuildooorTxBuilder] buildUnsignedMintTransaction requires mintingPolicyScript to be specified');
    }

    const minLovelace = BigInt(req.lovelaceAmount || 3_000_000); // Minimum 3 ADA to ensure enough for Plutus fees
    const plutusBuffer = 2_000_000n; // Extra 2 ADA buffer for Plutus fees + CBOR collateral overhead
    const totalRequired = minLovelace + plutusBuffer;

    const selectedUtxos = selectUtxosForAsset(ctx.utxos, 'lovelace', totalRequired);

    logger.debug(`Selected ${selectedUtxos.length} UTxOs for minting transaction (${totalRequired} lovelace required)`);

    // Map to ledger UTxOs - use multi-asset mapper to support burn transactions
    // (burn transactions need to consume UTxOs with the tokens being burned)
    const ledgerUtxos: LedgerUTxO[] = selectedUtxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

    // Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));

    // Addresses
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);

    // Build mint value and mints array
    const mints = [];

    for (const mintAction of req.mintActions) {
      const { policyId, assetName } = this._parseAssetUnit(mintAction.assetUnit);

      // Create Hash28 for policy ID
      const policyHash = new Hash28(policyId);

      const assetValue = Value.singleAsset(
        policyHash,
        Buffer.from(assetName, 'hex'),
        BigInt(mintAction.quantity) // Ensure BigInt conversion
      );

      // Parse the minting policy script from CBOR hex
      const scriptBytes = Buffer.from(req.mintingPolicyScript!, 'hex');
      const script = Script.fromCbor(scriptBytes);

      mints.push({
        value: assetValue,
        script: {
          inline: script,
          redeemer: new DataI(0), // Simple redeemer - @TODO make it customizable / with parameters like the MintAction
          // Explicitly set execution units budget for Plutus script
          // This ensures Buildooor accounts for script execution costs in fee calculation
          executionUnits: {
            mem: 1_000_000,  // 1M memory units 
            cpu: 500_000_000  // 500M CPU steps
          }
        }
      });
    }

    // calculate total mint value for output (only positive quantities - mints, not burns)
    let mintValue = Value.lovelaces(0n);
    for (const mintAction of req.mintActions) {
      const quantity = BigInt(mintAction.quantity);
      // Only add to output if minting (positive quantity), not burning (negative)
      if (quantity > 0n) {
        const { policyId, assetName } = this._parseAssetUnit(mintAction.assetUnit);
        const policyHash = new Hash28(policyId);
        const assetValue = Value.singleAsset(
          policyHash,
          Buffer.from(assetName, 'hex'),
          quantity
        );
        mintValue = Value.add(mintValue, assetValue);
      }
    }

    // Build output value - recipient gets the minted assets + min ADA
    let outputValue = Value.lovelaces(BigInt(req.lovelaceAmount || 1_000_000));
    outputValue = Value.add(outputValue, mintValue);

    // Build output
    const outputs = [
      new TxOut({
        address: recipientAddress,
        value: outputValue
      })
    ];

    // Find an ADA-only UTxO for collateral (Plutus scripts require ADA-only collateral)
    // First try from selected UTxOs, then fall back to all available UTxOs
    const adaOnlyUtxo = selectedUtxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'))
      || ctx.utxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));

    if (!adaOnlyUtxo) {
      throw new Error('[BuildooorTxBuilder] No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral.');
    }

    // Use only 1 collateral to minimize tx size
    const collateralUtxos = [this._mapOdatanoUtxoToLedgerUtxo(adaOnlyUtxo)];

    // First build to calculate base fee
    const txFirstPass = await this.txBuilder.build({
      inputs,
      outputs,
      changeAddress,
      mints: mints,
      collaterals: collateralUtxos
    });

    // Add minimal buffer for witness set CBOR overhead (signing adds ~44 bytes)
    // Auto-evaluation handles execution units accurately, but we still need to account
    // for the CBOR size increase when the witness set is added during signing
    const calculatedFee = BigInt(txFirstPass.body.fee.toString());
    const witnessBuffer = BigInt(50); // Minimal buffer for witness overhead
    const adjustedMinFee = calculatedFee + witnessBuffer;

    logger.debug(`First pass fee: ${calculatedFee}, rebuilding with witness buffer: ${adjustedMinFee}`);

    // Second build with adjusted minimum fee to account for witness overhead
    const tx = await this.txBuilder.build({
      inputs,
      outputs,
      changeAddress,
      mints: mints,
      collaterals: collateralUtxos,
      fee: adjustedMinFee
    });

    // Full unsigned tx cbor (4-tuple, witness empty)
    const unsignedTxBytes = tx.toCbor().toBuffer();
    const unsignedTxCbor = toHex(unsignedTxBytes);
    const txBodyHash = tx.hash.toString();

    logger.debug(`Built unsigned minting transaction successfully with fee: ${tx.body.fee.toString()}`);

    return {
      unsignedTxCbor: unsignedTxCbor,
      txBodyHash: txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
      builderEngine: this.name,
      feeLovelace: tx.body.fee.toString(),
      inputs: selectedUtxos.map(u => ({
        txHash: u.txHash,
        index: u.outputIndex,
        lovelace: getLovelace(u).toString()
      })),
      outputs: tx.body.outputs.map((o: any) => ({
        address: o.address?.toString?.() ?? "",
        lovelace: o.value?.lovelaces?.toString?.() ?? "0"
      })),
      warnings: []
    };
  }

  //---------------------------------------------------------------------------
  // Private Helper Methods
  //---------------------------------------------------------------------------

  /** 
   * Map ODATANO LedgerProtocolParameter to Buildooor's ProtocolParameters shape
   * @param protocolParameters ledger protocol parameters
   * @returns mapped protocol parameters
   */
  private _mapLedgerParametersToBuildooorParams(
    protocolParameters: LedgerProtocolParameter
  ): any {
    // Map LedgerProtocolParameter to Buildooor's ProtocolParameters shape
    // Using defaultProtocolParameters as base and overriding with actual values
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
   * @param utxos ODATANO UTxO
   * @returns mapped Ledger UTxO
   */
  private _mapOdatanoUtxoToLedgerUtxo(utxos: OdatanoUtxo): any {
    assertAdaOnly(utxos);
    const txId = utxos.txHash;

    const outRef = new TxOutRef({
      id: txId as any,
      index: utxos.outputIndex
    });

    const addr = Address.fromString(utxos.address)
    const value = Value.lovelaces(getLovelace(utxos));

    return new (LedgerUTxO as any)({
      utxoRef: outRef,
      resolved: {
        address: addr,
        value,
        datum: undefined,
        refScript: undefined
      }
    });
  }

  /** 
   * Map ODATANO UTxO to Ledger UTxO (with multi-asset support)
   * @param utxo ODATANO UTxO
   * @returns mapped Ledger UTxO
   */
  private _mapMultiAssetUtxoToLedgerUtxo(utxo: OdatanoUtxo): any {
    const txId = utxo.txHash;

    const outRef = new TxOutRef({
      id: txId as any,
      index: utxo.outputIndex
    });

    const addr = Address.fromString(utxo.address);

    // Build Value from all amounts
    let value = Value.lovelaces(getLovelace(utxo));

    for (const amount of utxo.amount) {
      if (amount.unit.toLowerCase() !== 'lovelace') {
        const { policyId, assetName } = this._parseAssetUnit(amount.unit);
        const policyHash = new Hash28(policyId);
        const assetValue = Value.singleAsset(policyHash, Buffer.from(assetName, 'hex'), BigInt(amount.quantity));
        value = Value.add(value, assetValue);
      }
    }

    return new (LedgerUTxO as any)({
      utxoRef: outRef,
      resolved: {
        address: addr,
        value,
        datum: undefined,
        refScript: undefined
      }
    });
  }

  /**
   * Parse asset unit string into policyId and assetName
   * @param unit asset unit string (e.g., "policyId.assetName" or "policyIdAssetName")
   * @returns {object} object with policyId and assetName
   */
  private _parseAssetUnit(unit: string): { policyId: string; assetName: string } {

    return {
      policyId: unit.substring(0, 56),
      assetName: unit.substring(56)
    }
  }

  /**
   * Map ODATANO metadata JSON to Ledger TxMetadata
   * @param metadataJson  metadata in JSON format
   * @returns mapped TxMetadata
   */
  private _mapOdatanoMetadataToLedgerMetadata(metadataJson: JSONValue | undefined): TxMetadata {
    if (!metadataJson) {
      return new TxMetadata({});
    }

    const metadata: { [label: number]: TxMetadatum } = {};

    for (const [label, value] of Object.entries(metadataJson)) {
      // convert label to number
      const numericLabel = parseInt(label, 10);
      // convert JSON value to TxMetadatum
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
   * @param value JSON value
   * @returns corresponding TxMetadatum
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

    throw new Error(`[BuildooorTxBuilder] Unsupported metadata value type: ${typeof value}`);
  }
}

