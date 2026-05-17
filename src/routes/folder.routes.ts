import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as folderService from '../services/folder.service.js';
import { authenticate } from '../middleware/auth.js';
import { sendError } from '../utils/errors.js';

const createFolderSchema = z.object({
  encrypted_name: z.string().min(1).max(4096),
  family_id: z.string().uuid().optional(),
  sort_order: z.number().int().optional(),
});

const updateFolderSchema = z.object({
  encrypted_name: z.string().min(1).max(4096),
  sort_order: z.number().int().optional(),
});

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/folders
  app.get('/api/folders', async (request, reply) => {
    try {
      const folders = await folderService.listFolders(request.userId!);
      reply.send({ folders });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST /api/folders
  app.post('/api/folders', async (request, reply) => {
    try {
      const body = createFolderSchema.parse(request.body);
      const folder = await folderService.createFolder(
        request.userId!,
        body.encrypted_name,
        body.family_id,
        body.sort_order
      );
      reply.status(201).send(folder);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // PUT /api/folders/:id
  app.put('/api/folders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateFolderSchema.parse(request.body);
      const folder = await folderService.updateFolder(
        request.userId!,
        id,
        body.encrypted_name,
        body.sort_order
      );
      reply.send(folder);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // DELETE /api/folders/:id
  app.delete('/api/folders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await folderService.deleteFolder(request.userId!, id);
      reply.send({ success: true });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
