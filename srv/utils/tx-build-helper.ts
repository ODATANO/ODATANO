import type { UTxO as OdatanoUtxo} from '../utils/types';
import {
  Address,
  UTxO as LedgerUTxO,
  Value,
  TxOutRef,
} from "@harmoniclabs/cardano-ledger-ts";

export function getLovelace(u: OdatanoUtxo): bigint {
  const entry = u.amount.find(a => (a.unit ?? "").toLowerCase() === "lovelace");
  return BigInt(entry?.quantity ?? "0");
}

export function assertAdaOnly(u: OdatanoUtxo): void {
  const nonAda = u.amount.filter(a => (a.unit ?? "").toLowerCase() !== "lovelace" && BigInt(a.quantity) !== 0n);
  if (nonAda.length > 0) {
    throw new Error(`UTxO ${u.txHash}#${u.outputIndex} contains non-ADA assets`);
  }
}

export function mapOdatanoUtxoToLedgerUtxo(u: OdatanoUtxo): any {
  assertAdaOnly(u);

  const txId = u.txHash; 

  const outRef = new TxOutRef({
    id: txId as any,
    index: u.outputIndex
  });

  const addr = Address.fromString(u.address)
  const value = Value.lovelaces(getLovelace(u));

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