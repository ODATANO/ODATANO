import { Tx, Hash32, dataToCbor } from '@harmoniclabs/buildooor';
import type { TxOut, TxWitnessSet, UTxO, Value } from '@harmoniclabs/buildooor';
import { TransactionValidationError } from '../utils/errors';
import { ERROR_CODES } from '../utils/error-codes';

export interface ParsedInput {
  txHash: string;
  outputIndex: number;
}

export interface ParsedAsset {
  /** `"policyIdHex" + "assetNameHex"` (concatenated, no separator). */
  unit: string;
  /** Signed decimal string — negative for burns in `mint`, always non-negative in outputs. */
  quantity: string;
}

export interface ParsedOutput {
  address: string;
  lovelace: string;
  assets: ParsedAsset[];
  datumHash: string | null;
  inlineDatumHex: string | null;
  referenceScriptHex: string | null;
}

export interface ParsedWitnesses {
  vkeyCount: number;
  nativeScripts: number;
  plutusScripts: number;
  plutusData: number;
  redeemers: number;
}

export interface ParsedTransaction {
  /**
   * Blake2b-256 hash of the transaction body. Stable across signed/unsigned
   * CBOR — signing adds witnesses without changing the body hash.
   */
  txHash: string;
  /**
   * `"mainnet"` or `"testnet"` when the body carries a network ID byte, else
   * `null`. Preview vs preprod cannot be distinguished from CBOR alone; a
   * consumer needing that split must compare against the service network.
   */
  network: 'mainnet' | 'testnet' | null;
  inputs: ParsedInput[];
  outputs: ParsedOutput[];
  /** Validity-interval start slot (decimal string) or `null` if absent. */
  validityStart: string | null;
  /** TTL slot (decimal string) or `null` if absent. */
  validityEnd: string | null;
  /** Fee in lovelace (decimal string). */
  fee: string;
  /** Native-asset mint/burn entries; quantities are signed. */
  mint: ParsedAsset[];
  /** Metadata labels present (uint64 → decimal string); full payload via GetMetadataByTxHash for submitted txs. */
  metadataLabels: string[];
  collateral: ParsedInput[];
  /** 28-byte Ed25519 key hashes listed in the tx body's required_signers field. */
  requiredSigners: string[];
  scriptDataHash: string | null;
  witnesses: ParsedWitnesses;
}

/**
 * Parse hex-encoded Cardano transaction CBOR (signed or unsigned) into structured
 * fields. Pure function — no network call, no DB write. Callers are responsible
 * for upstream size/format validation via `isValidTxCborHex`.
 *
 * @throws TransactionValidationError with code `TX_PARSE_FAILED` on malformed CBOR.
 */
export function parseTransaction(cborHex: string): ParsedTransaction {
  let tx: Tx;
  try {
    tx = Tx.fromCbor(Buffer.from(cborHex, 'hex'));
  } catch (e: any) {
    throw new TransactionValidationError(
      `failed to parse transaction CBOR: ${e?.message ?? 'unknown error'}`,
      e,
      ERROR_CODES.TX_PARSE_FAILED
    );
  }

  const body = tx.body;

  return {
    txHash: body.hash.toString(),
    network: normalizeNetwork(body.network),
    inputs: body.inputs.map(mapInput),
    outputs: body.outputs.map(mapOutput),
    validityStart: body.validityIntervalStart != null ? body.validityIntervalStart.toString() : null,
    validityEnd: body.ttl != null ? body.ttl.toString() : null,
    fee: body.fee.toString(),
    mint: mapMint(body.mint),
    metadataLabels: extractMetadataLabels(tx.auxiliaryData),
    collateral: (body.collateralInputs ?? []).map(mapInput),
    requiredSigners: (body.requiredSigners ?? []).map((s) => s.toString()),
    scriptDataHash: body.scriptDataHash ? body.scriptDataHash.toString() : null,
    witnesses: countWitnesses(tx.witnesses),
  };
}

function normalizeNetwork(n: unknown): 'mainnet' | 'testnet' | null {
  return n === 'mainnet' || n === 'testnet' ? n : null;
}

function mapInput(utxo: UTxO): ParsedInput {
  return {
    txHash: utxo.utxoRef.id.toString(),
    outputIndex: utxo.utxoRef.index,
  };
}

function mapOutput(out: TxOut): ParsedOutput {
  const units = out.value.toUnits();
  let lovelace = '0';
  const assets: ParsedAsset[] = [];
  for (const u of units) {
    if (u.unit === 'lovelace' || u.unit === '') {
      lovelace = u.quantity.toString();
    } else {
      assets.push({ unit: u.unit, quantity: u.quantity.toString() });
    }
  }

  let datumHash: string | null = null;
  let inlineDatumHex: string | null = null;
  if (out.datum != null) {
    if (out.datum instanceof Hash32) {
      datumHash = out.datum.toString();
    } else {
      // anything not a Hash32 is an inline `Data` (PlutusData) payload
      inlineDatumHex = Buffer.from(dataToCbor(out.datum as any)).toString('hex');
    }
  }

  const referenceScriptHex = out.refScript
    ? Buffer.from(out.refScript.toCborBytes()).toString('hex')
    : null;

  return {
    address: out.address.toString(),
    lovelace,
    assets,
    datumHash,
    inlineDatumHex,
    referenceScriptHex,
  };
}

function mapMint(mint: Value | undefined): ParsedAsset[] {
  if (!mint) return [];
  return mint
    .toUnits()
    .filter((u) => u.unit !== 'lovelace' && u.unit !== '')
    .map((u) => ({ unit: u.unit, quantity: u.quantity.toString() }));
}

function extractMetadataLabels(aux: Tx['auxiliaryData']): string[] {
  const inner = aux?.metadata?.metadata;
  return inner ? Object.keys(inner) : [];
}

function countWitnesses(ws: TxWitnessSet): ParsedWitnesses {
  return {
    vkeyCount: (ws.vkeyWitnesses ?? []).length,
    nativeScripts: (ws.nativeScripts ?? []).length,
    plutusScripts:
      (ws.plutusV1Scripts ?? []).length +
      (ws.plutusV2Scripts ?? []).length +
      (ws.plutusV3Scripts ?? []).length,
    plutusData: (ws.datums ?? []).length,
    redeemers: (ws.redeemers ?? []).length,
  };
}
