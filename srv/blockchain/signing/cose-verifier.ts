import cds from '@sap/cds';
import { Cbor, CborObj, CborArray, CborMap, CborTag, CborBytes, CborUInt, CborNegInt, CborText, CborSimple } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_224, verifyEd25519Signature_sync } from '@harmoniclabs/crypto';
import { bech32 } from 'bech32';
import { TextDecoder } from 'node:util';
import { BECH32_MAX_LENGTH } from '../../utils/const';

const logger = cds.log('CoseVerifier');

/** CBOR tag 18 = COSE_Sign1 (RFC 8152). signData may or may not wrap in it. */
const COSE_SIGN1_TAG = 18;
// The one algorithm CIP-30 signData allows: EdDSA with an Ed25519 key.
const ALG_EDDSA = -8;
const KTY_OKP = 1;
const CRV_ED25519 = 6;
const ED25519_PUBKEY_LEN = 32;
const ED25519_SIGNATURE_LEN = 64;
const BLAKE2B_224_LEN = 28;

// Mirrors the CIP-30 `signData` result. `coseSignature` is its hex `signature` field,
// `coseKey` its hex `key` field.
export interface CoseVerifyInput {
  address: string;
  coseSignature: string;
  coseKey: string;
  expectedPayload?: string;
}

/** Result of a COSE_Sign1 verification. Shape mirrors the CDS action return. */
export interface CoseVerifyResult {
  valid: boolean;
  /** failure detail when !valid; empty string when valid */
  reason: string;
  /** The signed message as text. Empty when the payload is not UTF-8, or hashed and not matched. */
  signedPayload: string;
  /** hex; the payload bytes as signed (the blake2b-224 of the message when the wallet hashed it) */
  signedPayloadHex: string;
  /** hex blake2b-224 of the signer public key (empty until the key is parsed) */
  signerVkh: string;
}

type Label = number | string;

/** Entries of a COSE map by label. Throws on a repeated label, which COSE forbids. */
function readLabels(obj: CborObj | undefined, what: string): Map<Label, CborObj> {
  if (!(obj instanceof CborMap)) throw new Error(`${what} must be a CBOR map`);
  const labels = new Map<Label, CborObj>();
  for (const { k, v } of obj.map) {
    const label = k instanceof CborUInt || k instanceof CborNegInt ? Number(k.num) : k instanceof CborText ? k.text : undefined;
    if (label === undefined) throw new Error(`${what} has a label that is neither an integer nor a text`);
    if (labels.has(label)) throw new Error(`${what} repeats the label ${label}`);
    labels.set(label, v);
  }
  return labels;
}

function intValue(obj: CborObj | undefined): number | undefined {
  return obj instanceof CborUInt || obj instanceof CborNegInt ? Number(obj.num) : undefined;
}

function optionalBytes(obj: CborObj | undefined, what: string): Uint8Array | undefined {
  if (obj === undefined) return undefined;
  if (!(obj instanceof CborBytes)) throw new Error(`${what} must be a byte string`);
  return obj.bytes;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

// `protectedBytes` keeps the received bytes, since the Sig_structure must reuse them unchanged.
// The header map is never re-encoded.
interface CoseSign1 {
  protectedBytes: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
  /** Raw bytes of the address the wallet signed for. */
  address: Uint8Array;
  kid?: Uint8Array;
  /** The payload is the blake2b-224 of the message (hardware wallets, CIP-8). */
  hashed: boolean;
}

function parseCoseSign1(hex: string): CoseSign1 {
  let obj = Cbor.parse(fromHex(hex));
  // CIP-30 signData may emit the COSE_Sign1 wrapped in tag 18 or bare.
  if (obj instanceof CborTag && Number(obj.tag) === COSE_SIGN1_TAG) obj = obj.data;
  if (!(obj instanceof CborArray) || obj.array.length !== 4) {
    throw new Error('COSE_Sign1 must be a 4-element array [protected, unprotected, payload, signature]');
  }
  const [prot, unprot, payload, signature] = obj.array;
  if (!(prot instanceof CborBytes)) throw new Error('COSE_Sign1 protected header must be a byte string');
  if (!(payload instanceof CborBytes)) throw new Error('COSE_Sign1 payload must be a byte string (detached payloads are not supported)');
  if (!(signature instanceof CborBytes) || signature.bytes.length !== ED25519_SIGNATURE_LEN) {
    throw new Error(`COSE_Sign1 signature must be a byte string of ${ED25519_SIGNATURE_LEN} bytes`);
  }
  if (prot.bytes.length === 0) throw new Error('COSE_Sign1 protected header is empty; alg and address are required');

  const signed = readLabels(Cbor.parse(prot.bytes), 'COSE_Sign1 protected header');
  const unsigned = readLabels(unprot, 'COSE_Sign1 unprotected header');
  for (const label of unsigned.keys()) {
    if (signed.has(label)) throw new Error(`COSE_Sign1 carries the header ${label} twice`);
  }
  if (intValue(signed.get(1)) !== ALG_EDDSA) throw new Error('COSE_Sign1 protected header alg (1) must be EdDSA (-8)');
  const address = optionalBytes(signed.get('address'), 'COSE_Sign1 address header');
  if (!address) throw new Error('COSE_Sign1 protected header carries no address');

  const hashed = unsigned.get('hashed') ?? signed.get('hashed');
  if (hashed !== undefined && !(hashed instanceof CborSimple && typeof hashed.simple === 'boolean')) {
    throw new Error('COSE_Sign1 header hashed must be a boolean');
  }
  return {
    protectedBytes: prot.bytes,
    payload: payload.bytes,
    signature: signature.bytes,
    address,
    kid: optionalBytes(signed.get(4), 'COSE_Sign1 kid (4)'),
    hashed: hashed instanceof CborSimple && hashed.simple === true,
  };
}

/** The Ed25519 public key of a COSE_Key, after its key type, algorithm and curve are checked. */
function parseCoseKey(hex: string): { publicKey: Uint8Array; kid?: Uint8Array } {
  const key = readLabels(Cbor.parse(fromHex(hex)), 'COSE_Key');
  if (intValue(key.get(1)) !== KTY_OKP) throw new Error('COSE_Key kty (1) must be OKP (1)');
  if (intValue(key.get(3)) !== ALG_EDDSA) throw new Error('COSE_Key alg (3) must be EdDSA (-8)');
  if (intValue(key.get(-1)) !== CRV_ED25519) throw new Error('COSE_Key crv (-1) must be Ed25519 (6)');
  const x = key.get(-2);
  if (!(x instanceof CborBytes)) throw new Error('COSE_Key is missing the Ed25519 public key (label -2)');
  if (x.bytes.length !== ED25519_PUBKEY_LEN) {
    throw new Error(`COSE_Key public key must be ${ED25519_PUBKEY_LEN} bytes, got ${x.bytes.length}`);
  }
  return { publicKey: x.bytes, kid: optionalBytes(key.get(2), 'COSE_Key kid (2)') };
}

// The signed COSE Sig_structure: ["Signature1", protected, external_aad, payload].
// external_aad is empty for CIP-8 and CIP-30 signData.
function buildSigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const sigStruct = new CborArray([
    new CborText('Signature1'),
    new CborBytes(protectedBytes),
    new CborBytes(new Uint8Array(0)),
    new CborBytes(payload),
  ]);
  return Cbor.encode(sigStruct);
}

