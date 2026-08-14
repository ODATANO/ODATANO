import { HsmSigner, setPkcs11Loader } from '../../srv/blockchain/signing/hsm-signer';
import { HsmError } from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';
import type { HsmConfig } from '../../srv/utils/types';

// Mock @sap/cds for logger
vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
};
  return { default: cdsMock, ...cdsMock };
});

// ---------------------------------------------------------------------------
// Mock PKCS#11 infrastructure
// ---------------------------------------------------------------------------

// Ed25519 test key pair (RFC 8032 Test Vector 1)
const TEST_PUBLIC_KEY = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa3f4a18446b0b8d183f8e3',
  'hex'
);
// DER-wrapped public key: OCTET STRING (04 20) + 32 bytes
const TEST_PUBLIC_KEY_DER = Buffer.concat([
  Buffer.from([0x04, 0x20]),
  TEST_PUBLIC_KEY,
]);
// Fake Ed25519 signature (64 bytes)
const TEST_SIGNATURE = Buffer.alloc(64, 0xab);

// Mock session/key handles
const MOCK_SESSION = 42;
const MOCK_PRIVATE_KEY_HANDLE = 100;
const MOCK_PUBLIC_KEY_HANDLE = 101;

function createMockPkcs11(options?: {
  slotCount?: number;
  privateKeyFound?: boolean;
  publicKeyFound?: boolean;
  publicKeyFormat?: 'der' | 'raw' | 'invalid';
  signError?: Error;
  loginError?: Error;
}) {
  const opts = {
    slotCount: 1,
    privateKeyFound: true,
    publicKeyFound: true,
    publicKeyFormat: 'der' as const,
    ...options,
  };

  let findCallCount = 0;

  const mockPkcs11Instance = {
    load: vi.fn(),
    C_Initialize: vi.fn(),
    C_Finalize: vi.fn(),
    C_GetSlotList: vi.fn(() => {
      return Array(opts.slotCount).fill(null).map((_, i) => Buffer.from([i]));
    }),
    C_OpenSession: vi.fn(() => MOCK_SESSION),
    C_CloseSession: vi.fn(),
    C_Login: vi.fn(() => {
      if (opts.loginError) throw opts.loginError;
    }),
    C_Logout: vi.fn(),
    C_FindObjectsInit: vi.fn(),
    C_FindObjects: vi.fn((_session: any, _count: number) => {
      findCallCount++;
      // First call finds private key, second call finds public key
      if (findCallCount % 2 === 1) {
        return opts.privateKeyFound ? [MOCK_PRIVATE_KEY_HANDLE] : [];
      } else {
        return opts.publicKeyFound ? [MOCK_PUBLIC_KEY_HANDLE] : [];
      }
    }),
    C_FindObjectsFinal: vi.fn(),
    C_GetAttributeValue: vi.fn(() => {
      let ecPoint: Buffer;
      if (opts.publicKeyFormat === 'invalid') {
        ecPoint = Buffer.alloc(48, 0xaa); // 48 bytes — neither 34 (DER) nor 32 (raw)
      } else {
        ecPoint = opts.publicKeyFormat === 'der' ? TEST_PUBLIC_KEY_DER : TEST_PUBLIC_KEY;
      }
      return [{ value: ecPoint }];
    }),
    C_SignInit: vi.fn(),
    C_Sign: vi.fn((_session: any, _data: Buffer, _outBuf: Buffer) => {
      if (opts.signError) throw opts.signError;
      return TEST_SIGNATURE;
    }),
  };

  return {
    // function expression, not arrow — `new PKCS11()` must be constructible
    PKCS11: vi.fn(function () { return mockPkcs11Instance; }),
    CKF_SERIAL_SESSION: 0x00000004,
    CKF_RW_SESSION: 0x00000002,
    CKU_USER: 1,
    CKO_PRIVATE_KEY: 3,
    CKO_PUBLIC_KEY: 2,
    CKK_EC_EDWARDS: 0x00000040,
    CKA_CLASS: 0,
    CKA_KEY_TYPE: 0x100,
    CKA_LABEL: 3,
    CKA_ID: 0x102,
    CKA_EC_POINT: 0x181,
    _instance: mockPkcs11Instance,
    _resetFindCount: () => { findCallCount = 0; },
  };
}

