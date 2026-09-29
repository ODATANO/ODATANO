import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { safeJSON } from '@cardano-ogmios/client';
import {
  Blocks,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata_ as TransactionMetadata,
  TransactionCertificates,
  TransactionWithdrawals,
  TransactionRedeemers,
  AssetHistory_ as AssetHistory,
} from '#cds-models/odatano/cardano';
import type {
  Amount,
  BlockData,
  MetadataLabelTx,
  Transaction as ProviderTransaction,
  TxCertificate,
  TxInputLine,
  TxOutputLine,
  TxRedeemer,
  TxWithdrawal,
} from '../utils/types';
import { chunk, IN_CHUNK } from '../utils/collections';

const { SELECT } = cds.ql;

/**
 * Stored blocks and transactions back in the provider shape (`BlockData`, `Transaction`), for
 * serving other ODATANO instances from what this one has indexed. The rows hold the ledger view
 * (see ledgerView), so the phase-2 flag follows from them: a valid transaction always spends a
 * regular input. Not stored, so absent: `totalCollateral` and `outputAmount`.
 */

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

/** `Blocks` row -> BlockData. */
export function blockRowToData(row: Row): BlockData {
  return {
    time: Math.floor(Date.parse(str(row.time)) / 1000),
    height: numOrNull(row.height),
    hash: str(row.hash),
    slot: numOrNull(row.slot),
    slotLeader: str(row.slotLeader),
    epoch: numOrNull(row.epochNumber),
    epochSlot: numOrNull(row.epochSlot),
    size: num(row.size),
    txCount: num(row.txCount),
    fees: row.fees == null ? null : String(row.fees),
  };
}

/** A stored block by hash; null when not indexed. */
export async function readBlock(db: CapTransaction, hash: string): Promise<BlockData | null> {
  const row = await db.run(SELECT.one.from(Blocks).where({ hash })) as Row | undefined;
  return row ? blockRowToData(row) : null;
}

/** A stored block by height; null when not indexed. */
export async function readBlockByHeight(db: CapTransaction, height: number): Promise<BlockData | null> {
  const row = await db.run(SELECT.one.from(Blocks).where({ height })) as Row | undefined;
  return row ? blockRowToData(row) : null;
}

/**
 * Up to `count` stored blocks following height `afterHeight`, contiguous only: the run stops at
 * the first missing height, so a caller never walks over a gap.
 */
export async function readNextBlocks(db: CapTransaction, afterHeight: number, count: number): Promise<BlockData[]> {
  const rows = await db.run(
    // one operator per column object: `{ '>': a, '<=': b }` renders as `height > a <= b`
    SELECT.from(Blocks).where({ height: { between: afterHeight + 1, and: afterHeight + count } }).orderBy('height asc')
  ) as Row[];
  const out: BlockData[] = [];
  let expected = afterHeight + 1;
  for (const row of rows ?? []) {
    if (num(row.height) !== expected) break;
    out.push(blockRowToData(row));
    expected++;
  }
  return out;
}

/** True when a stored input lacks its outpoint (row indexed before outpoints were recorded). */
export function lacksOutpoints(t: ProviderTransaction): boolean {
  return (t.inputs ?? []).some(i => i.txHash == null);
}

/** Stored transactions by hash (missing hashes are absent from the map). */
export async function readTransactionsByHash(db: CapTransaction, hashes: string[]): Promise<Map<string, ProviderTransaction>> {
  const rows: Row[] = [];
  for (const hashChunk of chunk(hashes, IN_CHUNK)) {
    rows.push(...((await db.run(SELECT.from(Transactions).where({ hash: { in: hashChunk } }))) as Row[] ?? []));
  }
  const txs = await assembleTransactions(db, rows);
  return new Map(txs.map(t => [t.hash, t]));
}

/**
 * Stored transactions of a block in block order; null when the block is not stored with all of its
 * transactions (a lazily indexed block may hold only the ones somebody asked for).
 */
