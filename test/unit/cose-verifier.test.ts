/**
 * CIP-30 signData (COSE_Sign1) verifier. One vector is a published wallet signature; the others
 * are signed here with a fresh Ed25519 key over a genuine COSE Sig_structure.
 */

import { Cbor, CborArray, CborMap, CborTag, CborBytes, CborUInt, CborNegInt, CborText, CborSimple, type CborObj } from '@harmoniclabs/cbor';
import { toHex, fromHex } from '@harmoniclabs/uint8array-utils';
import { signEd25519_sync, blake2b_224 } from '@harmoniclabs/crypto';
import { bech32 } from 'bech32';

import { verifyDataSignature } from '../../srv/blockchain/signing/cose-verifier';

// Mock only the logger (cose-verifier calls cds.log)
vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
};
  return { default: cdsMock, ...cdsMock };
});

// ---------------------------------------------------------------------------
// Helpers: a CIP-30 signData result for a given key, address and payload
// ---------------------------------------------------------------------------

const BECH32_LIMIT = 1023;

/** Deterministic 32-byte private key (so the test is reproducible). */
const PRIVATE_KEY = fromHex('4f'.repeat(32));
const PUBLIC_KEY = signEd25519_sync(new Uint8Array(0), PRIVATE_KEY).pubKey;
const VKH = blake2b_224(PUBLIC_KEY);

type AddressKind = 'enterprise' | 'enterpriseScript' | 'base' | 'reward' | 'rewardScript';
// header byte: address type in the high nibble, testnet in the low one
const HEADER: Record<AddressKind, number> = { enterprise: 0x60, enterpriseScript: 0x70, base: 0x00, reward: 0xe0, rewardScript: 0xf0 };

function addressBytes(kind: AddressKind, credHash: Uint8Array = VKH): Buffer {
  const stakePart = kind === 'base' ? Buffer.alloc(28, 0x11) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([HEADER[kind]]), Buffer.from(credHash), stakePart]);
}

function bech32Of(bytes: Uint8Array): string {
  const reward = bytes[0] >> 4 >= 14;
  return bech32.encode(reward ? 'stake_test' : 'addr_test', bech32.toWords(bytes), BECH32_LIMIT);
}

interface SignOptions {
  kind?: AddressKind;
  wrapTag?: boolean;
  /** Raw payload bytes instead of the UTF-8 of `payload`. */
  payloadBytes?: Uint8Array;
  /** Sign the blake2b-224 of the payload and set `hashed: true`. */
  hashed?: boolean;
  /** Entries of the protected header; default `{ 1: -8, "address": bytes }`. */
  protectedHeader?: (address: Uint8Array) => Array<{ k: CborObj; v: CborObj }>;
  unprotectedHeader?: Array<{ k: CborObj; v: CborObj }>;
  key?: Array<{ k: CborObj; v: CborObj }>;
}

const label = (n: number): CborObj => (n < 0 ? new CborNegInt(n) : new CborUInt(n));
const ALG = { k: label(1), v: label(-8) };
const addressHeader = (address: Uint8Array) => ({ k: new CborText('address'), v: new CborBytes(address) });
const KEY_ENTRIES = [
  { k: label(1), v: label(1) },
  { k: label(3), v: label(-8) },
  { k: label(-1), v: label(6) },
  { k: label(-2), v: new CborBytes(PUBLIC_KEY) },
];

