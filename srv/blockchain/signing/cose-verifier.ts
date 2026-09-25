import cds from '@sap/cds';
import { Cbor, CborObj, CborArray, CborMap, CborTag, CborBytes, CborUInt, CborNegInt, CborText } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_224, verifyEd25519Signature_sync } from '@harmoniclabs/crypto';
import { extractPaymentCredential } from '../../utils/validators';

const logger = cds.log('CoseVerifier');

/** CBOR tag 18 = COSE_Sign1 (RFC 8152). signData may or may not wrap in it. */
const COSE_SIGN1_TAG = 18;
/** COSE_Key label for the OKP public key x-coordinate (the raw Ed25519 key). */
const COSE_KEY_LABEL_X = -2;
const ED25519_PUBKEY_LEN = 32;

/**
 * Input to {@link verifyDataSignature}, mirroring the CIP-30 `signData` result:
 * `coseSignature` = hex `signature` field (COSE_Sign1), `coseKey` = hex `key` field (COSE_Key).
 */
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
  /** UTF-8 of the signed payload, echoed back for the caller to inspect */
  signedPayload: string;
  /** hex blake2b-224 of the signer public key (empty until the key is parsed) */
  signerVkh: string;
}

/** Find a COSE map entry by its integer label (handles +ve and -ve labels). */
function findIntLabel(map: CborMap, label: number): CborObj | undefined {
  const entry = map.map.find(e => {
    if (e.k instanceof CborUInt) return Number(e.k.num) === label;
    if (e.k instanceof CborNegInt) return Number(e.k.num) === label;
    return false;
  });
  return entry?.v;
}

/**
 * Parsed COSE_Sign1. `protectedBytes` keeps the exact received bstr content:
 * the Sig_structure must re-use it byte-for-byte, so the header map is never re-encoded.
 */
interface CoseSign1 {
  protectedBytes: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
}

function parseCoseSign1(hex: string): CoseSign1 {
  let obj = Cbor.parse(fromHex(hex));
  // CIP-30 signData may emit the COSE_Sign1 wrapped in tag 18 or bare.
  if (obj instanceof CborTag && Number(obj.tag) === COSE_SIGN1_TAG) obj = obj.data;
  if (!(obj instanceof CborArray) || obj.array.length !== 4) {
    throw new Error('COSE_Sign1 must be a 4-element array [protected, unprotected, payload, signature]');
  }
  const [prot, , payload, signature] = obj.array;
  if (!(prot instanceof CborBytes)) throw new Error('COSE_Sign1 protected header must be a byte string');
  if (!(payload instanceof CborBytes)) throw new Error('COSE_Sign1 payload must be a byte string (detached payloads are not supported)');
  if (!(signature instanceof CborBytes)) throw new Error('COSE_Sign1 signature must be a byte string');
  return { protectedBytes: prot.bytes, payload: payload.bytes, signature: signature.bytes };
}

/** Extract the raw 32-byte Ed25519 public key from a COSE_Key (label -2). */
function parseCoseKey(hex: string): Uint8Array {
  const obj = Cbor.parse(fromHex(hex));
  if (!(obj instanceof CborMap)) throw new Error('COSE_Key must be a CBOR map');
  const x = findIntLabel(obj, COSE_KEY_LABEL_X);
  if (!(x instanceof CborBytes)) throw new Error('COSE_Key is missing the Ed25519 public key (label -2)');
  if (x.bytes.length !== ED25519_PUBKEY_LEN) {
    throw new Error(`COSE_Key public key must be ${ED25519_PUBKEY_LEN} bytes, got ${x.bytes.length}`);
  }
  return x.bytes;
}

/**
 * Build the COSE Sig_structure that was actually signed and CBOR-encode it:
 *   [ "Signature1" (tstr), protected (bstr, exact bytes), external_aad (h''), payload (bstr) ]
 * external_aad is empty for CIP-8 / CIP-30 signData.
 */
function buildSigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const sigStruct = new CborArray([
    new CborText('Signature1'),
    new CborBytes(protectedBytes),
    new CborBytes(new Uint8Array(0)),
    new CborBytes(payload),
  ]);
  return Cbor.encode(sigStruct);
}

/**
 * Verify a CIP-30 `signData` (COSE_Sign1) signature against a bech32 address: signer key hash
 * (blake2b-224) must equal the address payment key credential, optional payload check, then
 * Ed25519 over the Sig_structure. Stateless, no nonce/replay handling; never throws (`{ valid: false, reason }`).
 */
export function verifyDataSignature(input: CoseVerifyInput): CoseVerifyResult {
  const result: CoseVerifyResult = { valid: false, reason: '', signedPayload: '', signerVkh: '' };

  try {
    const { protectedBytes, payload, signature } = parseCoseSign1(input.coseSignature);
    const pubKey = parseCoseKey(input.coseKey);

    result.signedPayload = Buffer.from(payload).toString('utf8');
    result.signerVkh = toHex(blake2b_224(pubKey));

    // signer key hash must equal the address payment credential (key hash, not script)
    const cred = extractPaymentCredential(input.address);
    if (!cred) {
      result.reason = 'Address could not be decoded or has no payment credential (base/enterprise key-hash address required)';
      return result;
    }
    if (cred.isScript) {
      result.reason = 'Address payment credential is a script hash; a key-hash address is required';
      return result;
    }
    if (cred.hash.toLowerCase() !== result.signerVkh.toLowerCase()) {
      result.reason = `Signer key hash ${result.signerVkh} does not match address payment credential ${cred.hash}`;
      return result;
    }

    // optional anti-replay payload check
    if (input.expectedPayload !== undefined && input.expectedPayload !== null) {
      if (result.signedPayload !== input.expectedPayload) {
        result.reason = 'Signed payload does not match the expected payload';
        return result;
      }
    }

    // Ed25519 signature over the rebuilt Sig_structure
    const sigStructure = buildSigStructure(protectedBytes, payload);
    if (!verifyEd25519Signature_sync(signature, sigStructure, pubKey)) {
      result.reason = 'Ed25519 signature does not verify against the signed message';
      return result;
    }

    result.valid = true;
    logger.debug({ signerVkh: result.signerVkh }, 'COSE_Sign1 data signature verified');
    return result;
  } catch (err: unknown) {
    result.reason = `Failed to verify data signature: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(result.reason);
    return result;
  }
}
