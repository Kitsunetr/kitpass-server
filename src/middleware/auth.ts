import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../services/token.service.js';

// Extend FastifyRequest to carry authenticated user info
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    request.userId = payload.sub!;
    request.userEmail = payload.email;
  } catch {
    reply.status(401).send({ error: 'Invalid or expired access token' });
    return;
  }
}
