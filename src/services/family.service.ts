import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { query, transaction } from '../db/connection.js';
import { AppError } from '../utils/errors.js';

interface Family {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

interface FamilyMember {
  id: string;
  family_id: string;
  user_id: string;
  role: string;
  encrypted_family_key: string | null;
  status: string;
  created_at: string;
  email: string;
  public_key: string;
}

export async function createFamily(
  userId: string,
  encryptedName: string,
  encryptedFamilyKey: string
): Promise<Family> {
  return await transaction(async (client) => {
    const { rows: familyRows } = await client.query<Family>(
      `INSERT INTO families (name, created_by)
       VALUES ($1, $2) RETURNING *`,
      [encryptedName, userId]
    );
    const family = familyRows[0];

    // Add creator as owner with active status
    await client.query(
      `INSERT INTO family_members (family_id, user_id, role, encrypted_family_key, status)
       VALUES ($1, $2, 'owner', $3, 'active')`,
      [family.id, userId, encryptedFamilyKey]
    );

    return family;
  });
}

export async function getMembers(familyId: string): Promise<FamilyMember[]> {
  const { rows } = await query<FamilyMember>(
    `SELECT fm.*, u.email, u.public_key
     FROM family_members fm
     JOIN users u ON u.id = fm.user_id
     WHERE fm.family_id = $1
     ORDER BY fm.created_at ASC`,
    [familyId]
  );
  return rows;
}

export async function createInvite(
  familyId: string,
  createdBy: string,
  role: 'admin' | 'editor' | 'viewer',
  expiresInHours: number = 48
): Promise<{ inviteCode: string }> {
  // Generate random invite code
  const inviteCode = randomBytes(32).toString('hex');
  const codeHash = await argon2.hash(inviteCode, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  await query(
    `INSERT INTO family_invites (family_id, invite_code_hash, role, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [familyId, codeHash, role, expiresAt, createdBy]
  );

  return { inviteCode };
}

export async function joinFamily(
  userId: string,
  inviteCode: string
): Promise<{ familyId: string; role: string }> {
  // Find all non-expired, unused invites and check each
  const { rows: invites } = await query(
    `SELECT id, family_id, invite_code_hash, role
     FROM family_invites
     WHERE used = false AND expires_at > NOW()
     ORDER BY expires_at DESC`
  );

  let matchedInvite: typeof invites[0] | null = null;
  for (const invite of invites) {
    const valid = await argon2.verify(invite.invite_code_hash, inviteCode);
    if (valid) {
      matchedInvite = invite;
      break;
    }
  }

  if (!matchedInvite) {
    throw new AppError(400, 'Invalid or expired invite code', 'INVALID_INVITE');
  }

  // Check if user is already a member
  const { rows: existing } = await query(
    `SELECT id, status FROM family_members
     WHERE family_id = $1 AND user_id = $2`,
    [matchedInvite.family_id, userId]
  );
  if (existing.length > 0 && existing[0].status === 'active') {
    throw new AppError(409, 'Already an active member of this family');
  }

  await transaction(async (client) => {
    // Mark invite as used
    await client.query('UPDATE family_invites SET used = true WHERE id = $1', [matchedInvite!.id]);

    if (existing.length > 0) {
      // Re-activate revoked member
      await client.query(
        `UPDATE family_members SET status = 'pending', role = $1
         WHERE family_id = $2 AND user_id = $3`,
        [matchedInvite!.role, matchedInvite!.family_id, userId]
      );
    } else {
      // Create new pending member
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role, status)
         VALUES ($1, $2, $3, 'pending')`,
        [matchedInvite!.family_id, userId, matchedInvite!.role]
      );
    }
  });

  return { familyId: matchedInvite.family_id, role: matchedInvite.role };
}

export async function leaveFamily(familyId: string, userId: string): Promise<void> {
  const { rows } = await query(
    `SELECT role, status FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId]
  );
  if (rows.length === 0) throw new AppError(404, 'Not a member of this family');
  if (rows[0].role === 'owner') throw new AppError(403, 'Owner cannot leave the family. Transfer ownership or delete it.');

  await query(
    `DELETE FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId]
  );
}