export async function readBlockTransactions(db: CapTransaction, blockHash: string): Promise<ProviderTransaction[] | null> {
  const block = await db.run(SELECT.one.from(Blocks).columns('txCount').where({ hash: blockHash })) as Row | undefined;
  if (!block) return null;
  const rows = await db.run(SELECT.from(Transactions).where({ blockHash }).orderBy('txIndex asc')) as Row[];
  if ((rows ?? []).length !== num(block.txCount)) return null;
  return assembleTransactions(db, rows ?? []);
}

/** Metadata of a stored transaction; null when the transaction is not stored. */
export async function readTransactionMetadata(db: CapTransaction, txHash: string): Promise<MetadataLabelTx[] | null> {
  const known = await db.run(SELECT.one.from(Transactions).columns('hash').where({ hash: txHash }));
  if (!known) return null;
  const rows = await db.run(SELECT.from(TransactionMetadata).where({ tx_hash: txHash })) as Row[];
  return (rows ?? []).map(metadataRow);
}

function metadataRow(r: Row): MetadataLabelTx {
  return {
    txHash: str(r.tx_hash),
    label: str(r.label),
    json: r.payload == null ? undefined : safeJSON.parse(String(r.payload)),
  };
}

/** Amount list with lovelace first, as the providers deliver it. */
function amounts(assets: Row[]): Amount[] {
  const list = assets.map(a => ({ unit: str(a.unit), quantity: str(a.asset_quantity) }));
  return [...list.filter(a => a.unit === 'lovelace'), ...list.filter(a => a.unit !== 'lovelace')];
}

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

