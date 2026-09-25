import crypto from 'node:crypto';
import os from 'node:os';
import cds from '@sap/cds';

const logger = cds.log('CardanoWalletWorker');

/**
 * AES-256-GCM for secrets at rest (wallet worker signing keys), format `iv:authTag:ciphertext` in base64.
 * Key derived from ENCRYPTION_KEY; production refuses to start without it.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16;  // 128 bits

/** 32-byte key from ENCRYPTION_KEY; development falls back to a process-scoped key. */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    return crypto.createHash('sha256').update(envKey).digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY must be set in production. Refusing to start with a fallback key.');
  }
  logger.warn('ENCRYPTION_KEY not set — using dev fallback key. Set ENCRYPTION_KEY for production.');
  const fallback = `odatano-core-${process.pid}-${os.hostname()}`;
  return crypto.createHash('sha256').update(fallback).digest();
}

/** Encrypts to `base64(iv):base64(authTag):base64(ciphertext)`. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypts a combined `iv:authTag:ciphertext` string; throws on auth-tag mismatch. */
export function decrypt(combined: string, key: Buffer): string {
  const parts = combined.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format: expected iv:authTag:ciphertext');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
