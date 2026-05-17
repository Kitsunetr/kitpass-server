import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { envelopeEncrypt } from '../services/envelope-crypto.js';
import { sendError, AppError } from '../utils/errors.js';

const lockTimeoutSchema = z.object({
  lockTimeoutSeconds: z.number().int().min(0).max(86400),
});

const twoFactorEnableSchema = z.object({
  enabled: z.boolean(),
  secret: z.string().max(512).optional(),    // base32-encoded TOTP secret (when enabling)
  verifyCode: z.string().length(6).optional(), // TOTP code to verify setup
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // PUT /api/settings/lock-timeout
  app.put('/api/settings/lock-timeout', async (request, reply) => {
    try {
      const body = lockTimeoutSchema.parse(request.body);
      await query(
        'UPDATE users SET lock_timeout_seconds = $1, updated_at = NOW() WHERE id = $2',
        [body.lockTimeoutSeconds, request.userId!]
      );
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // PUT /api/settings/2fa
  app.put('/api/settings/2fa', async (request, reply) => {
    try {
      const body = twoFactorEnableSchema.parse(request.body);

      if (body.enabled) {
        // Enabling 2FA: require secret + verification code
        if (!body.secret || !body.verifyCode) {
          throw new AppError(400, 'Secret and verifyCode required when enabling 2FA');
        }

        // Verify the code works before saving
        const { verify2FA: verifyCode } = await import('../services/auth.service.js');
        // Temporarily store secret to verify (use a mock approach)
        const { rows } = await query(
          'SELECT auth_salt FROM users WHERE id = $1',
          [request.userId!]
        );
        const authSalt = rows[0].auth_salt;
        const envelopedSecret = envelopeEncrypt(body.secret, authSalt);

        // Save the secret and enable 2FA
        await query(
          `UPDATE users SET two_factor_secret = $1, two_factor_enabled = true, updated_at = NOW()
           WHERE id = $2`,
          [envelopedSecret, request.userId!]
        );

        // Verify the code against the saved secret
        const valid = await verifyCode(request.userId!, body.verifyCode);
        if (!valid) {
          // Rollback if code doesn't match
          await query(
            `UPDATE users SET two_factor_secret = NULL, two_factor_enabled = false, updated_at = NOW()
             WHERE id = $1`,
            [request.userId!]
          );
          throw new AppError(400, 'Invalid verification code', 'INVALID_2FA_CODE');
        }

        reply.send({ success: true, enabled: true });
      } else {
        // Disabling 2FA
        await query(
          `UPDATE users SET two_factor_secret = NULL, two_factor_enabled = false, updated_at = NOW()
           WHERE id = $1`,
          [request.userId!]
        );
        reply.send({ success: true, enabled: false });
      }
    } catch (err) {
      sendError(reply, err);
    }
  });
}
