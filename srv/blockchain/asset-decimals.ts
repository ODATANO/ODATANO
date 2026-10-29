import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import {
  Assets, AssetHistory, Transactions, TransactionInputs, TransactionOutputs, TransactionOutputAssets, TransactionDatums,
} from '#cds-models/odatano/cardano';
import { cip68ReferenceUnit, cip68UserUnits, cip68DecimalsFromDatum } from '../cbor/cip68';
import type { Transaction as ProviderTransaction } from '../utils/types';

const { SELECT, UPDATE } = cds.ql;

/** Spending transactions a reference NFT is followed through before the trail is given up. */
const MAX_HOPS = 10_000;

async function storedDatum(tx: CapTransaction, dataHash: string): Promise<string | null> {
  const row = await tx.run(SELECT.one.from(TransactionDatums).columns('datum').where({ dataHash })) as { datum?: string | null } | undefined;
  return row?.datum ?? null;
}

/**
 * Datum on the output that holds a reference NFT now: from the NFT's latest mint, each output is
 * followed to the transaction that spent it until an unspent one is reached. A datum given by
 * hash is read from TransactionDatums. null when the crawled chain has no trail.
 */
async function currentReferenceDatum(tx: CapTransaction, referenceUnit: string, mintTxHash: string | null): Promise<string | null> {
  const mint = await tx.run(
    SELECT.one.from(AssetHistory).columns('txHash').where({ unit: referenceUnit, action: 'mint' }).orderBy('blockHeight desc')
  ) as { txHash?: string } | undefined;
  let txHash: string | null = mint?.txHash ?? mintTxHash;
  let datum: string | null = null;
  for (let hop = 0; txHash && hop < MAX_HOPS; hop++) {
    const head = await tx.run(SELECT.one.from(Transactions).columns('txSeq').where({ hash: txHash })) as { txSeq?: number | string } | undefined;
    if (head?.txSeq == null) break;
    const holder = await tx.run(
      SELECT.one.from(TransactionOutputAssets).columns('output_outputIndex').where({ output_txSeq: head.txSeq, unit: referenceUnit })
    ) as { output_outputIndex?: number } | undefined;
    if (holder?.output_outputIndex == null) break;
    const output = await tx.run(
      SELECT.one.from(TransactionOutputs).columns('utxo_inlineDatum', 'utxo_dataHash').where({ txSeq: head.txSeq, outputIndex: holder.output_outputIndex })
    ) as { utxo_inlineDatum?: string | null; utxo_dataHash?: string | null } | undefined;
    datum = output?.utxo_inlineDatum ?? (output?.utxo_dataHash ? await storedDatum(tx, output.utxo_dataHash) : null) ?? datum;
    const spender = await tx.run(
      SELECT.one.from(TransactionInputs).columns('txSeq').where({ spentTxHash: txHash, spentOutputIndex: holder.output_outputIndex })
    ) as { txSeq?: number | string } | undefined;
    if (spender?.txSeq == null) break;
    const next = await tx.run(SELECT.one.from(Transactions).columns('hash').where({ txSeq: spender.txSeq })) as { hash?: string } | undefined;
    txHash = next?.hash ?? null;
  }
  return datum;
}

/**
 * CIP-68 decimals of a user token (label 333 or 444) from the crawled chain. `mintTxHash` is the
 * token's own mint, tried when AssetHistory has no mint of the reference NFT. null for any other
 * unit or when the chain does not answer.
 */
export async function cip68Decimals(tx: CapTransaction, unit: string, mintTxHash: string | null = null): Promise<number | null> {
  const referenceUnit = cip68ReferenceUnit(unit);
  if (!referenceUnit) return null;
  const datum = await currentReferenceDatum(tx, referenceUnit, mintTxHash);
  return datum ? cip68DecimalsFromDatum(datum) : null;
}

/** Write `decimals` on every slice of the unit; returns the rows changed. */
export async function setAssetDecimals(tx: CapTransaction, unit: string, decimals: number): Promise<number> {
  const changed = await tx.run(UPDATE.entity(Assets).set({ decimals }).where({ unit }));
  return Number(changed) || 0;
}

/**
 * Apply the reference datums a block carries: for every output holding a reference NFT, the
 * decimals of its datum go to the catalogue rows of the matching user tokens. Returns the rows changed.
 */
export async function applyReferenceDatums(tx: CapTransaction, txs: ProviderTransaction[]): Promise<number> {
  let changed = 0;
  for (const t of txs) {
    const witness = new Map((t.datums ?? []).map((d) => [d.hash, d.cbor]));
    for (const o of t.outputs ?? []) {
      for (const a of o.amount ?? []) {
        const users = cip68UserUnits(a.unit);
        if (!users) continue;
        const datum = o.inlineDatum ?? (o.dataHash ? witness.get(o.dataHash) ?? await storedDatum(tx, o.dataHash) : null);
        const decimals = datum ? cip68DecimalsFromDatum(datum) : null;
        if (decimals == null) continue;
        for (const unit of users) changed += await setAssetDecimals(tx, unit, decimals);
      }
    }
  }
  return changed;
}
