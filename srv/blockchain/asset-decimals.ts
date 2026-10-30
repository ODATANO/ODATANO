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

// The transaction that consumed an output. Collateral consumes only in a phase-2 failure,
// which is stored with collateral and reference inputs alone.
async function consumingTx(tx: CapTransaction, spentTxHash: string, spentOutputIndex: number): Promise<{ txSeq?: number | string } | undefined> {
  const inputs = await tx.run(
    SELECT.from(TransactionInputs).columns('txSeq', 'isCollateral').where({ spentTxHash, spentOutputIndex, isReference: false })
  ) as Array<{ txSeq?: number | string; isCollateral?: boolean | null }>;
  const regular = (inputs ?? []).find(i => !i.isCollateral);
  if (regular) return regular;
  for (const candidate of inputs ?? []) {
    const spendsRegular = await tx.run(
      SELECT.one.from(TransactionInputs).columns('txSeq').where({ txSeq: candidate.txSeq, isCollateral: false, isReference: false })
    );
    if (!spendsRegular) return candidate;
  }
  return undefined;
}

// Datum of the output holding a reference NFT now, followed from its latest mint through each spend.
// Hashed datums come from TransactionDatums. Null when the crawled chain has no trail.
async function currentReferenceDatum(tx: CapTransaction, referenceUnit: string, mintTxHash: string | null): Promise<string | null> {
  const mint = await tx.run(
    SELECT.one.from(AssetHistory).columns('txHash').where({ unit: referenceUnit, action: 'mint' }).orderBy('blockHeight desc', 'blockTime desc', 'txHash desc')
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
    const spender = await consumingTx(tx, txHash, holder.output_outputIndex);
    if (spender?.txSeq == null) break;
    const next = await tx.run(SELECT.one.from(Transactions).columns('hash').where({ txSeq: spender.txSeq })) as { hash?: string } | undefined;
    txHash = next?.hash ?? null;
  }
  return datum;
}

// CIP-68 decimals of a label 333 or 444 token. `mintTxHash` is the token's own mint, tried when
// AssetHistory has no mint of the reference NFT. Null for other units or without data.
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

// Copy decimals from each reference-NFT datum in a block to the matching user tokens. Returns rows changed.
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
