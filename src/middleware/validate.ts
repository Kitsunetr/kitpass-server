import { FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema, ZodError } from 'zod';

export function validateBody(schema: ZodSchema) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      request.body = schema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({
          error: 'Validation failed',
          details: err.issues.map((e) => ({
            path: e.path.map(String).join('.'),
            message: e.message,
          })),
        });
        return;
      }
      throw err;
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      request.query = schema.parse(request.query);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({
          error: 'Invalid query parameters',
          details: err.issues.map((e) => ({
            path: e.path.map(String).join('.'),
            message: e.message,
          })),
        });
        return;
      }
      throw err;
    }
  };
}
