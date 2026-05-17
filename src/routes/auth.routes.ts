import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as authService from '../services/auth.service.js';
import * as tokenService from '../services/token.service.js';
import { sendError, AppError } from '../utils/errors.js';
import { authenticate } from '../middleware/auth.js';

const registerSchema = z.object({
  email: z.string().email().max(255),
  authHash: z.string().min(1).max(512),
  protectedSymmetricKey: z.string().min(1).max(8192),
  publicKey: z.string().min(1).max(4096),
  encryptedPrivateKey: z.string().min(1).max(16384),
  hkdfSalt: z.string().length(64),
  kdfType: z.enum(['argon2id', 'pbkdf2']),
  kdfIterations: z.number().int().optional(),
  kdfMemory: z.number().int().optional(),
  kdfParallelism: z.number().int().optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  authHash: z.string().min(1).max(512),
  deviceInfo: z.string().max(512).optional(),
});

const twoFactorSchema = z.object({
  tempToken: z.string().min(1).max(2048),
  code: z.string().length(6),
  deviceInfo: z.string().max(512).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
  deviceInfo: z.string().max(512).optional(),
});

const changePasswordSchema = z.object({
  currentAuthHash: z.string().min(1).max(512),
  newAuthHash: z.string().min(1).max(512),
  newProtectedSymmetricKey: z.string().min(1).max(8192),
  kdfType: z.enum(['argon2id', 'pbkdf2']),
  kdfIterations: z.number().int().optional(),
  kdfMemory: z.number().int().optional(),
  kdfParallelism: z.number().int().optional(),
});

const securityResetSchema = z.object({
  newAuthHash: z.string().min(1).max(512),
  newProtectedSymmetricKey: z.string().min(1).max(8192),
  newPublicKey: z.string().min(1).max(4096),
  newEncryptedPrivateKey: z.string().min(1).max(16384),
  reEncryptedVaultItems: z.array(z.object({
    id: z.string().uuid(),
    encrypted_data: z.string().min(1).max(65536),
  })),
  reEncryptedFamilyKeys: z.array(z.object({
    family_id: z.string().uuid(),
    encrypted_family_key: z.string().min(1).max(8192),
  })),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      const userId = await authService.register(body);
      const accessToken = await tokenService.signAccessToken(userId, body.email);
      const refreshToken = tokenService.generateRefreshToken();
      await tokenService.createSession(userId, refreshToken);
      reply.status(201).send({ accessToken, refreshToken });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const result = await authService.verifyLogin(body.email, body.authHash);

      if (result.twoFactorEnabled) {
        const tempToken = await tokenService.signAccessToken(result.userId, result.email);
        reply.send({ requiresTwoFactor: true, tempToken });
        return;
      }

      const accessToken = await tokenService.signAccessToken(result.userId, result.email);
      const refreshToken = tokenService.generateRefreshToken();
      await tokenService.createSession(result.userId, refreshToken, body.deviceInfo);

      reply.send({
        accessToken,
        refreshToken,
        protectedSymmetricKey: result.protectedSymmetricKey,
        publicKey: result.publicKey,
        encryptedPrivateKey: result.encryptedPrivateKey,
        hkdfSalt: result.hkdfSalt,
        kdfType: result.kdfType,
        kdfIterations: result.kdfIterations,
        kdfMemory: result.kdfMemory,
        kdfParallelism: result.kdfParallelism,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/login/2fa', async (request, reply) => {
    try {
      const body = twoFactorSchema.parse(request.body);
      const payload = await tokenService.verifyAccessToken(body.tempToken);
      const userId = payload.sub!;
      const email = payload.email;

      const valid = await authService.verify2FA(userId, body.code);
      if (!valid) {
        throw new AppError(401, 'Invalid 2FA code', 'INVALID_2FA');
      }

      const { rows } = await (await import('../db/connection.js')).query(
        `SELECT protected_symmetric_key, public_key, encrypted_private_key,
                auth_salt, hkdf_salt, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism
         FROM users WHERE id = $1`,
        [userId]
      );
      const user = rows[0];
      const { envelopeDecrypt } = await import('../services/envelope-crypto.js');

      const accessToken = await tokenService.signAccessToken(userId, email);
      const refreshToken = tokenService.generateRefreshToken();
      await tokenService.createSession(userId, refreshToken, body.deviceInfo);

      reply.send({
        accessToken,
        refreshToken,
        protectedSymmetricKey: envelopeDecrypt(user.protected_symmetric_key, user.auth_salt),
        publicKey: user.public_key,
        encryptedPrivateKey: envelopeDecrypt(user.encrypted_private_key, user.auth_salt),
        hkdfSalt: user.hkdf_salt,
        kdfType: user.kdf_type,
        kdfIterations: user.kdf_iterations,
        kdfMemory: user.kdf_memory,
        kdfParallelism: user.kdf_parallelism,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    try {
      const body = refreshSchema.parse(request.body);
      const result = await tokenService.rotateRefreshToken(body.refreshToken, body.deviceInfo);
      if (!result) {
        throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
      }
      const accessToken = await tokenService.signAccessToken(result.userId, result.email);
      reply.send({ accessToken, refreshToken: result.newRefreshToken });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/change-password', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const body = changePasswordSchema.parse(request.body);
      await authService.changePassword(
        request.userId!,
        body.currentAuthHash,
        body.newAuthHash,
        body.newProtectedSymmetricKey,
        body.kdfType,
        body.kdfIterations,
        body.kdfMemory,
        body.kdfParallelism
      );
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/security-reset', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const body = securityResetSchema.parse(request.body);
      await authService.securityReset(
        request.userId!,
        body.newAuthHash,
        body.newProtectedSymmetricKey,
        body.newPublicKey,
        body.newEncryptedPrivateKey,
        body.reEncryptedVaultItems,
        body.reEncryptedFamilyKeys
      );
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    try {
      const body = logoutSchema.parse(request.body);
      await tokenService.deleteSession(body.refreshToken);
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get('/api/auth/sessions', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const sessions = await tokenService.getUserSessions(request.userId!);
      reply.send({ sessions });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete('/api/auth/sessions/:id', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const success = await tokenService.deleteUserSession(request.userId!, id);
      if (!success) throw new AppError(404, 'Session not found', 'NOT_FOUND');
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
