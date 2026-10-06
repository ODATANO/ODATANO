import { Tx, Hash32, dataToCbor } from '@harmoniclabs/buildooor';
import type { TxOut, TxWitnessSet, UTxO, Value } from '@harmoniclabs/buildooor';
import type { Data } from '@harmoniclabs/plutus-data';
import { certTypeToString } from '@harmoniclabs/cardano-ledger-ts';
import type { Certificate } from '@harmoniclabs/cardano-ledger-ts';
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt } from '@harmoniclabs/cbor';
import type { CborObj } from '@harmoniclabs/cbor';
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
  /** Byte length of the output as it stands in the transaction. */
  cborSize: number;
}

export interface ParsedWithdrawal {
  /** Bech32 reward address. */
  rewardAddress: string;
  lovelace: string;
}

export interface ParsedCertificate {
  /** Position in the body's certificate list. */
  index: number;
  /** Ledger certificate name, e.g. `StakeDelegation` or `RegistrationDrep`. */
  type: string;
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
  /** Body field 15: 1 = mainnet, 0 = testnet, null if absent. */
  networkId: number | null;
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
  referenceInputs: ParsedInput[];
  withdrawals: ParsedWithdrawal[];
  certificates: ParsedCertificate[];
  /** Number of votes over all voters; 0 if the body has no voting procedures. */
  votingProcedures: number;
  proposalProcedures: number;
  /** Lovelace (decimal string) or `null` if absent. */
  treasuryDonation: string | null;
  /** Lovelace (decimal string) or `null` if absent. */
  currentTreasuryValue: string | null;
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
  let raw: BodyFields;
  try {
    // one decode for both readers; keepRef keeps the original bytes for the body hash and datums
    const parsed = Cbor.parse(Buffer.from(cborHex, 'hex'), { keepRef: true });
    tx = Tx.fromCborObj(parsed);
    raw = readBodyFields(parsed);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TransactionValidationError(
      `failed to parse transaction CBOR: ${msg}`,
      e,
      ERROR_CODES.TX_PARSE_FAILED
    );
  }

  const body = tx.body;

  return {
    txHash: body.hash.toString(),
    network: normalizeNetwork(body.network),
    networkId: raw.networkId,
    inputs: body.inputs.map(mapInput),
    outputs: body.outputs.map(mapOutput),
    validityStart: body.validityIntervalStart != null ? body.validityIntervalStart.toString() : null,
    validityEnd: body.ttl != null ? body.ttl.toString() : null,
    fee: body.fee.toString(),
    mint: mapMint(body.mint),
    metadataLabels: extractMetadataLabels(tx.auxiliaryData),
    collateral: (body.collateralInputs ?? []).map(mapInput),
    referenceInputs: (body.refInputs ?? []).map(mapInput),
    withdrawals: (body.withdrawals?.map ?? []).map((w) => ({
      rewardAddress: w.rewardAccount.toString(),
      lovelace: w.amount.toString(),
    })),
    certificates: (body.certs ?? []).map(mapCertificate),
    votingProcedures: raw.votingProcedures,
    proposalProcedures: raw.proposalProcedures,
    treasuryDonation: raw.treasuryDonation,
    currentTreasuryValue: raw.currentTreasuryValue,
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
      inlineDatumHex = Buffer.from(inlineDatumBytes(out) ?? dataToCbor(out.datum as Data)).toString('hex');
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
    // the bytes as received; a re-encoding can be shorter
    cborSize: out.cborRef ? out.cborRef.toBuffer().length : out.toCborBytes().length,
  };
}

function mapCertificate(cert: Certificate, index: number): ParsedCertificate {
  return { index, type: certTypeToString(cert.certType) };
}

type BodyFields = Pick<ParsedTransaction, 'networkId' | 'votingProcedures' | 'proposalProcedures' | 'treasuryDonation' | 'currentTreasuryValue'>;

/** Body fields 15 and 19 to 22 as they stand in the bytes. `Tx.fromCbor` drops 19 to 22 and maps any network byte other than 0 to mainnet. */
function readBodyFields(parsed: CborObj): BodyFields {
  const body = parsed instanceof CborArray ? parsed.array[0] : undefined;
  const field = (key: number): CborObj | undefined =>
    body instanceof CborMap ? body.map.find(e => e.k instanceof CborUInt && e.k.num === BigInt(key))?.v : undefined;
  const uint = (key: number): bigint | null => {
    const v = field(key);
    return v instanceof CborUInt ? v.num : null;
  };

  // voting_procedures = { voter => { gov_action_id => voting_procedure } }
  const voting = field(19);
  const votes = voting instanceof CborMap
    ? voting.map.reduce((n, e) => n + (e.v instanceof CborMap ? e.v.map.length : 0), 0)
    : 0;
  const networkId = uint(15);
  return {
    networkId: networkId == null ? null : Number(networkId),
    votingProcedures: votes,
    proposalProcedures: setItems(field(20)).length,
    treasuryDonation: uint(22)?.toString() ?? null,
    currentTreasuryValue: uint(21)?.toString() ?? null,
  };
}

/** Items of a CBOR set, with or without the Conway set tag 258. */
function setItems(obj: CborObj | undefined): CborObj[] {
  const inner = obj instanceof CborTag ? obj.data : obj;
  return inner instanceof CborArray ? inner.array : [];
}

/** Inline datum bytes as they stand in the transaction; decoding and re-encoding may change them. */
function inlineDatumBytes(out: TxOut): Uint8Array | undefined {
  if (!out.cborRef) return undefined;
  const parsed = Cbor.parse(out.toCborBytes());
  if (!(parsed instanceof CborMap)) return undefined;
  const option = parsed.map.find(e => e.k instanceof CborUInt && e.k.num === 2n)?.v;
  const tagged = option instanceof CborArray ? option.array[1] : undefined;
  return tagged instanceof CborTag && tagged.data instanceof CborBytes ? tagged.data.bytes : undefined;
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