/** A CIP-30 signData result (COSE_Sign1 + COSE_Key) for `payload`, as wallets build it. */
function signData(payload: string, opts: SignOptions = {}) {
  const address = addressBytes(opts.kind ?? 'enterprise');
  const message = opts.payloadBytes ?? Buffer.from(payload, 'utf8');
  const signedPayload = opts.hashed ? blake2b_224(message) : message;
  const protectedBytes = Cbor.encode(new CborMap(opts.protectedHeader?.(address) ?? [ALG, addressHeader(address)]));

  // Sig_structure = [ "Signature1", protected (bstr), external_aad (h''), payload (bstr) ]
  const sigStructure = Cbor.encode(new CborArray([
    new CborText('Signature1'),
    new CborBytes(protectedBytes),
    new CborBytes(new Uint8Array(0)),
    new CborBytes(signedPayload),
  ]));
  const { signature } = signEd25519_sync(sigStructure, PRIVATE_KEY);

  const unprotected = opts.unprotectedHeader ?? [{ k: new CborText('hashed'), v: new CborSimple(opts.hashed === true) }];
  const coseSign1 = new CborArray([
    new CborBytes(protectedBytes),
    new CborMap(unprotected),
    new CborBytes(signedPayload),
    new CborBytes(signature),
  ]);

  return {
    address: bech32Of(address),
    coseSignature: toHex(Cbor.encode(opts.wrapTag ? new CborTag(18, coseSign1) : coseSign1)),
    coseKey: toHex(Cbor.encode(new CborMap(opts.key ?? KEY_ENTRIES))),
    vkh: toHex(VKH),
  };
}

const verify = (d: { address: string; coseSignature: string; coseKey: string }, expectedPayload?: string) =>
  verifyDataSignature({ address: d.address, coseSignature: d.coseSignature, coseKey: d.coseKey, expectedPayload });

// ---------------------------------------------------------------------------

