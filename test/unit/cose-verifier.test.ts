/**
 * Unit tests for the CIP-30 signData (COSE_Sign1) message-signature verifier.
 *
 * These tests build a REAL COSE_Sign1 + COSE_Key with the same @harmoniclabs
 * crypto primitives the verifier uses: a fresh Ed25519 key signs a genuine COSE
 * Sig_structure, so a passing positive test proves end-to-end byte compatibility
 * (protected-header preservation, tstr "Signature1", empty external_aad), not
 * just that our encoder agrees with our decoder.
 */

import { Cbor, CborArray, CborMap, CborTag, CborBytes, CborUInt, CborNegInt, CborText } from '@harmoniclabs/cbor';
import { toHex, fromHex } from '@harmoniclabs/uint8array-utils';
import { signEd25519_sync, blake2b_224 } from '@harmoniclabs/crypto';
import { bech32 } from 'bech32';

import { verifyDataSignature } from '../../srv/blockchain/signing/cose-verifier';

// Mock only the logger (cose-verifier calls cds.log)
jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers — build a real CIP-30 signData result for a given key + payload
// ---------------------------------------------------------------------------

const BECH32_LIMIT = 1023;

/** Deterministic 32-byte private key (so the test is reproducible). */
const PRIVATE_KEY = fromHex('4f'.repeat(32));

/** Encode an enterprise address (header high-nibble type + testnet) → bech32. */
function makeAddress(credHash: Uint8Array, isScript: boolean): string {
  // type 6 = enterprise key, type 7 = enterprise script; low nibble 0 = testnet
  const header = (isScript ? 0x70 : 0x60);
  const bytes = Buffer.concat([Buffer.from([header]), Buffer.from(credHash)]);
  return bech32.encode('addr_test', bech32.toWords(bytes), BECH32_LIMIT);
}

interface SignedData {
  address: string;
  coseSignature: string;
  coseKey: string;
  payload: string;
  vkh: string;
  pubKey: Uint8Array;
}

/** Produce a genuine CIP-30 signData (COSE_Sign1 + COSE_Key) for `payload`. */
function signData(payload: string, opts: { wrapTag?: boolean } = {}): SignedData {
  const payloadBytes = Buffer.from(payload, 'utf8');

  // protected header: { 1: -8 }  (alg = EdDSA). Encode to its exact bytes.
  const protectedBytes = Cbor.encode(new CborMap([{ k: new CborUInt(1), v: new CborNegInt(-8) }]));

  // Sig_structure = [ "Signature1", protected (bstr), external_aad (h''), payload (bstr) ]
  const sigStructure = Cbor.encode(new CborArray([
    new CborText('Signature1'),
    new CborBytes(protectedBytes),
    new CborBytes(new Uint8Array(0)),
    new CborBytes(payloadBytes),
  ]));

  const { signature, pubKey } = signEd25519_sync(sigStructure, PRIVATE_KEY);

  // COSE_Sign1 = [ protected (bstr), unprotected ({}), payload (bstr), signature (bstr) ]
  const coseSign1 = new CborArray([
    new CborBytes(protectedBytes),
    new CborMap([]),
    new CborBytes(payloadBytes),
    new CborBytes(signature),
  ]);
  const coseSignatureObj = opts.wrapTag ? new CborTag(18, coseSign1) : coseSign1;

  // COSE_Key = { 1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: pubkey }
  const coseKey = new CborMap([
    { k: new CborUInt(1), v: new CborUInt(1) },
    { k: new CborUInt(3), v: new CborNegInt(-8) },
    { k: new CborNegInt(-1), v: new CborUInt(6) },
    { k: new CborNegInt(-2), v: new CborBytes(pubKey) },
  ]);

  const vkh = toHex(blake2b_224(pubKey));

  return {
    address: makeAddress(blake2b_224(pubKey), false),
    coseSignature: toHex(Cbor.encode(coseSignatureObj)),
    coseKey: toHex(Cbor.encode(coseKey)),
    payload,
    vkh,
    pubKey,
  };
}

// ---------------------------------------------------------------------------

describe('verifyDataSignature (CIP-30 signData / COSE_Sign1)', () => {
  it('accepts a valid signature and echoes payload + signer vkh', () => {
    const d = signData('FINCA login: abc123');
    const res = verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: d.coseKey });

    expect(res.valid).toBe(true);
    expect(res.reason).toBe('');
    expect(res.signedPayload).toBe('FINCA login: abc123');
    expect(res.signerVkh).toBe(d.vkh);
  });

  it('accepts a COSE_Sign1 wrapped in CBOR tag 18', () => {
    const d = signData('tagged message', { wrapTag: true });
    const res = verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: d.coseKey });
    expect(res.valid).toBe(true);
  });

  it('passes when expectedPayload matches', () => {
    const d = signData('nonce-42');
    const res = verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: d.coseKey, expectedPayload: 'nonce-42' });
    expect(res.valid).toBe(true);
  });

  it('rejects when expectedPayload does not match (anti-replay)', () => {
    const d = signData('nonce-42');
    const res = verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: d.coseKey, expectedPayload: 'nonce-99' });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/payload/i);
    // signerVkh is still echoed for diagnostics
    expect(res.signerVkh).toBe(d.vkh);
  });

  it('rejects when the signer key hash does not match the address', () => {
    const d = signData('hello');
    // a different (valid) address whose payment cred is not the signer
    const otherAddr = makeAddress(blake2b_224(Buffer.from('different key bytes here padding')), false);
    const res = verifyDataSignature({ address: otherAddr, coseSignature: d.coseSignature, coseKey: d.coseKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/does not match address payment credential/i);
  });

  it('rejects a script-credential address', () => {
    const d = signData('hello');
    const scriptAddr = makeAddress(blake2b_224(d.pubKey), true); // same hash, script type
    const res = verifyDataSignature({ address: scriptAddr, coseSignature: d.coseSignature, coseKey: d.coseKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/script/i);
  });

  it('rejects a stake address (no payment credential)', () => {
    const d = signData('hello');
    const stakeAddr = bech32.encode('stake_test',
      bech32.toWords(Buffer.concat([Buffer.from([0xe0]), Buffer.from(blake2b_224(d.pubKey))])), BECH32_LIMIT);
    const res = verifyDataSignature({ address: stakeAddr, coseSignature: d.coseSignature, coseKey: d.coseKey });
    expect(res.valid).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const d = signData('hello');
    // flip the last byte of the COSE_Sign1 signature: re-parse, mutate, re-encode
    const obj = Cbor.parse(fromHex(d.coseSignature)) as CborArray;
    const sig = (obj.array[3] as CborBytes).bytes.slice();
    sig[sig.length - 1] ^= 0xff;
    const tampered = new CborArray([obj.array[0], obj.array[1], obj.array[2], new CborBytes(sig)]);
    const res = verifyDataSignature({ address: d.address, coseSignature: toHex(Cbor.encode(tampered)), coseKey: d.coseKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/signature does not verify/i);
  });

  it('rejects a COSE_Key missing the public key (label -2)', () => {
    const d = signData('hello');
    const badKey = toHex(Cbor.encode(new CborMap([{ k: new CborUInt(1), v: new CborUInt(1) }])));
    const res = verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: badKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/public key/i);
  });

  it('rejects malformed hex without throwing', () => {
    const d = signData('hello');
    const res = verifyDataSignature({ address: d.address, coseSignature: 'zzzz', coseKey: d.coseKey });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/failed to verify/i);
  });
});
