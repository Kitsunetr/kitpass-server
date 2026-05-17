import { query } from '../db/connection.js';
import { AppError } from '../utils/errors.js';

interface Folder {
  id: string;
  user_id: string;
  family_id: string | null;
  encrypted_name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export async function listFolders(userId: string): Promise<Folder[]> {
  const { rows } = await query<Folder>(
    `SELECT f.*
     FROM folders f
     WHERE (f.family_id IS NULL AND f.user_id = $1)
       OR f.family_id IN (
         SELECT fm.family_id FROM family_members fm
         WHERE fm.user_id = $1 AND fm.status = 'active'
       )
     ORDER BY f.sort_order ASC, f.created_at ASC`,
    [userId]
  );
  return rows;
}

export async function createFolder(
  userId: string,
  encryptedName: string,
  familyId?: string,
  sortOrder?: number
): Promise<Folder> {
  if (familyId) {
    const { rows } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [familyId, userId]
    );
    if (rows.length === 0 || rows[0].status !== 'active') {
      throw new AppError(403, 'Not an active family member');
    }
    if (rows[0].role === 'viewer') {
      throw new AppError(403, 'Viewers cannot create folders');
    }
  }

  const { rows } = await query<Folder>(
    `INSERT INTO folders (user_id, family_id, encrypted_name, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, familyId ?? null, encryptedName, sortOrder ?? 0]
  );
  return rows[0];
}

export async function updateFolder(
  userId: string,
  folderId: string,
  encryptedName: string,
  sortOrder?: number
): Promise<Folder> {
  const { rows: existing } = await query<Folder>(
    'SELECT * FROM folders WHERE id = $1',
    [folderId]
  );
  if (existing.length === 0) throw new AppError(404, 'Folder not found');

  const folder = existing[0];
  if (folder.family_id) {
    const { rows } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [folder.family_id, userId]
    );
    if (rows.length === 0 || rows[0].status !== 'active' || rows[0].role === 'viewer') {
      throw new AppError(403, 'Insufficient permissions');
    }
  } else if (folder.user_id !== userId) {
    throw new AppError(403, 'Not the owner of this folder');
  }

  const { rows } = await query<Folder>(
    `UPDATE folders SET encrypted_name = $1, sort_order = COALESCE($2, sort_order), updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [encryptedName, sortOrder ?? null, folderId]
  );
  return rows[0];
}

export async function deleteFolder(userId: string, folderId: string): Promise<void> {
  const { rows: existing } = await query<Folder>(
    'SELECT * FROM folders WHERE id = $1',
    [folderId]
  );
  if (existing.length === 0) throw new AppError(404, 'Folder not found');

  const folder = existing[0];
  if (folder.family_id) {
    const { rows } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [folder.family_id, userId]
    );
    if (rows.length === 0 || rows[0].status !== 'active' || !['owner', 'admin'].includes(rows[0].role)) {
      throw new AppError(403, 'Only owners and admins can delete family folders');
    }
  } else if (folder.user_id !== userId) {
    throw new AppError(403, 'Not the owner of this folder');
  }

  // Unlink items from folder (don't delete the items)
  await query('UPDATE vault_items SET folder_id = NULL WHERE folder_id = $1', [folderId]);
  await query('DELETE FROM folders WHERE id = $1', [folderId]);
}
