import { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: 'Validation error',
      details: error.issues,
    });
    return;
  }
  console.error('Unhandled error:', error);
  reply.status(500).send({ error: 'Internal server error' });
}
