import type { UTxO as OdatanoUtxo} from '../utils/types';

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