export async function activateMember(
  familyId: string,
  targetUserId: string,
  encryptedFamilyKey: string
): Promise<void> {
  const { rows } = await query(
    `SELECT status FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, targetUserId]
  );
  if (rows.length === 0) throw new AppError(404, 'Member not found');
  if (rows[0].status !== 'pending') {
    throw new AppError(400, 'Member is not in pending status');
  }

  await query(
    `UPDATE family_members SET encrypted_family_key = $1, status = 'active'
     WHERE family_id = $2 AND user_id = $3`,
    [encryptedFamilyKey, familyId, targetUserId]
  );
}

export async function changeMemberRole(
  familyId: string,
  targetUserId: string,
  newRole: string,
  requestingUserId: string
): Promise<void> {
  // Cannot change owner's role
  const { rows: target } = await query(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, targetUserId]
  );
  if (target.length === 0) throw new AppError(404, 'Member not found');
  if (target[0].role === 'owner') throw new AppError(403, 'Cannot change the owner role');

  // Admins cannot change other admins or promote to owner
  const { rows: requester } = await query(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, requestingUserId]
  );
  if (requester[0].role === 'admin' && (target[0].role === 'admin' || newRole === 'owner')) {
    throw new AppError(403, 'Admins cannot modify other admins or assign owner role');
  }

  await query(
    `UPDATE family_members SET role = $1 WHERE family_id = $2 AND user_id = $3`,
    [newRole, familyId, targetUserId]
  );
}

export async function removeMember(
  familyId: string,
  targetUserId: string,
  reEncryptedItems: Array<{ id: string; encrypted_data: string }>,
  newMemberKeys: Array<{ user_id: string; encrypted_family_key: string }>
): Promise<void> {
  await transaction(async (client) => {
    // Revoke the member
    await client.query(
      `UPDATE family_members SET status = 'revoked', encrypted_family_key = NULL
       WHERE family_id = $1 AND user_id = $2`,
      [familyId, targetUserId]
    );

    // Replace all family vault items with re-encrypted versions (new family key)
    for (const item of reEncryptedItems) {
      await client.query(
        `UPDATE vault_items SET encrypted_data = $1, updated_at = NOW()
         WHERE id = $2 AND family_id = $3`,
        [item.encrypted_data, item.id, familyId]
      );
    }

    // Replace encrypted family key for all remaining active members
    for (const mk of newMemberKeys) {
      await client.query(
        `UPDATE family_members SET encrypted_family_key = $1
         WHERE family_id = $2 AND user_id = $3 AND status = 'active'`,
        [mk.encrypted_family_key, mk.user_id, familyId]
      );
    }
  });
}

export async function deleteFamily(familyId: string, ownerId: string): Promise<void> {
  // Verify requester is the owner
  const { rows } = await query(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, ownerId]
  );
  if (rows.length === 0 || rows[0].role !== 'owner') {
    throw new AppError(403, 'Only the owner can delete a family');
  }

  await transaction(async (client) => {
    // Delete all family vault items
    await client.query('DELETE FROM vault_items WHERE family_id = $1', [familyId]);
    // Delete family folders
    await client.query('DELETE FROM folders WHERE family_id = $1', [familyId]);
    // family_members and family_invites cascade from families
    await client.query('DELETE FROM families WHERE id = $1', [familyId]);
  });
}

export async function getUserFamilies(userId: string): Promise<Array<{
  id: string;
  encrypted_name: string;
  role: string;
  status: string;
  member_count: number;
  created_by_email: string;
}>> {
  const { rows } = await query(
    `SELECT f.id, f.name AS encrypted_name, fm.role, fm.status,
            (SELECT COUNT(*)::int FROM family_members fm2
             WHERE fm2.family_id = f.id AND fm2.status = 'active') AS member_count,
            u.email AS created_by_email
     FROM family_members fm
     JOIN families f ON f.id = fm.family_id
     JOIN users u ON u.id = f.created_by
     WHERE fm.user_id = $1 AND fm.status IN ('active', 'pending')
     ORDER BY fm.created_at ASC`,
    [userId]
  );
  return rows;
}
