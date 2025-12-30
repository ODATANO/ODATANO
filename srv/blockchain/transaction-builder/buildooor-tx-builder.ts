// srv/tx/engines/buildooor.tx-builder.ts
import type { CardanoTxBuilder, TxBuildRequest, TxBuildContext, TxBuildResult } from "./cardano-tx-builder";
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

    const outputs = req.recipients.map(r =>
      new TxOut({
        address: Address.fromString(r.address)
          ? (Address as any).fromString(r.address)
          : (Address as any).fromBech32(r.address),
        value: Value.lovelaces(BigInt(r.lovelace))
      })
    );

    const changeAddress =
      Address.fromString(req.changeAddress ?? req.senderAddress)
        ? (Address as any).fromString(req.changeAddress ?? req.senderAddress)
        : (Address as any).fromBech32(req.changeAddress ?? req.senderAddress);

    const tx = await txb.build({
      inputs,
      outputs,
      changeAddress,
      invalidBefore: req.validity?.invalidBefore,
      invalidAfter: req.validity?.invalidHereafter,
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
}

