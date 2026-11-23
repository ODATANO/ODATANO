import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { parseJson } from '../utils/deep-json';
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
  TransactionDatums,
} from '#cds-models/odatano/cardano';
import type {
  Amount,
  BlockData,
  MetadataLabelTx,
  ReferenceScriptType,
  Transaction as ProviderTransaction,
  TxCertificate,
  TxDatum,
  TxInputLine,
  TxOutputLine,
  TxRedeemer,
  TxWithdrawal,
} from '../utils/types';
import { chunk, IN_CHUNK } from '../utils/collections';
import { ProviderUnavailableError } from '../utils/errors';

const { SELECT } = cds.ql;

// Stored blocks and transactions in provider shape, served to other instances. A valid transaction
// always spends a regular input, which gives the phase-2 flag. `totalCollateral` and `outputAmount` are absent.

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
    previousHash: row.previousHash == null ? null : String(row.previousHash),
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

// The one row of `candidates` that follows `parent`: its stored parent hash names it, or it is the
// only row at that height and its parent is unknown. Of two rows that both may follow, the one a
// stored block at the next height names wins. Null when no row follows or it stays ambiguous.
function successor(candidates: Row[], parent: string | null, next: Row[]): Row | null {
  const fits = candidates.filter((r) => r.previousHash == null || parent == null || r.previousHash === parent);
  if (fits.length <= 1) return fits[0] ?? null;
  const named = fits.filter((r) => r.previousHash === parent && parent != null);
  if (named.length === 1) return named[0];
  const continued = fits.filter((r) => next.some((n) => n.previousHash === r.hash));
  return continued.length === 1 ? continued[0] : null;
}

// Up to `count` stored blocks after `afterHeight`, following the stored parent hashes from `afterHash`.
// Stops at a gap, at a block that names another parent, and where two rows at one height stay
// ambiguous; nothing is served past a point the store cannot decide. `previousHash` is the stored one.
export async function readNextBlocks(db: CapTransaction, afterHeight: number, count: number, afterHash: string | null = null): Promise<BlockData[]> {
  const rows = await db.run(
    // one operator per column object: `{ '>': a, '<=': b }` renders as `height > a <= b`
    SELECT.from(Blocks).where({ height: { between: afterHeight + 1, and: afterHeight + count + 1 } }).orderBy('height asc')
  ) as Row[] ?? [];
  const byHeight = new Map<number, Row[]>();
  for (const row of rows) byHeight.set(num(row.height), [...(byHeight.get(num(row.height)) ?? []), row]);
  const out: BlockData[] = [];
  let parent = afterHash;
  for (let height = afterHeight + 1; height <= afterHeight + count; height++) {
    const row = successor(byHeight.get(height) ?? [], parent, byHeight.get(height + 1) ?? []);
    if (!row) {
      if (out.length === 0 && (byHeight.get(height)?.length ?? 0) > 1) {
        throw new ProviderUnavailableError(`two stored blocks at height ${height} may follow ${parent ?? 'the cursor'}; the stored chain cannot tell which one`, 'odatano');
      }
      break;
    }
    out.push(blockRowToData(row));
    parent = str(row.hash);
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

// Stored transactions of a block in order. Null unless all are stored, since a lazily indexed
// block may hold only some.
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
    json: r.payload == null ? undefined : parseJson(String(r.payload)),
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
  const [inputs, inputAssets, outputs, outputAssets, metadata, certificates, withdrawals, redeemers, datums] = await Promise.all([
    fetchIn(TransactionInputs, 'txSeq', seqs),
    fetchIn(TransactionInputAssets, 'input_txSeq', seqs),
    fetchIn(TransactionOutputs, 'txSeq', seqs),
    fetchIn(TransactionOutputAssets, 'output_txSeq', seqs),
    fetchIn(TransactionMetadata, 'tx_hash', hashes),
    fetchIn(TransactionCertificates, 'tx_hash', hashes),
    fetchIn(TransactionWithdrawals, 'tx_hash', hashes),
    fetchIn(TransactionRedeemers, 'tx_hash', hashes),
    fetchIn(TransactionDatums, 'tx_hash', hashes),
  ]);

  const inputsBySeq = groupBy(inputs, r => str(r.txSeq));
  const inputAssetsByKey = groupBy(inputAssets, r => `${r.input_txSeq}#${r.input_inputIndex}`);
  const outputsBySeq = groupBy(outputs, r => str(r.txSeq));
  const outputAssetsByKey = groupBy(outputAssets, r => `${r.output_txSeq}#${r.output_outputIndex}`);
  const metadataByHash = groupBy(metadata, r => str(r.tx_hash));
  const certsByHash = groupBy(certificates, r => str(r.tx_hash));
  const withdrawalsByHash = groupBy(withdrawals, r => str(r.tx_hash));
  const redeemersByHash = groupBy(redeemers, r => str(r.tx_hash));
  const datumsByHash = groupBy(datums, r => str(r.tx_hash));

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
        referenceScriptSize: numOrNull(i.utxoData_referenceScriptSize),
        referenceScriptType: (i.utxoData_referenceScriptType as ReferenceScriptType | null) ?? null,
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
        referenceScriptSize: numOrNull(o.utxo_referenceScriptSize),
        referenceScriptType: (o.utxo_referenceScriptType as ReferenceScriptType | null) ?? null,
      }));
    const certs = certsByHash.get(hash);
    const withdrawn = withdrawalsByHash.get(hash);
    const redeemed = redeemersByHash.get(hash);
    const witnessDatums = datumsByHash.get(hash);
    return {
      hash,
      blockHash: str(t.blockHash),
      blockHeight: num(t.blockHeight),
      slot: num(t.slot),
      index: num(t.txIndex),
      fee: str(t.fee ?? '0'),
      deposit: t.deposit == null ? null : str(t.deposit),
      size: numOrNull(t.size),
      blockTime: num(t.blockTime),
      spendsCollaterals,
      // AssetHistory may hold only some mint rows of a transaction, read on demand for single units.
      // Without a complete mint the reader derives it from inputs and outputs.
      mint: undefined,
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
      datums: witnessDatums?.map((d): TxDatum => ({ hash: str(d.dataHash), cbor: str(d.datum) })),
    };
  });
}
