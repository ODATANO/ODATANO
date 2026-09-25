import cds from '@sap/cds';
import { HsmConfig, HsmSignResult } from '../../utils/types';
import { HsmError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { Cbor, CborArray, CborBytes, CborMap, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';

const logger = cds.log('HsmSigner');

/** CKM_EDDSA mechanism ID (PKCS#11 v3.0) for Ed25519 signing. */
const CKM_EDDSA = 0x00001057;

/** Minimal PKCS#11 surface used here; pkcs11js is loaded dynamically, no static type package. */
interface PKCS11Instance {
  load(path: string): void;
  C_Initialize(): void;
  C_Finalize(): void;
  C_OpenSession(slot: Buffer, flags: number): Buffer;
  C_CloseSession(session: Buffer): void;
  C_Login(session: Buffer, userType: number, pin: string): void;
  C_Logout(session: Buffer): void;
  C_FindObjectsInit(session: Buffer, template: Pkcs11Attribute[]): void;
  C_FindObjects(session: Buffer, count: number): Buffer[];
  C_FindObjectsFinal(session: Buffer): void;
  C_GetAttributeValue(session: Buffer, handle: Buffer, template: Pkcs11Attribute[]): Pkcs11Attribute[];
  C_SignInit(session: Buffer, mechanism: { mechanism: number }, key: Buffer): void;
  C_Sign(session: Buffer, data: Buffer, signature: Buffer): Buffer;
  C_GetSlotList(tokenPresent: boolean): Buffer[];
}
interface Pkcs11Attribute { type: number; value?: Buffer | number | boolean | string }
type Pkcs11JsModule = {
  PKCS11: new () => PKCS11Instance;
  // Object class enums (CKO_*) and attribute IDs (CKA_*) are uppercase ints.
  [k: string]: unknown;
};

// pkcs11js (optionalDependency, native binding) is loaded lazily through an injectable
// loader so tests can swap in a fake module.
type Pkcs11Loader = () => Pkcs11JsModule;
const defaultPkcs11Loader: Pkcs11Loader = () => require('pkcs11js') as Pkcs11JsModule;
let pkcs11Loader: Pkcs11Loader = defaultPkcs11Loader;

/** Test seam: inject a fake pkcs11js module loader (null restores the default). */
export function setPkcs11Loader(loader: Pkcs11Loader | null): void {
  pkcs11Loader = loader ?? defaultPkcs11Loader;
}

/**
 * Ed25519 transaction signing through a PKCS#11 HSM (YubiHSM 2, CloudHSM, Luna, …); private
 * keys never leave the device. Lifecycle: init(network) → sign()/signTransaction() → shutdown().
 */
export class HsmSigner {
  private pkcs11!: PKCS11Instance;
  private session!: Buffer;
  private privateKeyHandle!: Buffer;
  private publicKeyBytes: Buffer = Buffer.alloc(0);
  private publicKeyHashHex: string = '';
  private cardanoAddress: string = '';
  private config: HsmConfig;
  private connected: boolean = false;

  constructor(config: HsmConfig) {
    this.config = config;
  }

  /**
   * Open the PKCS#11 session, locate the key, export the public key and derive the
   * enterprise address for `network`. Called once at startup.
   */
  async init(network: 'mainnet' | 'preview' | 'preprod' | string): Promise<void> {
    // pkcs11js is only loaded when HSM is configured
    let pkcs11js: Pkcs11JsModule;
    try {
      pkcs11js = pkcs11Loader();
    } catch {
      throw new HsmError(
        'pkcs11js is not installed. Install it with: npm install pkcs11js',
        500, ERROR_CODES.HSM_UNAVAILABLE
      );
    }
    this.pkcs11 = new pkcs11js.PKCS11();

    try {
      this.pkcs11.load(this.config.pkcs11Module);
      this.pkcs11.C_Initialize();
      logger.info({ module: this.config.pkcs11Module }, 'PKCS#11 module loaded');

      // `config.slot` is the 0-based index into C_GetSlotList(true) (slots with a token),
      // not the PKCS#11 slot ID, which need not be contiguous or zero-based.
      const slots = this.pkcs11.C_GetSlotList(true);
      if (this.config.slot >= slots.length) {
        throw new HsmError(
          `HSM slot index ${this.config.slot} not found. ${slots.length} slot(s) with a token present (valid indices 0..${slots.length - 1}).`,
          503, ERROR_CODES.HSM_UNAVAILABLE
        );
      }
      this.session = this.pkcs11.C_OpenSession(
        slots[this.config.slot],
        (pkcs11js.CKF_SERIAL_SESSION as number) | (pkcs11js.CKF_RW_SESSION as number)
      );
      logger.debug({ slot: this.config.slot }, 'PKCS#11 session opened');

      try {
        this.pkcs11.C_Login(this.session, pkcs11js.CKU_USER as number, this.config.pin);
      } finally {
        // Zero the PIN wherever it could linger (config object shared with the server
        // singleton — mutate in place —, HSM_PIN env, CAP config), whatever the login outcome.
        this.config.pin = '';
        if (process.env.HSM_PIN) delete process.env.HSM_PIN;
        try {
          const hsmCds = (cds.env?.requires as Record<string, { hsm?: { pin?: string } }>)?.['odatano-core']?.hsm;
          if (hsmCds && 'pin' in hsmCds) hsmCds.pin = '';
        } catch { /* best effort */ }
      }
      logger.debug('PKCS#11 login successful');

      this.privateKeyHandle = this._findKey(pkcs11js, pkcs11js.CKO_PRIVATE_KEY as number);

      this.publicKeyBytes = this._exportPublicKey(pkcs11js);
      logger.debug({ publicKeyLength: this.publicKeyBytes.length }, 'Ed25519 public key exported');

      // Key hash = blake2b-224 of the public key
      const blake2b = require('blake2b');
      const hashOut = Buffer.alloc(28);
      blake2b(28).update(this.publicKeyBytes).digest(hashOut);
      this.publicKeyHashHex = hashOut.toString('hex');

      // Enterprise key-hash address: header 0x61 (mainnet) or 0x60 (testnet)
      const { bech32 } = require('bech32');
      const headerByte = network === 'mainnet' ? 0x61 : 0x60;
      const payload = Buffer.alloc(29);
      payload[0] = headerByte;
      hashOut.copy(payload, 1);
      const words = bech32.toWords(payload);
      const hrp = network === 'mainnet' ? 'addr' : 'addr_test';
      this.cardanoAddress = bech32.encode(hrp, words, 120);

      this.connected = true;
      logger.info({
        keyLabel: this.config.keyLabel,
        keyId: this.config.keyId,
        publicKeyHash: this.publicKeyHashHex,
        address: this.cardanoAddress,
      }, 'HSM signer initialized successfully');

    } catch (err: unknown) {
      this.connected = false;
      if (err instanceof HsmError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new HsmError(
        `Failed to initialize HSM: ${msg}`,
        503, ERROR_CODES.HSM_UNAVAILABLE, err
      );
    }
  }

  /** Sign a 32-byte tx body hash in the HSM; returns Ed25519 signature + public key for the witness. */
  sign(txBodyHash: Buffer): HsmSignResult {
    if (!this.connected) {
      throw new HsmError('HSM not connected', 503, ERROR_CODES.HSM_UNAVAILABLE);
    }

    try {
      this.pkcs11.C_SignInit(this.session, { mechanism: CKM_EDDSA }, this.privateKeyHandle);
      const signature = this.pkcs11.C_Sign(this.session, txBodyHash, Buffer.alloc(64));

      return {
        signatureHex: Buffer.from(signature).toString('hex'),
        publicKeyHex: this.publicKeyBytes.toString('hex'),
        publicKeyHash: this.publicKeyHashHex,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HsmError(
        `HSM signing failed: ${msg}`,
        500, ERROR_CODES.HSM_SIGNING_FAILED, err
      );
    }
  }

  /**
   * Sign the body hash (hex) in the HSM, build the VKey witness [publicKey, signature] and
   * splice it into the witness set at the raw CBOR level. Returns the signed tx CBOR (hex).
   */
  signTransaction(unsignedTxCbor: string, txBodyHash: string): string {
    const hashBytes = Buffer.from(txBodyHash, 'hex');
    const result = this.sign(hashBytes);

    try {
      const txObj = Cbor.parse(fromHex(unsignedTxCbor));

      if (!(txObj instanceof CborArray) || txObj.array.length < 2) {
        throw new HsmError('Invalid transaction CBOR structure', 400, ERROR_CODES.HSM_SIGNING_FAILED);
      }

      // Build VKey witness: [publicKey (32 bytes), signature (64 bytes)]
      const vkeyWitness = new CborArray([
        new CborBytes(Buffer.from(result.publicKeyHex, 'hex')),
        new CborBytes(Buffer.from(result.signatureHex, 'hex')),
      ]);

      // Witness set (txObj.array[1]): vkey witnesses (key 0) become the HSM witness only — single
      // signer; multi-sig goes through combineTransactionWithWitnesses(). Other keys are preserved.
      const origWs = txObj.array[1];
      if (origWs instanceof CborMap) {
        const entries = origWs.map.filter(
          (e) => !(e.k instanceof CborUInt && Number(e.k.num) === 0)
        );
        entries.push({
          k: new CborUInt(0),
          v: new CborArray([vkeyWitness]),
        });
        txObj.array[1] = new CborMap(entries, { indefinite: origWs.indefinite });
      } else {
        throw new HsmError('Witness set must be CBOR map', 400, ERROR_CODES.HSM_SIGNING_FAILED);
      }

      // Re-encode preserving encoding metadata
      const signedTxCbor = toHex(Cbor.encode(
        new CborArray(txObj.array, { indefinite: txObj.indefinite })
      ));

      logger.info({
        txBodyHash,
        publicKeyHash: result.publicKeyHash,
        signedTxLength: signedTxCbor.length,
      }, 'Transaction signed with HSM');

      return signedTxCbor;
    } catch (err: unknown) {
      if (err instanceof HsmError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new HsmError(
        `Failed to build signed transaction: ${msg}`,
        500, ERROR_CODES.HSM_SIGNING_FAILED, err
      );
    }
  }

  /** Get the HSM-derived Cardano enterprise address */
  getAddress(): string {
    return this.cardanoAddress;
  }

  /** Get the public key hash (for requiredSigners) */
  getPublicKeyHash(): string {
    return this.publicKeyHashHex;
  }

  /** Check connection status */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get status for monitoring */
  getStatus(): {
    connected: boolean;
    keyId?: string;
    keyLabel?: string;
    publicKeyHash?: string;
    address?: string;
  } {
    return {
      connected: this.connected,
      keyId: this.config.keyId,
      keyLabel: this.config.keyLabel,
      publicKeyHash: this.connected ? this.publicKeyHashHex : undefined,
      address: this.connected ? this.cardanoAddress : undefined,
    };
  }

  /** Graceful shutdown — close PKCS#11 session */
  shutdown(): void {
    if (this.session) {
      try {
        this.pkcs11.C_Logout(this.session);
        this.pkcs11.C_CloseSession(this.session);
        this.pkcs11.C_Finalize();
        logger.info('HSM session closed');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'HSM shutdown error (best effort)');
      }
      this.connected = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Find an Ed25519 key object (private or public) in the HSM by label and/or ID. */
  private _findKey(pkcs11js: Pkcs11JsModule, objectClass: number): Buffer {
    const template: Pkcs11Attribute[] = [
      { type: pkcs11js.CKA_CLASS as number, value: objectClass },
    ];

    // CKK_EC_EDWARDS (0x40) — PKCS#11 v3.0, may not be defined in older pkcs11js versions
    const CKK_EC_EDWARDS = (pkcs11js.CKK_EC_EDWARDS as number | undefined) ?? 0x00000040;
    template.push({ type: pkcs11js.CKA_KEY_TYPE as number, value: CKK_EC_EDWARDS });

    if (this.config.keyLabel) {
      template.push({ type: pkcs11js.CKA_LABEL as number, value: this.config.keyLabel });
    }
    if (this.config.keyId) {
      const idHex = this.config.keyId.replace('0x', '');
      template.push({ type: pkcs11js.CKA_ID as number, value: Buffer.from(idHex, 'hex') });
    }

    this.pkcs11.C_FindObjectsInit(this.session, template);
    const handles = this.pkcs11.C_FindObjects(this.session, 1);
    this.pkcs11.C_FindObjectsFinal(this.session);

    if (handles.length === 0) {
      throw new HsmError(
        `Ed25519 key not found in HSM (class: ${objectClass}, label: ${this.config.keyLabel}, id: ${this.config.keyId})`,
        500, ERROR_CODES.HSM_SIGNING_FAILED
      );
    }

    return handles[0];
  }

  /**
   * Export the Ed25519 public key from the HSM.
   * Handles both DER-wrapped (04 20 <32 bytes>) and raw 32-byte formats.
   */
  private _exportPublicKey(pkcs11js: Pkcs11JsModule): Buffer {
    const pubKeyHandle = this._findKey(pkcs11js, pkcs11js.CKO_PUBLIC_KEY as number);

    const attrs = this.pkcs11.C_GetAttributeValue(this.session, pubKeyHandle, [
      { type: pkcs11js.CKA_EC_POINT as number },
    ]);

    // CKA_EC_POINT for Ed25519 is a DER OCTET STRING around the 32-byte key: 04 20 <32 bytes>
    const ecPoint = Buffer.from(attrs[0].value as Buffer);

    if (ecPoint.length === 34 && ecPoint[0] === 0x04 && ecPoint[1] === 0x20) {
      return ecPoint.slice(2);
    }
    // Some HSMs return raw 32 bytes
    if (ecPoint.length === 32) {
      return ecPoint;
    }

    throw new HsmError(
      `Unexpected Ed25519 public key format from HSM (length: ${ecPoint.length})`,
      500, ERROR_CODES.HSM_SIGNING_FAILED
    );
  }
}

// Singleton instance
let hsmSignerInstance: HsmSigner | null = null;

/** The initialized HsmSigner, or null when HSM is not configured. */
export function getHsmSigner(): HsmSigner | null {
  return hsmSignerInstance;
}

/** Set the HsmSigner instance (initialization and shutdown). */
export function setHsmSigner(signer: HsmSigner | null): void {
  hsmSignerInstance = signer;
}
