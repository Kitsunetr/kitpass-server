import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as familyService from '../services/family.service.js';
import { authenticate } from '../middleware/auth.js';
import { requireFamilyRole } from '../middleware/family-role.js';
import { sendError } from '../utils/errors.js';

const createFamilySchema = z.object({
  encryptedName: z.string().min(1).max(4096),
  encryptedFamilyKey: z.string().min(1).max(8192),
});

const inviteSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']),
  expiresInHours: z.number().int().min(1).max(168).default(48),
});

const joinSchema = z.object({
  inviteCode: z.string().min(1).max(256),
});

const activateSchema = z.object({
  encryptedFamilyKey: z.string().min(1).max(8192),
});

const changeRoleSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']),
});

const removeMemberSchema = z.object({
  reEncryptedItems: z.array(z.object({
    id: z.string().uuid(),
    encrypted_data: z.string().min(1).max(65536),
  })),
  newMemberKeys: z.array(z.object({
    user_id: z.string().uuid(),
    encrypted_family_key: z.string().min(1).max(8192),
  })),
});

export async function familyRoutes(app: FastifyInstance): Promise<void> {
  // All family routes require authentication
  app.addHook('preHandler', authenticate);

  // POST /api/family -- create a new family
  app.post('/api/family', async (request, reply) => {
    try {
      const body = createFamilySchema.parse(request.body);
      const family = await familyService.createFamily(
        request.userId!,
        body.encryptedName,
        body.encryptedFamilyKey
      );
      reply.status(201).send(family);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // GET /api/family/mine -- list all families the user belongs to
  app.get('/api/family/mine', async (request, reply) => {
    try {
      const families = await familyService.getUserFamilies(request.userId!);
      reply.send({ families });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // GET /api/family/:id/members -- list members
  app.get(
    '/api/family/:id/members',
    { preHandler: [requireFamilyRole('viewer')] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const members = await familyService.getMembers(id);
        reply.send({ members });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // POST /api/family/:id/invite -- generate invite
  app.post(
    '/api/family/:id/invite',
    { preHandler: [requireFamilyRole('admin')] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = inviteSchema.parse(request.body);
        const result = await familyService.createInvite(
          id,
          request.userId!,
          body.role,
          body.expiresInHours
        );
        reply.status(201).send(result);
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // POST /api/family/join -- redeem invite code
  app.post('/api/family/join', async (request, reply) => {
    try {
      const body = joinSchema.parse(request.body);
      const result = await familyService.joinFamily(request.userId!, body.inviteCode);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // POST /api/family/:id/leave -- leave a family (non-owners)
  app.post(
    '/api/family/:id/leave',
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await familyService.leaveFamily(id, request.userId!);
        reply.send({ success: true });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // POST /api/family/:id/members/:uid/activate -- send encrypted family key to pending member
  app.post(
    '/api/family/:id/members/:uid/activate',
    { preHandler: [requireFamilyRole('admin')] },
    async (request, reply) => {
      try {
        const { id, uid } = request.params as { id: string; uid: string };
        const body = activateSchema.parse(request.body);
        await familyService.activateMember(id, uid, body.encryptedFamilyKey);
        reply.send({ success: true });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // PUT /api/family/:id/members/:uid -- change member role
  app.put(
    '/api/family/:id/members/:uid',
    { preHandler: [requireFamilyRole('admin')] },
    async (request, reply) => {
      try {
        const { id, uid } = request.params as { id: string; uid: string };
        const body = changeRoleSchema.parse(request.body);
        await familyService.changeMemberRole(id, uid, body.role, request.userId!);
        reply.send({ success: true });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // DELETE /api/family/:id/members/:uid -- remove member (with key rotation data)
  app.delete(
    '/api/family/:id/members/:uid',
    { preHandler: [requireFamilyRole('admin')] },
    async (request, reply) => {
      try {
        const { id, uid } = request.params as { id: string; uid: string };
        const body = removeMemberSchema.parse(request.body);
        await familyService.removeMember(id, uid, body.reEncryptedItems, body.newMemberKeys);
        reply.send({ success: true });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );

  // DELETE /api/family/:id -- delete family (owner only)
  app.delete(
    '/api/family/:id',
    { preHandler: [requireFamilyRole('owner')] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await familyService.deleteFamily(id, request.userId!);
        reply.send({ success: true });
      } catch (err) {
        sendError(reply, err);
      }
    }
  );
}
