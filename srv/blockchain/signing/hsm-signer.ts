import cds from '@sap/cds';
import { HsmConfig, HsmSignResult } from '../../utils/types';
import { HsmError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { Cbor, CborArray, CborBytes, CborMap, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';

const logger = cds.log('HsmSigner');

/**
 * CKM_EDDSA mechanism ID (PKCS#11 v3.0)
 * Used for Ed25519 signing operations
 */
const CKM_EDDSA = 0x00001057;

/**
 * HsmSigner - PKCS#11 Hardware Security Module integration for Cardano transaction signing
 *
 * Wraps a PKCS#11 compliant HSM (YubiHSM 2, AWS CloudHSM, Thales Luna, etc.)
 * to provide Ed25519 signing for Cardano transactions. Private keys never leave
 * the HSM chip — only signatures are returned.
 *
 * Lifecycle:
 *   1. constructor(config) — stores config
 *   2. init(network) — connects to HSM, locates key, exports public key, derives Cardano address
 *   3. sign() / signTransaction() — signing operations
 *   4. shutdown() — closes session
 */
export class HsmSigner {
  private pkcs11: any;
  private session: any;
  private privateKeyHandle: any;
  private publicKeyBytes: Buffer = Buffer.alloc(0);
  private publicKeyHashHex: string = '';
  private cardanoAddress: string = '';
  private config: HsmConfig;
  private connected: boolean = false;

  constructor(config: HsmConfig) {
    this.config = config;
  }

  /**
   * Initialize PKCS#11 session and locate the signing key.
   * Called once during plugin startup.
   *
   * @param network - Cardano network (mainnet, preview, preprod) for address derivation
   */
  async init(network: 'mainnet' | 'preview' | 'preprod' | string): Promise<void> {
    // Dynamic import — pkcs11js is only loaded when HSM is configured
    let pkcs11js: any;
    try {
      pkcs11js = require('pkcs11js');
    } catch {
      throw new HsmError(
        'pkcs11js is not installed. Install it with: npm install pkcs11js',
        500, ERROR_CODES.HSM_UNAVAILABLE
      );
    }
    this.pkcs11 = new pkcs11js.PKCS11();

    try {
      // 1. Load PKCS#11 module
      this.pkcs11.load(this.config.pkcs11Module);
      this.pkcs11.C_Initialize();
      logger.info({ module: this.config.pkcs11Module }, 'PKCS#11 module loaded');

      // 2. Open session on configured slot
      const slots = this.pkcs11.C_GetSlotList(true);
      if (this.config.slot >= slots.length) {
        throw new HsmError(
          `HSM slot ${this.config.slot} not found. Available slots: ${slots.length}`,
          503, ERROR_CODES.HSM_UNAVAILABLE
        );
      }
      this.session = this.pkcs11.C_OpenSession(
        slots[this.config.slot],
        pkcs11js.CKF_SERIAL_SESSION | pkcs11js.CKF_RW_SESSION
      );
      logger.debug({ slot: this.config.slot }, 'PKCS#11 session opened');

      // 3. Login with PIN
      this.pkcs11.C_Login(this.session, pkcs11js.CKU_USER, this.config.pin);
      // Clear PIN from memory after successful login — PIN is no longer needed
      this.config = { ...this.config, pin: '' };
      logger.debug('PKCS#11 login successful');

      // 4. Find private key by label or ID
      this.privateKeyHandle = this._findKey(pkcs11js, pkcs11js.CKO_PRIVATE_KEY);

      // 5. Export public key
      this.publicKeyBytes = this._exportPublicKey(pkcs11js);
      logger.debug({ publicKeyLength: this.publicKeyBytes.length }, 'Ed25519 public key exported');

      // 6. Derive Cardano key hash and enterprise address
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

    } catch (err: any) {
      this.connected = false;
      if (err instanceof HsmError) throw err;
      throw new HsmError(
        `Failed to initialize HSM: ${err.message}`,
        503, ERROR_CODES.HSM_UNAVAILABLE, err
      );
    }
  }

  /**
   * Sign a 32-byte transaction body hash using the HSM.
   * Returns the Ed25519 signature + public key for witness construction.
   *
   * @param txBodyHash - 32-byte hash of the transaction body
   * @returns HsmSignResult with signature, public key, and key hash
   */
  sign(txBodyHash: Buffer): HsmSignResult {
    if (!this.connected) {
      throw new HsmError('HSM not connected', 503, ERROR_CODES.HSM_UNAVAILABLE);
    }

    try {
      // CKM_EDDSA = Ed25519 signing mechanism
      this.pkcs11.C_SignInit(this.session, { mechanism: CKM_EDDSA }, this.privateKeyHandle);
      const signature = this.pkcs11.C_Sign(this.session, txBodyHash, Buffer.alloc(64));

      return {
        signatureHex: Buffer.from(signature).toString('hex'),
        publicKeyHex: this.publicKeyBytes.toString('hex'),
        publicKeyHash: this.publicKeyHashHex,
      };
    } catch (err: any) {
      throw new HsmError(
        `HSM signing failed: ${err.message}`,
        500, ERROR_CODES.HSM_SIGNING_FAILED, err
      );
    }
  }

  /**
   * Sign a transaction and produce a complete signed transaction CBOR.
   *
   * Takes the unsigned transaction CBOR, signs the body hash via HSM,
   * builds a VKey witness [publicKey, signature], and merges it into
   * the transaction's witness set using raw CBOR manipulation.
   *
   * @param unsignedTxCbor - Unsigned transaction CBOR (hex)
   * @param txBodyHash - Transaction body hash (hex, 64 chars)
   * @returns Signed transaction CBOR (hex)
   */
  signTransaction(unsignedTxCbor: string, txBodyHash: string): string {
    const hashBytes = Buffer.from(txBodyHash, 'hex');
    const result = this.sign(hashBytes);

    try {
      // Parse unsigned transaction at raw CBOR level
      const txObj = Cbor.parse(fromHex(unsignedTxCbor));

      if (!(txObj instanceof CborArray) || txObj.array.length < 2) {
        throw new HsmError('Invalid transaction CBOR structure', 400, ERROR_CODES.HSM_SIGNING_FAILED);
      }

      // Build VKey witness: [publicKey (32 bytes), signature (64 bytes)]
      const vkeyWitness = new CborArray([
        new CborBytes(Buffer.from(result.publicKeyHex, 'hex')),
        new CborBytes(Buffer.from(result.signatureHex, 'hex')),
      ]);

      // Merge into witness set (txObj.array[1])
      // Single-signer design: HSM is the sole signer for unsigned transactions.
      // Multi-sig (e.g. wallet + HSM) uses combineTransactionWithWitnesses() instead.
      const origWs = txObj.array[1];
      if (origWs instanceof CborMap) {
        // Replace VKey witnesses (key 0) with HSM witness only
        // Preserves all other entries (redeemers key 5, datums key 4, scripts keys 1-3, 6-7)
        const entries = origWs.map.filter(
          (e: any) => !(e.k instanceof CborUInt && Number(e.k.num) === 0)
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
    } catch (err: any) {
      if (err instanceof HsmError) throw err;
      throw new HsmError(
        `Failed to build signed transaction: ${err.message}`,
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
      } catch (err: any) {
        logger.warn({ error: err.message }, 'HSM shutdown error (best effort)');
      }
      this.connected = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find a key object (private or public) in the HSM by label and/or ID
   */
  private _findKey(pkcs11js: any, objectClass: any): any {
    const template: any[] = [
      { type: pkcs11js.CKA_CLASS, value: objectClass },
    ];

    // CKK_EC_EDWARDS (0x40) — PKCS#11 v3.0, may not be defined in older pkcs11js versions
    const CKK_EC_EDWARDS = pkcs11js.CKK_EC_EDWARDS ?? 0x00000040;
    template.push({ type: pkcs11js.CKA_KEY_TYPE, value: CKK_EC_EDWARDS });

    if (this.config.keyLabel) {
      template.push({ type: pkcs11js.CKA_LABEL, value: this.config.keyLabel });
    }
    if (this.config.keyId) {
      const idHex = this.config.keyId.replace('0x', '');
      template.push({ type: pkcs11js.CKA_ID, value: Buffer.from(idHex, 'hex') });
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
  private _exportPublicKey(pkcs11js: any): Buffer {
    const pubKeyHandle = this._findKey(pkcs11js, pkcs11js.CKO_PUBLIC_KEY);

    // Extract CKA_EC_POINT (DER-encoded public key)
    const attrs = this.pkcs11.C_GetAttributeValue(this.session, pubKeyHandle, [
      { type: pkcs11js.CKA_EC_POINT },
    ]);

    // CKA_EC_POINT for Ed25519 is DER OCTET STRING wrapping 32-byte public key
    // Format: 04 20 <32 bytes>
    const ecPoint = Buffer.from(attrs[0].value);

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

// ---------------------------------------------------------------------------
// Singleton pattern (same as getExternalSignerModule())
// ---------------------------------------------------------------------------

let hsmSignerInstance: HsmSigner | null = null;

/**
 * Get the initialized HsmSigner instance.
 * Returns null if HSM is not configured.
 */
export function getHsmSigner(): HsmSigner | null {
  return hsmSignerInstance;
}

/**
 * Set the HsmSigner instance (called during initialization and shutdown).
 */
export function setHsmSigner(signer: HsmSigner | null): void {
  hsmSignerInstance = signer;
}