// The credential whose key signs for an address (CIP-30): the payment credential of a base, pointer
// or enterprise address, the stake credential of a reward address. Null for anything else.
function signingCredential(address: string): { bytes: Uint8Array; hash: string; isScript: boolean } | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(bech32.fromWords(bech32.decode(address, BECH32_MAX_LENGTH).words));
  } catch {
    return null;
  }
  if (bytes.length < 1 + BLAKE2B_224_LEN) return null;
  const type = bytes[0] >> 4;
  const hash = bytes.subarray(1, 1 + BLAKE2B_224_LEN).toString('hex');
  if (type <= 7) return { bytes, hash, isScript: (type & 1) === 1 };
  if (type === 14 || type === 15) return { bytes, hash, isScript: type === 15 };
  return null;
}

/** The bytes as text when they are valid UTF-8, else an empty string. */
function utf8OrEmpty(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

// Checks one CIP-30 signData result: structure, address, signer key, payload, then the signature.
// Stateless: a caller using it for login must issue the message itself, with a nonce and an expiry.
// Never throws; a failure returns `valid: false` with the reason.
export function verifyDataSignature(input: CoseVerifyInput): CoseVerifyResult {
  const result: CoseVerifyResult = { valid: false, reason: '', signedPayload: '', signedPayloadHex: '', signerVkh: '' };
  const fail = (reason: string): CoseVerifyResult => {
    result.reason = reason;
    return result;
  };

  try {
    const sign1 = parseCoseSign1(input.coseSignature);
    const key = parseCoseKey(input.coseKey);

    result.signedPayloadHex = toHex(sign1.payload);
    result.signerVkh = toHex(blake2b_224(key.publicKey));
    if (!sign1.hashed) result.signedPayload = utf8OrEmpty(sign1.payload);

    if (sign1.kid && key.kid && !sameBytes(sign1.kid, key.kid)) return fail('COSE_Sign1 kid and COSE_Key kid differ');

    const signer = signingCredential(input.address);
    if (!signer) return fail('Address could not be decoded (a bech32 payment or reward address is required)');
    if (!sameBytes(sign1.address, signer.bytes)) return fail('The address in the signed header is not the given address');
    if (signer.isScript) return fail('Address credential is a script hash; a key-hash address is required');
    if (signer.hash !== result.signerVkh) {
      return fail(`Signer key hash ${result.signerVkh} does not match the address credential ${signer.hash}`);
    }

    // The message is compared byte for byte; a hashed payload by its blake2b-224.
    const expected = input.expectedPayload ?? undefined;
    if (sign1.hashed) {
      if (sign1.payload.length !== BLAKE2B_224_LEN) return fail(`A hashed payload must be ${BLAKE2B_224_LEN} bytes (blake2b-224)`);
      if (expected === undefined) return fail('The wallet signed the hash of the message; pass expectedPayload to compare it');
      if (!sameBytes(blake2b_224(Buffer.from(expected, 'utf8')), sign1.payload)) return fail('Signed payload does not match the expected payload');
      result.signedPayload = expected;
    } else if (expected !== undefined && !sameBytes(Buffer.from(expected, 'utf8'), sign1.payload)) {
      return fail('Signed payload does not match the expected payload');
    }

    const sigStructure = buildSigStructure(sign1.protectedBytes, sign1.payload);
    if (!verifyEd25519Signature_sync(sign1.signature, sigStructure, key.publicKey)) {
      return fail('Ed25519 signature does not verify against the signed message');
    }

    result.valid = true;
    logger.debug({ signerVkh: result.signerVkh }, 'COSE_Sign1 data signature verified');
    return result;
  } catch (err: unknown) {
    logger.warn(`Data signature not verified: ${err instanceof Error ? err.message : String(err)}`);
    return fail(`Failed to verify data signature: ${err instanceof Error ? err.message : String(err)}`);
  }
}
