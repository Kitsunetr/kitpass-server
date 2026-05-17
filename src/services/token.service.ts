import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';
import { query, transaction } from '../db/connection.js';

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // user_id
  email: string;
}

function getJwtKey(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

export async function signAccessToken(userId: string, email: string): Promise<string> {
  const config = getConfig();
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_EXPIRY}s`)
    .sign(getJwtKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getJwtKey(), {
    algorithms: ['HS256'],
  });
  return payload as AccessTokenPayload;
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  refreshToken: string,
  deviceInfo?: string
): Promise<void> {
  const config = getConfig();
  const hash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY * 1000);

  // Enforce max 10 sessions limit
  const { rows } = await query(
    'SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  if (rows.length >= 10) {
    const toDelete = rows.slice(9).map((r: any) => r.id);
    await query(`DELETE FROM sessions WHERE id = ANY($1)`, [toDelete]);
  }

  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash, deviceInfo ?? null, expiresAt]
  );
}

export async function rotateRefreshToken(
  oldToken: string,
  deviceInfo?: string
): Promise<{ userId: string; email: string; newRefreshToken: string } | null> {
  const oldHash = hashRefreshToken(oldToken);

  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.id, s.user_id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1 AND s.expires_at > NOW()`,
      [oldHash]
    );
    if (rows.length === 0) return null;

    const { id: sessionId, user_id: userId, email } = rows[0];

    // Delete old session
    await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    // Create new session within the same transaction
    const config = getConfig();
    const newRefreshToken = generateRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY * 1000);
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, newHash, deviceInfo ?? null, expiresAt]
    );

    return { userId, email, newRefreshToken };
  });
}

export async function deleteSession(refreshToken: string): Promise<boolean> {
  const hash = hashRefreshToken(refreshToken);
  const { rowCount } = await query(
    'DELETE FROM sessions WHERE refresh_token_hash = $1',
    [hash]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function getUserSessions(userId: string): Promise<any[]> {
  const { rows } = await query(
    'SELECT id, device_info, created_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

export async function deleteUserSession(userId: string, sessionId: string): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return (rowCount ?? 0) > 0;
}