// Default mock setup
let mockPkcs11: ReturnType<typeof createMockPkcs11>;

// The SUT loads pkcs11js via native require, which no module mock can
// intercept under vitest (and the optional native binding may not even build
// on this machine). Inject the fake module through the loader seam instead.
setPkcs11Loader(() => {
  if (!mockPkcs11) throw new Error('mockPkcs11 not initialized');
  return mockPkcs11 as any;
});

afterAll(() => setPkcs11Loader(null));


// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_HSM_CONFIG: HsmConfig = {
  enabled: true,
  pkcs11Module: '/usr/lib/pkcs11/yubihsm_pkcs11.so',
  slot: 0,
  pin: 'testpin',
  keyLabel: 'cardano-signing-key',
  keyId: '0x0001',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HsmSigner', () => {
  beforeEach(() => {
    mockPkcs11 = createMockPkcs11();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create instance with config', () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      expect(signer).toBeInstanceOf(HsmSigner);
      expect(signer.isConnected()).toBe(false);
    });
  });

  // =========================================================================
  // init()
  // =========================================================================

  describe('init()', () => {
    it('should initialize successfully with DER-wrapped public key', async () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');

      expect(signer.isConnected()).toBe(true);
      expect(signer.getAddress()).toMatch(/^addr_test1/);
      expect(signer.getPublicKeyHash()).toMatch(/^[a-f0-9]{56}$/); // 28 bytes = 56 hex chars

      const instance = mockPkcs11._instance;
      expect(instance.load).toHaveBeenCalledWith(DEFAULT_HSM_CONFIG.pkcs11Module);
      expect(instance.C_Initialize).toHaveBeenCalled();
      expect(instance.C_OpenSession).toHaveBeenCalled();
      expect(instance.C_Login).toHaveBeenCalled();
    });

    it('should initialize successfully with raw 32-byte public key', async () => {
      mockPkcs11 = createMockPkcs11({ publicKeyFormat: 'raw' });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');

      expect(signer.isConnected()).toBe(true);
    });

    it('should derive mainnet address for mainnet network', async () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('mainnet');

      expect(signer.isConnected()).toBe(true);
      expect(signer.getAddress()).toMatch(/^addr1/);
    });

    it('should throw HsmError when slot not found', async () => {
      mockPkcs11 = createMockPkcs11({ slotCount: 0 });
      const signer = new HsmSigner({ ...DEFAULT_HSM_CONFIG, slot: 0 });

      await expect(signer.init('preview')).rejects.toThrow(HsmError);
      await expect(signer.init('preview')).rejects.toThrow(/slot index 0 not found/);
      expect(signer.isConnected()).toBe(false);
    });

    it('should throw HsmError when private key not found', async () => {
      mockPkcs11 = createMockPkcs11({ privateKeyFound: false });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);

      await expect(signer.init('preview')).rejects.toThrow(HsmError);
      await expect(signer.init('preview')).rejects.toThrow(/key not found/);
    });

    it('should throw HsmError when login fails', async () => {
      mockPkcs11 = createMockPkcs11({ loginError: new Error('CKR_PIN_INCORRECT') });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);

      await expect(signer.init('preview')).rejects.toThrow(HsmError);
      await expect(signer.init('preview')).rejects.toThrow(/CKR_PIN_INCORRECT/);
    });

    it('should throw HsmError for unexpected public key format from HSM', async () => {
      mockPkcs11 = createMockPkcs11({ publicKeyFormat: 'invalid' });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);

      await expect(signer.init('preview')).rejects.toThrow(HsmError);
      await expect(signer.init('preview')).rejects.toThrow(/Unexpected Ed25519 public key format/);
    });
  });

  // =========================================================================
  // sign()
  // =========================================================================

  describe('sign()', () => {
    let signer: HsmSigner;

    beforeEach(async () => {
      signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');
    });

    it('should return valid signature, public key, and key hash', () => {
      const txBodyHash = Buffer.alloc(32, 0xde);
      const result = signer.sign(txBodyHash);

      expect(result.signatureHex).toMatch(/^[a-f0-9]{128}$/); // 64 bytes
      expect(result.publicKeyHex).toMatch(/^[a-f0-9]{64}$/);  // 32 bytes
      expect(result.publicKeyHash).toMatch(/^[a-f0-9]+$/);

      const instance = mockPkcs11._instance;
      expect(instance.C_SignInit).toHaveBeenCalled();
      expect(instance.C_Sign).toHaveBeenCalled();
    });

    it('should throw HsmError when not connected', () => {
      const disconnectedSigner = new HsmSigner(DEFAULT_HSM_CONFIG);

      expect(() => {
        disconnectedSigner.sign(Buffer.alloc(32));
      }).toThrow(HsmError);
      expect(() => {
        disconnectedSigner.sign(Buffer.alloc(32));
      }).toThrow(/not connected/);
    });

    it('should throw HsmError when HSM signing fails', async () => {
      mockPkcs11 = createMockPkcs11({ signError: new Error('CKR_DEVICE_ERROR') });
      const failSigner = new HsmSigner(DEFAULT_HSM_CONFIG);
      await failSigner.init('preview');

      expect(() => {
        failSigner.sign(Buffer.alloc(32));
      }).toThrow(HsmError);
      expect(() => {
        failSigner.sign(Buffer.alloc(32));
      }).toThrow(/CKR_DEVICE_ERROR/);
    });
  });

  // =========================================================================
  // signTransaction()
  // =========================================================================

  describe('signTransaction()', () => {
    let signer: HsmSigner;

    // fixture: unsigned transaction with empty witness set (CBOR: [emptyMap, emptyMap, true, null])
    const UNSIGNED_TX = '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6';
    const TX_BODY_HASH = '4a066f70b5e478f7564311fb2762025fa449246e5bdb035d233a8aadb004abc7';

    beforeEach(async () => {
      signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');
    });

    it('should produce valid signed transaction CBOR', () => {
      const signedCbor = signer.signTransaction(UNSIGNED_TX, TX_BODY_HASH);

      expect(signedCbor).toBeDefined();
      expect(typeof signedCbor).toBe('string');
      expect(signedCbor.length).toBeGreaterThan(UNSIGNED_TX.length);
      // Signed tx should be valid hex
      expect(() => Buffer.from(signedCbor, 'hex')).not.toThrow();
      // Signed tx starts with 84 (CBOR array of 4 elements)
      expect(signedCbor.startsWith('84')).toBe(true);
    });

    it('should throw HsmError for invalid CBOR', () => {
      expect(() => {
        signer.signTransaction('deadbeef', TX_BODY_HASH);
      }).toThrow(HsmError);
    });

    it('should throw HsmError for empty/malformed CBOR', () => {
      expect(() => {
        signer.signTransaction('80', TX_BODY_HASH); // empty CBOR array
      }).toThrow(HsmError);
    });

    it('should replace existing VKey witnesses (filter key 0) when witness set already has entries', () => {
      // CBOR: [emptyMap, {0: []}, true, null] — witness set has key 0 entry that should be replaced
      const txWithExistingWitnesses = '84a0a10080f5f6';
      const signedCbor = signer.signTransaction(txWithExistingWitnesses, TX_BODY_HASH);

      expect(signedCbor).toBeDefined();
      expect(typeof signedCbor).toBe('string');
      // Signed tx starts with 84 (CBOR array of 4 elements)
      expect(signedCbor.startsWith('84')).toBe(true);
    });

    it('should throw HsmError when witness set is not a CborMap', () => {
      // CBOR: [emptyMap, [], true, null] — witness set is an array, not a map
      const txWithArrayWitnessSet = '84a080f5f6';
      expect(() => {
        signer.signTransaction(txWithArrayWitnessSet, TX_BODY_HASH);
      }).toThrow(HsmError);
      expect(() => {
        signer.signTransaction(txWithArrayWitnessSet, TX_BODY_HASH);
      }).toThrow('Witness set must be CBOR map');
    });
  });

  // =========================================================================
  // getStatus()
  // =========================================================================

  describe('getStatus()', () => {
    it('should return status when connected', async () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');

      const status = signer.getStatus();
      expect(status.connected).toBe(true);
      expect(status.keyLabel).toBe('cardano-signing-key');
      expect(status.keyId).toBe('0x0001');
      expect(status.publicKeyHash).toBeDefined();
      expect(status.address).toMatch(/^addr_test1/);
    });

    it('should return disconnected status when not initialized', () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);

      const status = signer.getStatus();
      expect(status.connected).toBe(false);
      expect(status.keyLabel).toBe('cardano-signing-key');
      expect(status.publicKeyHash).toBeUndefined();
      expect(status.address).toBeUndefined();
    });
  });

  // =========================================================================
  // shutdown()
  // =========================================================================

  describe('shutdown()', () => {
    it('should close session and set disconnected', async () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');
      expect(signer.isConnected()).toBe(true);

      signer.shutdown();

      expect(signer.isConnected()).toBe(false);
      const instance = mockPkcs11._instance;
      expect(instance.C_Logout).toHaveBeenCalled();
      expect(instance.C_CloseSession).toHaveBeenCalled();
      expect(instance.C_Finalize).toHaveBeenCalled();
    });

    it('should not throw when called on uninitialized signer', () => {
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      expect(() => signer.shutdown()).not.toThrow();
    });
  });

  // =========================================================================
  // Error code verification
  // =========================================================================

  describe('error codes', () => {
    it('should use HSM_UNAVAILABLE for connection errors', async () => {
      expect.assertions(3);
      mockPkcs11 = createMockPkcs11({ slotCount: 0 });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);

      try {
        await signer.init('preview');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HsmError);
        expect(err.code).toBe(ERROR_CODES.HSM_UNAVAILABLE);
        expect(err.statusCode).toBe(503);
      }
    });

    it('should use HSM_SIGNING_FAILED for signing errors', async () => {
      expect.assertions(3);
      mockPkcs11 = createMockPkcs11({ signError: new Error('device error') });
      const signer = new HsmSigner(DEFAULT_HSM_CONFIG);
      await signer.init('preview');

      try {
        signer.sign(Buffer.alloc(32));
      } catch (err: any) {
        expect(err).toBeInstanceOf(HsmError);
        expect(err.code).toBe(ERROR_CODES.HSM_SIGNING_FAILED);
        expect(err.statusCode).toBe(500);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Singleton tests
// ---------------------------------------------------------------------------

describe('HSM Signer Singleton', () => {
  it('should export getHsmSigner and setHsmSigner', async () => {
    const { getHsmSigner, setHsmSigner } = await import('../../srv/blockchain/signing/hsm-signer');

    expect(typeof getHsmSigner).toBe('function');
    expect(typeof setHsmSigner).toBe('function');

    // Default should be null
    const defaultSigner = getHsmSigner();
    expect(defaultSigner).toBeNull();

    // Set and get
    const fakeSigner = { isConnected: () => true } as any;
    setHsmSigner(fakeSigner);
    expect(getHsmSigner()).toBe(fakeSigner);

    // Cleanup
    setHsmSigner(null);
    expect(getHsmSigner()).toBeNull();
  });
});
