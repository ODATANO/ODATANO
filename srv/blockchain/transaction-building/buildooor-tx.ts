import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo } from "../../utils/types";
import { TxBuilder } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { assertAdaOnly, getLovelace } from "../../utils/tx-build-helper";

import {
  defaultProtocolParameters,
  Address,
  UTxO as LedgerUTxO,
  Value,
  TxOut,
  TxOutRef
} from "@harmoniclabs/cardano-ledger-ts";
import logger from "../../utils/logger";

/** 
 * BuildooorTxBuilder - Implementation of CardanoTxBuilder using Buildooor library
 */
export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = "buildooor";

  /** 
   * Initialize the builder (no-op for Buildooor) 
   */
  public async init(): Promise<void> { }

  /**
   * Build unsigned ADA transfer transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {

    const txbParameters = this._mapLedgerParametersToBuildooorParams();
    const txb = new TxBuilder(txbParameters);

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
    const tx = await txb.build({
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

  //---------------------------------------------------------------------------
  // Private Helper Methods
  //---------------------------------------------------------------------------

  /** 
   * Map ODATANO LedgerProtocolParameter to Buildooor's ProtocolParameters shape
   * @param protocolParameters ledger protocol parameters
   * @returns mapped protocol parameters
   */
  private _mapLedgerParametersToBuildooorParams(
    //protocolParameters: LedgerProtocolParameter
  ): any {
    // Map LedgerProtocolParameter to Buildooor's ProtocolParameters shape
    return defaultProtocolParameters;
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
}

