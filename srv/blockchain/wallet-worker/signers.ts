import cds from '@sap/cds';
import { Cbor, CborArray, CborBytes, CborMap, CborUInt } from '@harmoniclabs/cbor';
import { fromHex, toHex } from '@harmoniclabs/uint8array-utils';
import { blake2b_224, deriveEd25519PublicKey_sync, signEd25519_sync } from '@harmoniclabs/crypto';
import { bech32 } from 'bech32';
import { getHsmSigner } from '../signing/hsm-signer';
import { ConfigError, TransactionValidationError } from '../../utils/errors';
import { decrypt, getEncryptionKey } from '../../utils/crypto';
import type { WorkerSignerTypeValue } from './job-store';

const logger = cds.log('CardanoWalletWorker');

/**
 * Wallet-worker signers (v2.0).
 *
 * `WorkerSigner` is the signer-agnostic surface the worker engine executes against:
 *  - `hsm` (production): thin wrapper around the already-initialized `HsmSigner`
 *    (PKCS#11 — keys never leave the module).
 *  - `software` (dev/test): operator-configured Ed25519 key from an environment
 *    variable, either plain 64-char hex or AES-256-GCM encrypted
 *    (`iv:authTag:ciphertext`, keyed by ENCRYPTION_KEY — see srv/utils/crypto.ts).
 *
 * Keys are NEVER accepted through the OData surface and never persisted; the
 * software key lives only in this process's memory.
 */

export interface WorkerSigner {
  readonly type: WorkerSignerTypeValue;
  /** Bech32 enterprise address the wallet spends from. */
  getAddress(): string;
  /** Blake2b-224 hash of the verification key (for requiredSigners). */
  getPublicKeyHash(): string;
  /** Sign the tx body hash and return the fully signed transaction CBOR (hex). */
  signTransaction(unsignedTxCbor: string, txBodyHash: string): string;
}

/** Operator wallet entry from config (see loadWalletWorkerConfigFromEnv). */
export interface WorkerWalletConfig {
  walletId: string;
  signerType: WorkerSignerTypeValue;
  /**
   * software only: name of the environment variable holding the Ed25519 signing
   * key — plain 64-char hex, or AES-256-GCM `iv:authTag:ciphertext` (base64 parts).
   */
  keyEnv?: string;
}

/**
 * Merge a single VKey witness [publicKey, signature] into an unsigned transaction's
 * witness set at the raw CBOR level, preserving all non-vkey entries (scripts,
 * datums, redeemers) and encoding metadata. Same single-signer semantics as
 * HsmSigner.signTransaction — the worker wallet is the sole signer of its builds.
 */
export function mergeVkeyWitness(unsignedTxCbor: string, publicKeyHex: string, signatureHex: string): string {
  const txObj = Cbor.parse(fromHex(unsignedTxCbor));
  if (!(txObj instanceof CborArray) || txObj.array.length < 2) {
    throw new TransactionValidationError('Invalid transaction CBOR structure', undefined);
  }

  const vkeyWitness = new CborArray([
    new CborBytes(fromHex(publicKeyHex)),
    new CborBytes(fromHex(signatureHex)),
  ]);

  const origWs = txObj.array[1];
  if (!(origWs instanceof CborMap)) {
    throw new TransactionValidationError('Witness set must be a CBOR map', undefined);
  }
  const entries = origWs.map.filter(
    (e) => !(e.k instanceof CborUInt && Number(e.k.num) === 0),
  );
  entries.push({ k: new CborUInt(0), v: new CborArray([vkeyWitness]) });
  txObj.array[1] = new CborMap(entries, { indefinite: origWs.indefinite });

  return toHex(Cbor.encode(new CborArray(txObj.array, { indefinite: txObj.indefinite })));
}

