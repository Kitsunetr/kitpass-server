import argon2 from 'argon2';
import { randomBytes, createHmac } from 'node:crypto';
import { query, transaction } from '../db/connection.js';
import { envelopeEncrypt, envelopeDecrypt } from './envelope-crypto.js';
import { AppError } from '../utils/errors.js';
import { getConfig } from '../config.js';

interface RegisterInput {
  email: string;
  authHash: string;
  protectedSymmetricKey: string;
  publicKey: string;
  encryptedPrivateKey: string;
  hkdfSalt: string;
  kdfType: 'argon2id' | 'pbkdf2';
  kdfIterations?: number;
  kdfMemory?: number;
  kdfParallelism?: number;
}

interface LoginResult {
  userId: string;
  email: string;
  protectedSymmetricKey: string;
  publicKey: string;
  encryptedPrivateKey: string;
  hkdfSalt: string;
  kdfType: string;
  kdfIterations: number | null;
  kdfMemory: number | null;
  kdfParallelism: number | null;
  twoFactorEnabled: boolean;
}

export async function register(input: RegisterInput): Promise<string> {
  const { rows: existing } = await query(
    'SELECT id FROM users WHERE email = $1',
    [input.email.toLowerCase()]
  );
  if (existing.length > 0) {
    throw new AppError(409, 'Email already registered', 'EMAIL_EXISTS');
  }

  const authSalt = randomBytes(32).toString('hex');
  const config = getConfig();
  const serverAuthHash = await argon2.hash(input.authHash, {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
    salt: Buffer.from(authSalt, 'hex'),
  });

  const envelopedSymKey = envelopeEncrypt(input.protectedSymmetricKey, authSalt);
  const envelopedPrivKey = envelopeEncrypt(input.encryptedPrivateKey, authSalt);

  const { rows } = await query(
    `INSERT INTO users (
       email, auth_hash, auth_salt,
       protected_symmetric_key, public_key, encrypted_private_key,
       hkdf_salt,
       kdf_type, kdf_iterations, kdf_memory, kdf_parallelism
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.email.toLowerCase(),
      serverAuthHash,
      authSalt,
      envelopedSymKey,
      input.publicKey,
      envelopedPrivKey,
      input.hkdfSalt,
      input.kdfType,
      input.kdfIterations ?? null,
      input.kdfMemory ?? null,
      input.kdfParallelism ?? null,
    ]
  );

  return rows[0].id;
}

export async function verifyLogin(email: string, authHash: string): Promise<LoginResult> {
  const { rows } = await query(
    `SELECT id, email, auth_hash, auth_salt,
            protected_symmetric_key, public_key, encrypted_private_key,
            hkdf_salt,
            kdf_type, kdf_iterations, kdf_memory, kdf_parallelism,
            two_factor_enabled
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  if (rows.length === 0) {
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const user = rows[0];
  const valid = await argon2.verify(user.auth_hash, authHash);
  if (!valid) {
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  return {
    userId: user.id,
    email: user.email,
    protectedSymmetricKey: envelopeDecrypt(user.protected_symmetric_key, user.auth_salt),
    publicKey: user.public_key,
    encryptedPrivateKey: envelopeDecrypt(user.encrypted_private_key, user.auth_salt),
    hkdfSalt: user.hkdf_salt,
    kdfType: user.kdf_type,
    kdfIterations: user.kdf_iterations,
    kdfMemory: user.kdf_memory,
    kdfParallelism: user.kdf_parallelism,
    twoFactorEnabled: user.two_factor_enabled,
  };
}

export async function verify2FA(userId: string, code: string): Promise<boolean> {
  const { rows } = await query(
    'SELECT two_factor_secret, auth_salt FROM users WHERE id = $1',
    [userId]
  );
  if (rows.length === 0 || !rows[0].two_factor_secret) return false;

  const secret = envelopeDecrypt(rows[0].two_factor_secret, rows[0].auth_salt);
  const secretBytes = base32Decode(secret);

  // Check current and +/- 1 time step (to handle clock drift)
  const now = Math.floor(Date.now() / 1000);
  for (const offset of [-1, 0, 1]) {
    const timeStep = Math.floor((now + offset * 30) / 30);
    const expected = generateTOTP(secretBytes, timeStep);
    if (expected === code) return true;
  }
  return false;
}

// I1 Documented Exception: While SHA-256 is increasingly recommended for TOTP, 
// using SHA-1 remains fully compliant with the original RFC 6238 implementation standards
// and most mainstream authenticator apps still default to or exclusively support SHA-1.
function generateTOTP(secretBytes: Buffer, timeStep: number): string {
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(timeStep));
  const hmac = createHmac('sha1', secretBytes).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1000000).toString().padStart(6, '0');
}

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();
  let bits = '';
  for (const char of cleaned) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error('Invalid base32 character');
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export async function changePassword(
  userId: string,
  currentAuthHash: string,
  newAuthHash: string,
  newProtectedSymmetricKey: string,
  kdfType: string,
  kdfIterations?: number,
  kdfMemory?: number,
  kdfParallelism?: number
): Promise<void> {
  // Verify current password before starting transaction
  const { rows } = await query(
    'SELECT auth_hash, auth_salt, encrypted_private_key FROM users WHERE id = $1',
    [userId]
  );
  if (rows.length === 0) throw new AppError(404, 'User not found');

  const valid = await argon2.verify(rows[0].auth_hash, currentAuthHash);
  if (!valid) throw new AppError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');

  const newAuthSalt = randomBytes(32).toString('hex');
  const config = getConfig();
  const newServerHash = await argon2.hash(newAuthHash, {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
    salt: Buffer.from(newAuthSalt, 'hex'),
  });

  const envelopedSymKey = envelopeEncrypt(newProtectedSymmetricKey, newAuthSalt);
  const oldPrivKey = envelopeDecrypt(rows[0].encrypted_private_key, rows[0].auth_salt);
  const envelopedPrivKey = envelopeEncrypt(oldPrivKey, newAuthSalt);

  await transaction(async (client) => {
    await client.query(
      `UPDATE users SET
         auth_hash = $1, auth_salt = $2,
         protected_symmetric_key = $3, encrypted_private_key = $4,
         kdf_type = $5, kdf_iterations = $6, kdf_memory = $7, kdf_parallelism = $8,
         updated_at = NOW()
       WHERE id = $9`,
      [newServerHash, newAuthSalt, envelopedSymKey, envelopedPrivKey,
       kdfType, kdfIterations ?? null, kdfMemory ?? null, kdfParallelism ?? null, userId]
    );

    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  });
}

export async function securityReset(
  userId: string,
  newAuthHash: string,
  newProtectedSymmetricKey: string,
  newPublicKey: string,
  newEncryptedPrivateKey: string,
  reEncryptedVaultItems: Array<{ id: string; encrypted_data: string }>,
  reEncryptedFamilyKeys: Array<{ family_id: string; encrypted_family_key: string }>
): Promise<void> {
  await transaction(async (client) => {
    const newAuthSalt = randomBytes(32).toString('hex');
    const config = getConfig();
    const newServerHash = await argon2.hash(newAuthHash, {
      type: argon2.argon2id,
      memoryCost: config.ARGON2_MEMORY,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
      salt: Buffer.from(newAuthSalt, 'hex'),
    });

    const envelopedSymKey = envelopeEncrypt(newProtectedSymmetricKey, newAuthSalt);
    const envelopedPrivKey = envelopeEncrypt(newEncryptedPrivateKey, newAuthSalt);

    await client.query(
      `UPDATE users SET
         auth_hash = $1, auth_salt = $2,
         protected_symmetric_key = $3, public_key = $4, encrypted_private_key = $5,
         updated_at = NOW()
       WHERE id = $6`,
      [newServerHash, newAuthSalt, envelopedSymKey, newPublicKey, envelopedPrivKey, userId]
    );

    for (const item of reEncryptedVaultItems) {
      await client.query(
        `UPDATE vault_items SET encrypted_data = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [item.encrypted_data, item.id, userId]
      );
    }

    for (const fk of reEncryptedFamilyKeys) {
      await client.query(
        `UPDATE family_members SET encrypted_family_key = $1
         WHERE family_id = $2 AND user_id = $3 AND status = 'active'`,
        [fk.encrypted_family_key, fk.family_id, userId]
      );
    }

    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  });
}
