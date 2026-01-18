import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo, JSONValue } from "../../utils/types";
import { TxBuilder } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";
import cardano from "../cardano-client";

import {
  defaultProtocolParameters,
  Address,
  UTxO as LedgerUTxO,
  Value,
  TxOut,
  TxOutRef
} from "@harmoniclabs/cardano-ledger-ts";

import { TxMetadata } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata";
import type { TxMetadatum } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { TxMetadatumInt } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { TxMetadatumText } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { TxMetadatumList } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";
import { TxMetadatumMap } from "@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum";

import logger from "../../utils/logger";

/** 
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = "buildooor";
  private txBuilder!: TxBuilder;

  /** 
   * Initialize the builder
   */
  public async init(): Promise<void> {
    const protocolParams = await cardano.getProtocolParameters();
    const txbParameters = this._mapLedgerParametersToBuildooorParams(protocolParams);
    this.txBuilder = new TxBuilder(txbParameters);
    logger.info(`[BuildooorTxBuilder] TxBuilder initialized with protocol parameters.`);
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

    // Buildooor TxIn objects for inputs
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));
    // Addresses
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);
    // Amount
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

    logger.info(`[BuildooorTxBuilder] Built unsigned transaction successfully.`);

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

    logger.info(`[BuildooorTxBuilder] Built unsigned transaction successfully.`);

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

  public async buildUnsignedMultiAssetTransaction(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    throw new Error("[BuildooorTxBuilder] buildUnsignedMultiAssetTransaction not yet implemented");
  }

  public async buildUnsignedPlutusTransaction(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    throw new Error("[BuildooorTxBuilder] buildUnsignedPlutusTransaction not yet implemented");
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
   * Map ODATANO UTxO to Ledger UTxO
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

  private _mapOdatanoMetadataToLedgerMetadata(metadataJson: JSONValue | undefined): TxMetadata {
    if (!metadataJson) {
      return new TxMetadata({});
    }

    // Metadata muss ein Objekt sein mit Labels als Keys
    if (typeof metadataJson !== 'object' || Array.isArray(metadataJson) || metadataJson === null) {
      throw new Error(`[BuildooorTxBuilder] Invalid metadata format. Expected object, got ${typeof metadataJson}`);
    }

    const metadata: { [label: number]: TxMetadatum } = {};

    for (const [label, value] of Object.entries(metadataJson)) {
      // Konvertiere Label zu Number
      const numericLabel = parseInt(label, 10);
      if (isNaN(numericLabel)) {
        throw new Error(`[BuildooorTxBuilder] Invalid metadata label: ${label}. Labels must be numeric.`);
      }
      // Konvertiere JSON Value zu TxMetadatum
      const txMetadatum = this._jsonToTxMetadatum(value);
      logger.debug(`[BuildooorTxBuilder] Created TxMetadatum for label ${numericLabel}: ${txMetadatum.constructor.name}`);
      metadata[numericLabel] = txMetadatum;
    }

    logger.debug(`[BuildooorTxBuilder] Creating TxMetadata with ${Object.keys(metadata).length} labels`);
    const txMetadata = new TxMetadata(metadata);
    logger.debug(`[BuildooorTxBuilder] TxMetadata created: ${txMetadata.constructor.name}, instanceof check: ${txMetadata instanceof TxMetadata}`);
    return txMetadata;
  }

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

