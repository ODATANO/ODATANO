import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildMintRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue } from "../../utils/types";
import { TxBuilder } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import { getCardanoClient } from "../cardano-client";
import cds from "@sap/cds";
import { InsufficientFundsError } from "../../utils/errors";
import { CONFIG } from "../../../config/config";
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
 * Maps builder errors to typed BackendErrors
 * @param err Error from builder
 * @param assetUnit Asset unit that caused the error (default: 'lovelace')
 * @throws {InsufficientFundsError} if error is related to insufficient funds
 * @throws {Error} original error if not mappable
 */
export function mapBuilderError(err: any, assetUnit: string = 'lovelace'): never {
  const msg = err?.message?.toLowerCase() || '';

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
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = 'BuildooorTxBuilder';
  private txBuilder!: TxBuilder;

  /** 
   * Initialize the builder
   */
  public async init(): Promise<void> {
    const protocolParams = await getCardanoClient().getProtocolParameters();
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
    try {
      // mapping of ODATANO UTxO Type to ledger-ts UTxO objects (with multi-asset support)
      // This allows spending UTxOs that contain native assets - they will be returned in the change output
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // and map to Buildooor TxIn objects for inputs
      const inputs = ledgerUtxos.map(utxo => ({ utxo }));

      // set Addresses
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
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
    } catch (err: any) {
      mapBuilderError(err, 'lovelace');
    }
  }

  public async buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {
      // mapping of ODATANO UTxO Type to ledger-ts UTxO objects (with multi-asset support)
      // This allows spending UTxOs that contain native assets - they will be returned in the change output
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // Buildooor TxIn objects for inputs
      const inputs = ledgerUtxos.map(utxo => ({ utxo }));
      // Addresses
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);
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
    } catch (err: any) {
      mapBuilderError(err, 'lovelace');
    }
  }

  public async buildUnsignedMultiAssetTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    if (!req.assets || req.assets.length === 0) {
      throw new Error('[BuildooorTxBuilder] buildUnsignedMultiAssetTransaction requires assets to be specified');
    }

    try {
      // Map all available UTxOs to ledger UTxOs for Buildooor (let builder handle selection)
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

    // Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));

    // Addresses
    const recipientAddress = Address.fromString(req.recipientAddress);
    const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

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
    } catch (err: any) {
      // Extract asset unit from error message if possible
      const assetMatch = err?.message?.match(/not enough\s+([a-f0-9.]+)/i);
      const assetUnit = assetMatch?.[1] || 'assets';
      mapBuilderError(err, assetUnit);
    }
  }

  public async buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    try {

      // Map all available UTxOs to ledger UTxOs (let builder handle selection)
      // Use multi-asset mapper to support burn transactions
      const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapMultiAssetUtxoToLedgerUtxo(utxo));

      // Buildooor TxIn objects for inputs
      const inputs = ledgerUtxos.map(utxo => ({ utxo }));

      // Addresses
      const recipientAddress = Address.fromString(req.recipientAddress);
      const changeAddress = Address.fromString(req.changeAddress ?? req.senderAddress);

      // Parse the minting policy script once
      const scriptBytes = Buffer.from(req.mintingPolicyScript, 'hex');
      const script = Script.fromCbor(scriptBytes);

      // Helper to build mints array with specified execution units
      const buildMints = (exUnits: { mem: number; cpu: number }) => {
        const mints = [];
        for (const mintAction of req.mintActions) {
          const { policyId, assetName } = this._parseAssetUnit(mintAction.assetUnit);
          const policyHash = new Hash28(policyId);
          const assetValue = Value.singleAsset(
            policyHash,
            Buffer.from(assetName, 'hex'),
            BigInt(mintAction.quantity)
          );

          mints.push({
            value: assetValue,
            script: {
              inline: script,
              redeemer: new DataI(0), // Simple redeemer - @TODO make it customizable
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
      const adaOnlyUtxo = ctx.utxos.find(u => u.amount.every(a => a.unit.toLowerCase() === 'lovelace'));

      if (!adaOnlyUtxo) {
        throw new Error('[BuildooorTxBuilder] No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral.');
      }

      // Use only 1 collateral to minimize tx size
      const collateralUtxos = [this._mapOdatanoUtxoToLedgerUtxo(adaOnlyUtxo)];

      // Determine execution units based on evaluator availability
      let finalExUnits = CONFIG.DEFAULT_EXECUTION_UNITS;

      if (ctx.evaluateTransaction) {
        // Build first pass with high execution units for evaluation
        logger.debug(`Building evaluation pass with high execution units`);
        const evalMints = buildMints(CONFIG.HIGH_EXECUTION_UNITS);

        const evalTx = await this.txBuilder.build({
          inputs,
          outputs,
          changeAddress,
          mints: evalMints,
          collaterals: collateralUtxos
        });

        const evalTxCbor = toHex(evalTx.toCbor().toBuffer());

        try {
          // Evaluate to get exact execution units
          const evalResults = await ctx.evaluateTransaction(evalTxCbor);
          logger.debug(`Evaluation results: ${JSON.stringify(evalResults)}`);

          if (evalResults && evalResults.length > 0) {
            // Use the evaluated budget (take first result for single script)
            const budget = evalResults[0].budget;
            // Add safety margin to evaluated units
            finalExUnits = {
              mem: Math.ceil(budget.memory * CONFIG.EXECUTION_UNIT_BUFFER),
              cpu: Math.ceil(budget.cpu * CONFIG.EXECUTION_UNIT_BUFFER)
            };
            logger.info(`Using evaluated execution units: mem=${finalExUnits.mem}, cpu=${finalExUnits.cpu}`);
          }
        } catch (evalError: any) {
          logger.warn(`Evaluation failed, using default units: ${evalError.message}`);
          // Fall back to defaults on evaluation failure
        }
      } else {
        logger.debug(`No evaluator available, using default execution units`);
      }

      // Build with final execution units
      const mints = buildMints(finalExUnits);

      // First build to calculate base fee
      const txFirstPass = await this.txBuilder.build({
        inputs,
        outputs,
        changeAddress,
        mints: mints,
        collaterals: collateralUtxos
      });

      // Add minimal buffer for witness set CBOR overhead (signing adds ~44 bytes)
      const calculatedFee = BigInt(txFirstPass.body.fee.toString());
      const witnessBuffer = BigInt(CONFIG.TX_BUILDING.WITNESS_BUFFER_BYTES);
      const adjustedMinFee = calculatedFee + witnessBuffer;

      logger.debug(`First pass fee: ${calculatedFee}, rebuilding with witness buffer: ${adjustedMinFee}`);

      // Final build with adjusted minimum fee to account for witness overhead
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
    } catch (err: any) {
      mapBuilderError(err, 'lovelace');
    }
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
  private _mapOdatanoUtxoToLedgerUtxo(utxos: OdatanoUtxo): LedgerUTxO {
    assertAdaOnly(utxos);

    const outRef = new TxOutRef({
      id: utxos.txHash,
      index: utxos.outputIndex
    });

    const addr = Address.fromString(utxos.address);
    const value = Value.lovelaces(getLovelace(utxos));

    return new LedgerUTxO({
      utxoRef: outRef,
      resolved: new TxOut({
        address: addr,
        value,
        datum: undefined,
        refScript: undefined
      })
    });
  }

  /**
   * Map ODATANO UTxO to Ledger UTxO (with multi-asset support)
   * @param utxo ODATANO UTxO
   * @returns mapped Ledger UTxO
   */
  private _mapMultiAssetUtxoToLedgerUtxo(utxo: OdatanoUtxo): LedgerUTxO {
    const outRef = new TxOutRef({
      id: utxo.txHash,
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

    return new LedgerUTxO({
      utxoRef: outRef,
      resolved: new TxOut({
        address: addr,
        value,
        datum: undefined,
        refScript: undefined
      })
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