describe('verifyDataSignature (CIP-30 signData / COSE_Sign1)', () => {
  // Example published with the Cardano Foundation's cardano-verify-datasignature, signed by a wallet.
  describe('a published wallet signature over a reward address', () => {
    const vector = {
      address: 'stake1uyvfslqkzgrf6syq5r4jg7pqewv8l65phh024lw5r7vk9qgznhyty',
      coseKey: 'a4010103272006215820b89526fd6bf4ba737c55ea90670d16a27f8de6cc1982349b3b676705a2f420c6',
      coseSignature: '84582aa201276761646472657373581de118987c1612069d4080a0eb247820cb987fea81bddeaafdd41f996281a166686173686564f458264175677573746120416461204b696e672c20436f756e74657373206f66204c6f76656c61636558401712458b19f606b322982f6290c78529a235b56c0f1cec4f24b12a8660b40cd37f4c5440a465754089c462ed4b0d613bffaee3d1833516569fda4852f42a4a0f',
    };
    const message = 'Augusta Ada King, Countess of Lovelace';

    it('is valid, with and without the expected message', () => {
      const res = verify(vector);
      expect(res).toEqual({
        valid: true, reason: '', signedPayload: message,
        signedPayloadHex: Buffer.from(message, 'utf8').toString('hex'),
        signerVkh: '18987c1612069d4080a0eb247820cb987fea81bddeaafdd41f996281',
      });
      expect(verify(vector, message).valid).toBe(true);
    });

    it('is not valid for another message', () => {
      expect(verify(vector, `${message}!`)).toMatchObject({ valid: false, reason: 'Signed payload does not match the expected payload' });
    });

    it('is not valid for another address', () => {
      const other = bech32Of(addressBytes('reward'));
      expect(verify({ ...vector, address: other }).reason).toBe('The address in the signed header is not the given address');
    });
  });

  it('accepts a valid signature and echoes payload + signer vkh', () => {
    const d = signData('MyApp login: abc123');
    const res = verify(d);

    expect(res.valid).toBe(true);
    expect(res.reason).toBe('');
    expect(res.signedPayload).toBe('MyApp login: abc123');
    expect(res.signedPayloadHex).toBe(Buffer.from('MyApp login: abc123').toString('hex'));
    expect(res.signerVkh).toBe(d.vkh);
  });

  it('accepts a COSE_Sign1 wrapped in CBOR tag 18', () => {
    expect(verify(signData('tagged message', { wrapTag: true })).valid).toBe(true);
  });

  it.each(['base', 'reward'] as const)('accepts a %s address signed with the key of its credential', (kind) => {
    expect(verify(signData('hello', { kind })).valid).toBe(true);
  });

  it('accepts a signature without unprotected headers', () => {
    expect(verify(signData('hello', { unprotectedHeader: [] })).valid).toBe(true);
  });

  it('passes when expectedPayload matches', () => {
    expect(verify(signData('nonce-42'), 'nonce-42').valid).toBe(true);
  });

  it('rejects when expectedPayload does not match (anti-replay)', () => {
    const d = signData('nonce-42');
    const res = verify(d, 'nonce-99');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/payload/i);
    // signerVkh is still echoed for diagnostics
    expect(res.signerVkh).toBe(d.vkh);
  });

  describe('address binding', () => {
    it('rejects an address whose credential is not the signer, even when the header names it', () => {
      const stranger = blake2b_224(Buffer.from('different key bytes here padding'));
      const d = signData('hello', { protectedHeader: () => [ALG, addressHeader(addressBytes('enterprise', stranger))] });
      const res = verify({ ...d, address: bech32Of(addressBytes('enterprise', stranger)) });
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/does not match the address credential/);
    });

    it('rejects another address of the same key: the header names the signed one', () => {
      const d = signData('hello');
      const res = verify({ ...d, address: bech32Of(addressBytes('base')) });
      expect(res.reason).toBe('The address in the signed header is not the given address');
    });

    it('rejects a signature whose protected header carries no address', () => {
      expect(verify(signData('hello', { protectedHeader: () => [ALG] })).reason).toMatch(/carries no address/);
    });

    it.each(['enterpriseScript', 'rewardScript'] as const)('rejects a script credential (%s)', (kind) => {
      const res = verify(signData('hello', { kind }));
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/script/i);
    });

    it('rejects an address that is not bech32', () => {
      expect(verify({ ...signData('hello'), address: 'Ae2tdPwUPEZ' }).reason).toMatch(/could not be decoded/);
    });
  });

  describe('algorithm, key type and curve', () => {
    const withKey = (entries: Array<{ k: CborObj; v: CborObj }>) => verify(signData('hello', { key: entries }));
    const replaced = (labelNo: number, value: CborObj) => KEY_ENTRIES.map(e => (e.k as CborUInt).num === BigInt(labelNo) ? { k: e.k, v: value } : e);

    it('rejects a signature that names another algorithm', () => {
      const d = signData('hello', { protectedHeader: (a) => [{ k: label(1), v: label(-7) }, addressHeader(a)] });
      expect(verify(d).reason).toMatch(/alg \(1\) must be EdDSA/);
    });

    it('rejects an empty protected header', () => {
      const d = signData('hello');
      const obj = Cbor.parse(fromHex(d.coseSignature)) as CborArray;
      const bare = new CborArray([new CborBytes(new Uint8Array(0)), obj.array[1], obj.array[2], obj.array[3]]);
      expect(verify({ ...d, coseSignature: toHex(Cbor.encode(bare)) }).reason).toMatch(/protected header is empty/);
    });

    it('rejects a key of another type, algorithm or curve', () => {
      expect(withKey(replaced(1, label(2))).reason).toMatch(/kty \(1\) must be OKP/);
      expect(withKey(replaced(3, label(-7))).reason).toMatch(/alg \(3\) must be EdDSA/);
      expect(withKey(replaced(-1, label(4))).reason).toMatch(/crv \(-1\) must be Ed25519/);
      expect(withKey(KEY_ENTRIES.filter(e => (e.k as CborUInt).num !== 3n)).reason).toMatch(/alg \(3\) must be EdDSA/);
    });

    it('rejects a COSE_Key missing the public key (label -2)', () => {
      const res = withKey(KEY_ENTRIES.slice(0, 3));
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/public key/i);
    });

    it('rejects a public key of the wrong length', () => {
      expect(withKey(replaced(-2, new CborBytes(PUBLIC_KEY.slice(0, 31)))).reason).toMatch(/must be 32 bytes, got 31/);
    });
  });

  describe('ambiguous structures', () => {
    it('rejects a label that occurs twice in a header or in the key', () => {
      const twice = signData('hello', { protectedHeader: (a) => [ALG, addressHeader(a), addressHeader(a)] });
      expect(verify(twice).reason).toMatch(/protected header repeats the label address/);
      expect(verify(signData('hello', { key: [...KEY_ENTRIES, KEY_ENTRIES[3]] })).reason).toMatch(/COSE_Key repeats the label -2/);
    });

    it('rejects a header that is both signed and unsigned', () => {
      const d = signData('hello', { unprotectedHeader: [{ k: label(1), v: label(-8) }] });
      expect(verify(d).reason).toMatch(/carries the header 1 twice/);
    });

    it('rejects key ids that differ between signature and key', () => {
      const kid = (id: string) => ({ k: label(4), v: new CborBytes(Buffer.from(id)) });
      const d = signData('hello', {
        protectedHeader: (a) => [ALG, addressHeader(a), kid('one')],
        key: [...KEY_ENTRIES, { k: label(2), v: new CborBytes(Buffer.from('two')) }],
      });
      expect(verify(d).reason).toBe('COSE_Sign1 kid and COSE_Key kid differ');
    });

    it('rejects a detached payload and a signature that is not 64 bytes', () => {
      const d = signData('hello');
      const [prot, unprot, payload, sig] = (Cbor.parse(fromHex(d.coseSignature)) as CborArray).array;
      const detached = new CborArray([prot, unprot, new CborSimple(null), sig]);
      expect(verify({ ...d, coseSignature: toHex(Cbor.encode(detached)) }).reason).toMatch(/detached payloads are not supported/);
      const short = new CborArray([prot, unprot, payload, new CborBytes((sig as CborBytes).bytes.slice(0, 63))]);
      expect(verify({ ...d, coseSignature: toHex(Cbor.encode(short)) }).reason).toMatch(/signature must be a byte string of 64 bytes/);
    });
  });

  describe('payload', () => {
    it('compares bytes: two payloads that decode to the same text are not the same message', () => {
      // 0xff is not UTF-8 and would decode to the replacement character
      const d = signData('', { payloadBytes: Uint8Array.from([0x41, 0xff]) });
      const res = verify(d);
      expect(res.valid).toBe(true);
      expect(res.signedPayload).toBe('');
      expect(res.signedPayloadHex).toBe('41ff');
      expect(verify(d, 'A�').reason).toBe('Signed payload does not match the expected payload');
    });

    it('accepts a hashed payload when the expected message hashes to it', () => {
      const d = signData('a message too long for the device', { hashed: true });
      const res = verify(d, 'a message too long for the device');
      expect(res.valid).toBe(true);
      expect(res.signedPayload).toBe('a message too long for the device');
      expect(res.signedPayloadHex).toHaveLength(56);
    });

    it('rejects a hashed payload without the expected message, or with another one', () => {
      const d = signData('a message too long for the device', { hashed: true });
      expect(verify(d).reason).toMatch(/pass expectedPayload/);
      expect(verify(d, 'another message').reason).toBe('Signed payload does not match the expected payload');
    });

    it('rejects a hashed flag that is not a boolean', () => {
      const d = signData('hello', { unprotectedHeader: [{ k: new CborText('hashed'), v: label(1) }] });
      expect(verify(d).reason).toMatch(/hashed must be a boolean/);
    });
  });

  it('rejects a tampered signature', () => {
    const d = signData('hello');
    // flip the last byte of the COSE_Sign1 signature: re-parse, mutate, re-encode
    const obj = Cbor.parse(fromHex(d.coseSignature)) as CborArray;
    const sig = (obj.array[3] as CborBytes).bytes.slice();
    sig[sig.length - 1] ^= 0xff;
    const tampered = new CborArray([obj.array[0], obj.array[1], obj.array[2], new CborBytes(sig)]);
    const res = verify({ ...d, coseSignature: toHex(Cbor.encode(tampered)) });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/signature does not verify/i);
  });

  it('rejects malformed hex without throwing', () => {
    const res = verify({ ...signData('hello'), coseSignature: 'zzzz' });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/failed to verify/i);
  });
});