/** Transactions rows + their child tables -> provider transactions, in the order of `rows`. */
async function assembleTransactions(db: CapTransaction, rows: Row[]): Promise<ProviderTransaction[]> {
  if (rows.length === 0) return [];
  const seqs = rows.map(r => r.txSeq);
  const hashes = rows.map(r => str(r.hash));
  const fetchIn = async (entity: unknown, column: string, keys: unknown[]): Promise<Row[]> => {
    const out: Row[] = [];
    for (const c of chunk(keys, IN_CHUNK)) {
      out.push(...((await db.run(SELECT.from(entity as never).where({ [column]: { in: c } }))) as Row[] ?? []));
    }
    return out;
  };
  const [inputs, inputAssets, outputs, outputAssets, metadata, certificates, withdrawals, mints, redeemers] = await Promise.all([
    fetchIn(TransactionInputs, 'txSeq', seqs),
    fetchIn(TransactionInputAssets, 'input_txSeq', seqs),
    fetchIn(TransactionOutputs, 'txSeq', seqs),
    fetchIn(TransactionOutputAssets, 'output_txSeq', seqs),
    fetchIn(TransactionMetadata, 'tx_hash', hashes),
    fetchIn(TransactionCertificates, 'tx_hash', hashes),
    fetchIn(TransactionWithdrawals, 'tx_hash', hashes),
    fetchIn(AssetHistory, 'txHash', hashes),
    fetchIn(TransactionRedeemers, 'tx_hash', hashes),
  ]);

  const inputsBySeq = groupBy(inputs, r => str(r.txSeq));
  const inputAssetsByKey = groupBy(inputAssets, r => `${r.input_txSeq}#${r.input_inputIndex}`);
  const outputsBySeq = groupBy(outputs, r => str(r.txSeq));
  const outputAssetsByKey = groupBy(outputAssets, r => `${r.output_txSeq}#${r.output_outputIndex}`);
  const metadataByHash = groupBy(metadata, r => str(r.tx_hash));
  const certsByHash = groupBy(certificates, r => str(r.tx_hash));
  const withdrawalsByHash = groupBy(withdrawals, r => str(r.tx_hash));
  const mintsByHash = groupBy(mints, r => str(r.txHash));
  const redeemersByHash = groupBy(redeemers, r => str(r.tx_hash));

  return rows.map((t) => {
    const seq = str(t.txSeq);
    const hash = str(t.hash);
    const txInputs: TxInputLine[] = (inputsBySeq.get(seq) ?? [])
      .sort((a, b) => num(a.inputIndex) - num(b.inputIndex))
      .map(i => ({
        address: str(i.address_address),
        amount: amounts(inputAssetsByKey.get(`${seq}#${i.inputIndex}`) ?? []),
        // null on rows indexed before the outpoint was recorded, never a made-up reference
        txHash: (i.spentTxHash ?? null) as string,
        outputIndex: numOrNull(i.spentOutputIndex) as number,
        dataHash: (i.utxoData_dataHash as string | null) ?? null,
        inlineDatum: (i.utxoData_inlineDatum as string | null) ?? null,
        referenceScriptHash: (i.utxoData_referenceScriptHash as string | null) ?? null,
        isCollateral: Boolean(i.isCollateral),
        isReference: Boolean(i.isReference),
      }));
    // a phase-2 failure keeps only collateral and reference inputs, and its collateral return
    const spendsCollaterals = txInputs.some(i => i.isCollateral) && !txInputs.some(i => !i.isCollateral && !i.isReference);
    const txOutputs: TxOutputLine[] = (outputsBySeq.get(seq) ?? [])
      .sort((a, b) => num(a.outputIndex) - num(b.outputIndex))
      .map(o => ({
        address: str(o.address_address),
        amount: amounts(outputAssetsByKey.get(`${seq}#${o.outputIndex}`) ?? []),
        txHash: hash,
        outputIndex: num(o.outputIndex),
        dataHash: (o.utxo_dataHash as string | null) ?? null,
        inlineDatum: (o.utxo_inlineDatum as string | null) ?? null,
        isCollateral: spendsCollaterals,
        referenceScriptHash: (o.utxo_referenceScriptHash as string | null) ?? null,
      }));
    const certs = certsByHash.get(hash);
    const withdrawn = withdrawalsByHash.get(hash);
    const minted = mintsByHash.get(hash);
    const redeemed = redeemersByHash.get(hash);
    return {
      hash,
      blockHash: str(t.blockHash),
      blockHeight: num(t.blockHeight),
      slot: num(t.slot),
      index: num(t.txIndex),
      fee: str(t.fee ?? '0'),
      deposit: str(t.deposit ?? '0'),
      size: numOrNull(t.size),
      blockTime: num(t.blockTime),
      spendsCollaterals,
      mint: minted?.map(m => ({
        unit: str(m.unit),
        quantity: (m.action === 'burn' ? '-' : '') + str(m.quantity),
      })),
      inputs: txInputs,
      outputs: txOutputs,
      metadata: (metadataByHash.get(hash) ?? []).map(metadataRow),
      certificates: certs?.map((c): TxCertificate => ({
        certIndex: num(c.certIndex),
        kind: str(c.kind),
        stakeAddress: (c.stakeAddress as string | null) ?? null,
        poolId: (c.poolId as string | null) ?? null,
        drepId: (c.drepId as string | null) ?? null,
        deposit: c.deposit == null ? null : String(c.deposit),
        epoch: numOrNull(c.epoch),
      })),
      withdrawals: withdrawn?.map((w): TxWithdrawal => ({ stakeAddress: str(w.stakeAddress), amount: str(w.lovelace) })),
      redeemers: redeemed
        ?.sort((a, b) => str(a.purpose).localeCompare(str(b.purpose)) || num(a.redeemerIndex) - num(b.redeemerIndex))
        .map((r): TxRedeemer => ({
          purpose: str(r.purpose),
          index: num(r.redeemerIndex),
          data: str(r.data),
          mem: str(r.mem),
          steps: str(r.steps),
          txHash: (r.spentTxHash as string | null) ?? null,
          outputIndex: numOrNull(r.spentOutputIndex),
          policyId: (r.policyId as string | null) ?? null,
        })),
    };
  });
}
