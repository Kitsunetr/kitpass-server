import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection.js';

type FamilyRole = 'owner' | 'admin' | 'editor' | 'viewer';

const ROLE_HIERARCHY: Record<FamilyRole, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  viewer: 1,
};

export function requireFamilyRole(minimumRole: FamilyRole) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const familyId = (request.params as { id?: string }).id;
    const userId = request.userId;

    if (!familyId || !userId) {
      reply.status(400).send({ error: 'Missing family ID or authentication' });
      return;
    }

    const { rows } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [familyId, userId]
    );

    if (rows.length === 0 || rows[0].status !== 'active') {
      reply.status(403).send({ error: 'Not an active member of this family' });
      return;
    }

    const userRole = rows[0].role as FamilyRole;
    if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minimumRole]) {
      reply.status(403).send({
        error: `Requires ${minimumRole} role or higher`,
        code: 'INSUFFICIENT_ROLE',
      });
      return;
    }

    (request as any).familyRole = userRole;
  };
}
