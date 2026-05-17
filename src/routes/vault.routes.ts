import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as vaultService from '../services/vault.service.js';
import { authenticate } from '../middleware/auth.js';
import { sendError } from '../utils/errors.js';

const createItemSchema = z.object({
  encrypted_data: z.string().min(1).max(65536),
  family_id: z.string().uuid().nullish(),
  folder_id: z.string().uuid().nullish(),
});

const updateItemSchema = z.object({
  encrypted_data: z.string().min(1).max(65536),
});

const moveToFamilySchema = z.object({
  family_id: z.string().uuid(),
  encrypted_data: z.string().min(1).max(65536),
});

const moveToPersonalSchema = z.object({
  encrypted_data: z.string().min(1).max(65536),
});

const syncQuerySchema = z.object({
  since: z.string().optional(),
});

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // All vault routes require authentication
  app.addHook('preHandler', authenticate);

  // GET /api/vault/sync?since=<ISO timestamp>
  app.get('/api/vault/sync', async (request, reply) => {
    try {
      const q = syncQuerySchema.parse(request.query);
      const result = await vaultService.syncItems(request.userId!, q.since);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST /api/vault/items
  app.post('/api/vault/items', async (request, reply) => {
    try {
      const body = createItemSchema.parse(request.body);
      const item = await vaultService.createItem(
        request.userId!,
        body.encrypted_data,
        body.family_id ?? undefined,
        body.folder_id ?? undefined
      );
      reply.status(201).send(item);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // PUT /api/vault/items/:id
  app.put('/api/vault/items/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateItemSchema.parse(request.body);
      const item = await vaultService.updateItem(request.userId!, id, body.encrypted_data);
      reply.send(item);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // DELETE /api/vault/items/:id
  app.delete('/api/vault/items/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await vaultService.deleteItem(request.userId!, id);
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST /api/vault/items/:id/move-to-family
  app.post('/api/vault/items/:id/move-to-family', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = moveToFamilySchema.parse(request.body);
      const item = await vaultService.moveToFamily(
        request.userId!,
        id,
        body.family_id,
        body.encrypted_data
      );
      reply.send(item);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST /api/vault/items/:id/move-to-personal
  app.post('/api/vault/items/:id/move-to-personal', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = moveToPersonalSchema.parse(request.body);
      const item = await vaultService.moveToPersonal(
        request.userId!,
        id,
        body.encrypted_data
      );
      reply.send(item);
    } catch (err) {
      sendError(reply, err);
    }
  });
}
