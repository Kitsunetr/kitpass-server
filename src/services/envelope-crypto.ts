import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

function getKeyBuffer(): Buffer {
  const hex = getConfig().SERVER_ENCRYPTION_KEY;
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts data with SERVER_ENCRYPTION_KEY using AES-256-GCM.
 * Optionally includes AAD (Additional Authenticated Data) -- used for auth_salt binding.
 * Returns: base64 string of iv + tag + ciphertext.
 */
export function envelopeEncrypt(plaintext: string, aad?: string): string {
  const key = getKeyBuffer();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: iv (12) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypts data encrypted by envelopeEncrypt.
 * AAD must match exactly what was used during encryption.
 */
export function envelopeDecrypt(packed: string, aad?: string): string {
  const key = getKeyBuffer();
  const buf = Buffer.from(packed, 'base64');

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf-8'));
  }

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}
