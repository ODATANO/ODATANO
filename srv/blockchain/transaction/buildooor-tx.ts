// srv/tx/engines/buildooor.tx-builder.ts
import type { CardanoTxBuilder} from "./cardano-tx";
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
import { LedgerProtocolParameter } from "#cds-models/odatano/cardano";

export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = "buildooor";
  public async init(): Promise<void> {}

  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {

    const txbParameters = this._mapLedgerParametersToBuildooorParams(ctx.protocolParameters);
    
    console.log("Using Buildooor TxBuilder with parameters:", txbParameters);
    const txb = new TxBuilder(txbParameters);

    // Map ODATANO UTxOs -> ledger-ts UTxO objects
    const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(utxo => this._mapOdatanoUtxoToLedgerUtxo(utxo));

    // Buildooor ITxBuildInput shape: { utxo: UTxO }
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));
    const recipientAddress = (Address as any).fromBech32(req.recipientAddress);
    const changeAddress = (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);

    const amount = BigInt(String(req.lovelaceAmount));

    // Buildooor TxOut objects for outputs
    const outputs = [
      new TxOut({
        address: recipientAddress,
        value: Value.lovelaces(amount)
      })
    ];
    
    const tx = await txb.build({
      inputs,
      outputs,
      changeAddress,
    });

      // Full unsigned tx cbor (4-tuple, witness empty)
    const unsignedTxBytes = tx.toCbor().toBuffer();
    const unsignedTxCbor = toHex(unsignedTxBytes);

    const txBodyHash = tx.hash.toString();
    

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
  public async calculateMinUtxoAmount(
    output: any, // Define a proper type for output
    protocolParameters: any // Define a proper type for protocol parameters
  ): Promise<number> {
    // Implement the logic to calculate the minimum UTxO amount
    // This is a placeholder implementation
    return 1000000; // Return a dummy value
  }
  public async calculateTransactionFee(
    unsignedTxCbor: string,
    protocolParameters: any // Define a proper type for protocol parameters
  ): Promise<number> {
    // Implement the logic to calculate the transaction fee
    // This is a placeholder implementation
    return 200000; // Return a dummy value
  }

  private _mapLedgerParametersToBuildooorParams(
    protocolParameters: LedgerProtocolParameter
  ): any {
    // Map LedgerProtocolParameter to Buildooor's ProtocolParameters
    // This is a placeholder implementation
    return defaultProtocolParameters;
  }

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