/** Derive the bech32 enterprise key-hash address for a 28-byte key hash. */
export function deriveEnterpriseAddress(publicKeyHash: Uint8Array, network: string): string {
  const headerByte = network === 'mainnet' ? 0x61 : 0x60;
  const payload = Buffer.alloc(29);
  payload[0] = headerByte;
  Buffer.from(publicKeyHash).copy(payload, 1);
  const hrp = network === 'mainnet' ? 'addr' : 'addr_test';
  return bech32.encode(hrp, bech32.toWords(payload), 120);
}

/** hsm — delegates to the process-wide HsmSigner initialized at bootstrap. */
class HsmWorkerSigner implements WorkerSigner {
  readonly type = 'hsm' as const;

  private get signer() {
    const hsm = getHsmSigner();
    if (!hsm || !hsm.isConnected()) {
      throw new ConfigError('Wallet worker: HSM signer is not configured or not connected');
    }
    return hsm;
  }

  getAddress(): string {
    return this.signer.getAddress();
  }

  getPublicKeyHash(): string {
    return this.signer.getPublicKeyHash();
  }

  signTransaction(unsignedTxCbor: string, txBodyHash: string): string {
    return this.signer.signTransaction(unsignedTxCbor, txBodyHash);
  }
}

/** software — in-memory Ed25519 key (dev/test). */
export class SoftwareWorkerSigner implements WorkerSigner {
  readonly type = 'software' as const;
  private readonly privateKey: Uint8Array;
  private readonly publicKeyHex: string;
  private readonly publicKeyHashHex: string;
  private readonly address: string;

  constructor(privateKeyHex: string, network: string) {
    if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) {
      throw new ConfigError('Wallet worker: software signing key must be 64 hex characters (32-byte Ed25519 key)');
    }
    this.privateKey = fromHex(privateKeyHex);
    const publicKey = deriveEd25519PublicKey_sync(this.privateKey);
    this.publicKeyHex = toHex(Uint8Array.from(publicKey));
    const keyHash = Uint8Array.from(blake2b_224(Uint8Array.from(publicKey)));
    this.publicKeyHashHex = toHex(keyHash);
    this.address = deriveEnterpriseAddress(keyHash, network);
  }

  getAddress(): string {
    return this.address;
  }

  getPublicKeyHash(): string {
    return this.publicKeyHashHex;
  }

  signTransaction(unsignedTxCbor: string, txBodyHash: string): string {
    const { signature } = signEd25519_sync(fromHex(txBodyHash), this.privateKey);
    return mergeVkeyWitness(unsignedTxCbor, this.publicKeyHex, toHex(Uint8Array.from(signature)));
  }
}

/**
 * Resolve the software key material for a wallet: plain hex passes through,
 * the AES-256-GCM combined format (contains ':') is decrypted with ENCRYPTION_KEY.
 */
function resolveSoftwareKey(wallet: WorkerWalletConfig): string {
  if (!wallet.keyEnv) {
    throw new ConfigError(`Wallet worker: wallet "${wallet.walletId}" is signerType=software but has no keyEnv configured`);
  }
  const raw = process.env[wallet.keyEnv];
  if (!raw) {
    throw new ConfigError(`Wallet worker: environment variable ${wallet.keyEnv} (key for wallet "${wallet.walletId}") is not set`);
  }
  return raw.includes(':') ? decrypt(raw.trim(), getEncryptionKey()) : raw.trim();
}

/** Build the signer for a configured worker wallet. Throws ConfigError on bad setup. */
export function createWorkerSigner(wallet: WorkerWalletConfig, network: string): WorkerSigner {
  if (wallet.signerType === 'hsm') {
    const signer = new HsmWorkerSigner();
    // Fail fast at worker start when the HSM is absent, not on the first job.
    signer.getAddress();
    return signer;
  }
  if (wallet.signerType === 'software') {
    const signer = new SoftwareWorkerSigner(resolveSoftwareKey(wallet), network);
    logger.info(`Software signer for wallet "${wallet.walletId}" initialized (address=${signer.getAddress()})`);
    return signer;
  }
  throw new ConfigError(`Wallet worker: unknown signerType "${String(wallet.signerType)}" for wallet "${wallet.walletId}"`);
}
