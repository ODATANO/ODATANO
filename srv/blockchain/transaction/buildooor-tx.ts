// srv/tx/engines/buildooor.tx-builder.ts
import type { CardanoTxBuilder} from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult } from "../../utils/types";
import { TxBuilder } from "@harmoniclabs/buildooor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { getLovelace, mapOdatanoUtxoToLedgerUtxo } from "../../utils/tx-build-helper";

import {
  defaultProtocolParameters,
  Address,
  UTxO as LedgerUTxO,
  Value,
  TxOut
} from "@harmoniclabs/cardano-ledger-ts";

export class BuildooorTxBuilder implements CardanoTxBuilder {
  public readonly name = "buildooor";
  public async init(): Promise<void> {}

  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    const protocolParameters = {
      ...defaultProtocolParameters,
      ...(ctx.protocolParameters as any)
    };

    const txb = new TxBuilder(protocolParameters);

    // Map ODATANO UTxOs -> ledger-ts UTxO objects
    const ledgerUtxos: LedgerUTxO[] = ctx.utxos.map(mapOdatanoUtxoToLedgerUtxo);

    // Buildooor ITxBuildInput shape: { utxo: UTxO }
    const inputs = ledgerUtxos.map(utxo => ({ utxo }));

    const outputs = [
      new TxOut(
        Address.fromString(req.recipientAddress)
          ? (Address as any).fromString(req.recipientAddress)
          : (Address as any).fromBech32(req.recipientAddress)) 
    ];;
    

    const changeAddress =
      Address.fromString(req.changeAddress ?? req.senderAddress)
        ? (Address as any).fromString(req.changeAddress ?? req.senderAddress)
        : (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);

    const tx = await txb.build({
      inputs,
      outputs,
      changeAddress,
      memo: 'test tx',
    });

    return {
      unsignedTxCbor: toHex(tx.toCbor().toBuffer()),
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
}

