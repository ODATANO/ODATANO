/**
 * Wallet worker — signers + crypto (W2/W6).
 * Real crypto: SoftwareWorkerSigner key derivation, enterprise address,
 * raw-CBOR vkey-witness merge (verified with verifyEd25519Signature_sync),
 * AES-256-GCM roundtrip, and the createWorkerSigner config guardrails.
 */

vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
};
  return { default: cdsMock, ...cdsMock };
});

// Defaults to "no HSM" so the guardrail tests below keep their meaning; the
// HsmWorkerSigner suite overrides it with a connected module.
const { getHsmSignerMock } = vi.hoisted(() => ({ getHsmSignerMock: vi.fn(() => undefined as unknown) }));
vi.mock('../../srv/blockchain/signing/hsm-signer', () => ({
  getHsmSigner: () => getHsmSignerMock(),
}));

import { Cbor, CborArray, CborMap, CborBytes, CborUInt } from '@harmoniclabs/cbor';
import { toHex, fromHex } from '@harmoniclabs/uint8array-utils';
import { verifyEd25519Signature_sync, deriveEd25519PublicKey_sync } from '@harmoniclabs/crypto';
import {
  SoftwareWorkerSigner,
  createWorkerSigner,
  deriveEnterpriseAddress,
  mergeVkeyWitness,
} from '../../srv/blockchain/wallet-worker/signers';
import { encrypt, decrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { ConfigError } from '../../srv/utils/errors';

const PRIVATE_KEY_HEX = '07'.repeat(32);
const TX_BODY_HASH = 'ab'.repeat(32);

/** Minimal unsigned tx CBOR: [ body(map), witness_set(map), true, null ]. */
function minimalUnsignedTx(witnessEntries: Array<{ k: CborUInt; v: CborArray }> = []): string {
  const tx = new CborArray([
    new CborMap([]),
    new CborMap(witnessEntries),
  ]);
  return toHex(Cbor.encode(tx));
}

describe('SoftwareWorkerSigner', () => {
  it('derives a stable testnet enterprise address and key hash', () => {
    const signer = new SoftwareWorkerSigner(PRIVATE_KEY_HEX, 'preview');
    expect(signer.getAddress()).toMatch(/^addr_test1/);
    expect(signer.getPublicKeyHash()).toMatch(/^[0-9a-f]{56}$/);
    // Deterministic: same key → same identity
    const again = new SoftwareWorkerSigner(PRIVATE_KEY_HEX, 'preview');
    expect(again.getAddress()).toBe(signer.getAddress());
  });

  it('uses the mainnet header + hrp on mainnet', () => {
    const signer = new SoftwareWorkerSigner(PRIVATE_KEY_HEX, 'mainnet');
    expect(signer.getAddress()).toMatch(/^addr1/);
    // Address matches the standalone derivation helper for the same key hash.
    expect(signer.getAddress()).toBe(deriveEnterpriseAddress(fromHex(signer.getPublicKeyHash()), 'mainnet'));
  });

  it('rejects malformed key material', () => {
    expect(() => new SoftwareWorkerSigner('nothex', 'preview')).toThrow(ConfigError);
    expect(() => new SoftwareWorkerSigner('ab'.repeat(16), 'preview')).toThrow(ConfigError);
  });

  it('produces a verifiable vkey witness over the tx body hash', () => {
    const signer = new SoftwareWorkerSigner(PRIVATE_KEY_HEX, 'preview');
    const signedHex = signer.signTransaction(minimalUnsignedTx(), TX_BODY_HASH);

    const parsed = Cbor.parse(fromHex(signedHex)) as CborArray;
    const witnessSet = parsed.array[1] as CborMap;
    const vkeyEntry = witnessSet.map.find(e => e.k instanceof CborUInt && Number((e.k as CborUInt).num) === 0)!;
    const witness = (vkeyEntry.v as CborArray).array[0] as CborArray;
    const pubKey = (witness.array[0] as CborBytes).bytes;
    const signature = (witness.array[1] as CborBytes).bytes;

    expect(Buffer.from(pubKey)).toEqual(Buffer.from(deriveEd25519PublicKey_sync(fromHex(PRIVATE_KEY_HEX))));
    expect(verifyEd25519Signature_sync(
      Uint8Array.from(signature),
      fromHex(TX_BODY_HASH),
      Uint8Array.from(pubKey),
    )).toBe(true);
  });
});

describe('mergeVkeyWitness', () => {
  it('replaces existing vkey witnesses but preserves other witness-set entries', () => {
    const scriptEntry = { k: new CborUInt(3), v: new CborArray([new CborBytes(fromHex('aabb'))]) };
    const staleVkey = { k: new CborUInt(0), v: new CborArray([new CborArray([new CborBytes(fromHex('00')), new CborBytes(fromHex('11'))])]) };
    const txHex = minimalUnsignedTx([scriptEntry, staleVkey]);

    const merged = mergeVkeyWitness(txHex, 'cc'.repeat(32), 'dd'.repeat(64));

    const parsed = Cbor.parse(fromHex(merged)) as CborArray;
    const ws = (parsed.array[1] as CborMap).map;
    const vkeyEntries = ws.filter(e => Number((e.k as CborUInt).num) === 0);
    const scriptEntries = ws.filter(e => Number((e.k as CborUInt).num) === 3);
    expect(vkeyEntries).toHaveLength(1);
    expect(scriptEntries).toHaveLength(1);
    const witness = (vkeyEntries[0].v as CborArray).array[0] as CborArray;
    expect(toHex((witness.array[0] as CborBytes).bytes)).toBe('cc'.repeat(32));
  });

  it('rejects CBOR that is not a transaction array', () => {
    const notATx = toHex(Cbor.encode(new CborMap([])));
    expect(() => mergeVkeyWitness(notATx, 'cc'.repeat(32), 'dd'.repeat(64))).toThrow(/Invalid transaction CBOR/);
  });
});

describe('createWorkerSigner', () => {
  afterEach(() => {
    delete process.env.WW_TEST_KEY;
    delete process.env.ENCRYPTION_KEY;
  });

  it('builds a software signer from a plain-hex env key', () => {
    process.env.WW_TEST_KEY = PRIVATE_KEY_HEX;
    const signer = createWorkerSigner({ walletId: 'w1', signerType: 'software', keyEnv: 'WW_TEST_KEY' }, 'preview');
    expect(signer.type).toBe('software');
    expect(signer.getAddress()).toMatch(/^addr_test1/);
  });

  it('decrypts an AES-256-GCM env key (iv:tag:ciphertext)', () => {
    process.env.ENCRYPTION_KEY = 'unit-test-master-key';
    process.env.WW_TEST_KEY = encrypt(PRIVATE_KEY_HEX, getEncryptionKey());
    const signer = createWorkerSigner({ walletId: 'w1', signerType: 'software', keyEnv: 'WW_TEST_KEY' }, 'preview');
    expect(signer.getAddress()).toBe(new SoftwareWorkerSigner(PRIVATE_KEY_HEX, 'preview').getAddress());
  });

  it('rejects a software wallet without keyEnv or with a missing env var', () => {
    expect(() => createWorkerSigner({ walletId: 'w1', signerType: 'software' }, 'preview')).toThrow(ConfigError);
    expect(() => createWorkerSigner({ walletId: 'w1', signerType: 'software', keyEnv: 'WW_MISSING' }, 'preview')).toThrow(ConfigError);
  });

  it('rejects an hsm wallet when no HSM is connected', () => {
    expect(() => createWorkerSigner({ walletId: 'w1', signerType: 'hsm' }, 'preview')).toThrow(ConfigError);
  });

  it('rejects an unknown signerType', () => {
    expect(() => createWorkerSigner({ walletId: 'w1', signerType: 'magic' as never }, 'preview')).toThrow(ConfigError);
  });
});

describe('HsmWorkerSigner', () => {
  const hsm = {
    isConnected: vi.fn(() => true),
    getAddress: vi.fn(() => 'addr_test1_hsm'),
    getPublicKeyHash: vi.fn(() => 'ab'.repeat(28)),
    signTransaction: vi.fn(() => 'signed-by-hsm'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hsm.isConnected.mockReturnValue(true);
    getHsmSignerMock.mockReturnValue(hsm);
  });
  afterEach(() => getHsmSignerMock.mockReturnValue(undefined));

  it('delegates address, key hash and signing to the process-wide HSM signer', () => {
    const signer = createWorkerSigner({ walletId: 'minter', signerType: 'hsm' }, 'preview');

    expect(signer.type).toBe('hsm');
    expect(signer.getAddress()).toBe('addr_test1_hsm');
    expect(signer.getPublicKeyHash()).toBe('ab'.repeat(28));
    expect(signer.signTransaction('dead', 'ab'.repeat(32))).toBe('signed-by-hsm');
    expect(hsm.signTransaction).toHaveBeenCalledWith('dead', 'ab'.repeat(32));
  });

  it('fails fast at worker start when the HSM is present but disconnected', () => {
    hsm.isConnected.mockReturnValue(false);
    expect(() => createWorkerSigner({ walletId: 'minter', signerType: 'hsm' }, 'preview')).toThrow(ConfigError);
  });

  it('refuses to sign once the HSM session drops after start', () => {
    const signer = createWorkerSigner({ walletId: 'minter', signerType: 'hsm' }, 'preview');
    hsm.isConnected.mockReturnValue(false);

    expect(() => signer.signTransaction('dead', 'ab'.repeat(32))).toThrow(ConfigError);
  });
});

describe('crypto: AES-256-GCM', () => {
  const key = Buffer.alloc(32, 7);

  it('roundtrips plaintext', () => {
    const combined = encrypt('secret-seed-hex', key);
    expect(combined.split(':')).toHaveLength(3);
    expect(decrypt(combined, key)).toBe('secret-seed-hex');
  });

  it('detects tampering', () => {
    const combined = encrypt('secret', key);
    const [iv, tag, data] = combined.split(':');
    const tampered = Buffer.from(data, 'base64');
    tampered[0] ^= 0xff;
    expect(() => decrypt(`${iv}:${tag}:${tampered.toString('base64')}`, key)).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decrypt('just-one-part', key)).toThrow(/Invalid encrypted format/);
  });

  it('getEncryptionKey derives from ENCRYPTION_KEY when set', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    try {
      const derived = getEncryptionKey();
      expect(derived).toHaveLength(32);
      // deterministic
      expect(getEncryptionKey().equals(derived)).toBe(true);
    } finally {
      delete process.env.ENCRYPTION_KEY;
    }
  });
});
