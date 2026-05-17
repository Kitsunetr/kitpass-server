import { query } from '../db/connection.js';
import { AppError } from '../utils/errors.js';

interface VaultItem {
  id: string;
  user_id: string;
  family_id: string | null;
  folder_id: string | null;
  encrypted_data: string;
  created_at: string;
  updated_at: string;
}

interface FamilyKey {
  family_id: string;
  encrypted_family_key: string;
}

interface SyncResult {
  items: VaultItem[];
  familyKeys: FamilyKey[];
  serverTime: string;
}

/**
 * Fetch items modified since the given timestamp.
 * Returns personal items + items from families the user is an active member of.
 * Also returns encrypted family keys for all active memberships.
 */
export async function syncItems(userId: string, since?: string): Promise<SyncResult> {
  // Handle both ISO strings and numeric (millisecond) timestamps
  let sinceDate: Date;
  if (!since || since === '0') {
    sinceDate = new Date(0);
  } else {
    const asNum = Number(since);
    sinceDate = !isNaN(asNum) ? new Date(asNum) : new Date(since);
    if (isNaN(sinceDate.getTime())) sinceDate = new Date(0);
  }

  const { rows: items } = await query<VaultItem>(
    `SELECT vi.id, vi.user_id, vi.family_id, vi.folder_id,
            vi.encrypted_data, vi.created_at, vi.updated_at
     FROM vault_items vi
     WHERE vi.updated_at > $1
       AND (
         (vi.family_id IS NULL AND vi.user_id = $2)
         OR
         (vi.family_id IN (
           SELECT fm.family_id FROM family_members fm
           WHERE fm.user_id = $2 AND fm.status = 'active'
         ))
       )
     ORDER BY vi.updated_at ASC`,
    [sinceDate.toISOString(), userId]
  );

  const { rows: familyKeys } = await query<FamilyKey>(
    `SELECT family_id, encrypted_family_key
     FROM family_members
     WHERE user_id = $1 AND status = 'active' AND encrypted_family_key IS NOT NULL`,
    [userId]
  );

  // Return server time so client can use it for next sync (avoids clock skew)
  return { items, familyKeys, serverTime: new Date().toISOString() };
}

export async function createItem(
  userId: string,
  encryptedData: string,
  familyId?: string,
  folderId?: string
): Promise<VaultItem> {
  // If family item, verify the user is an active member with at least editor role
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
      throw new AppError(403, 'Viewers cannot add items');
    }
  }

  const { rows } = await query<VaultItem>(
    `INSERT INTO vault_items (user_id, family_id, folder_id, encrypted_data)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, familyId ?? null, folderId ?? null, encryptedData]
  );
  return rows[0];
}

export async function updateItem(
  userId: string,
  itemId: string,
  encryptedData: string
): Promise<VaultItem> {
  // Fetch item to check ownership/family membership
  const { rows: existing } = await query<VaultItem>(
    'SELECT * FROM vault_items WHERE id = $1',
    [itemId]
  );
  if (existing.length === 0) throw new AppError(404, 'Item not found');

  const item = existing[0];

  if (item.family_id) {
    // Family item: check membership + at least editor role
    const { rows: membership } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [item.family_id, userId]
    );
    if (membership.length === 0 || membership[0].status !== 'active') {
      throw new AppError(403, 'Not an active family member');
    }
    if (membership[0].role === 'viewer') {
      throw new AppError(403, 'Viewers cannot edit items');
    }
  } else if (item.user_id !== userId) {
    throw new AppError(403, 'Not the owner of this item');
  }

  const { rows } = await query<VaultItem>(
    `UPDATE vault_items SET encrypted_data = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [encryptedData, itemId]
  );
  return rows[0];
}

export async function deleteItem(userId: string, itemId: string): Promise<void> {
  const { rows: existing } = await query<VaultItem>(
    'SELECT * FROM vault_items WHERE id = $1',
    [itemId]
  );
  if (existing.length === 0) throw new AppError(404, 'Item not found');

  const item = existing[0];

  if (item.family_id) {
    // Family item: only owner or admin can delete
    const { rows: membership } = await query(
      `SELECT role, status FROM family_members
       WHERE family_id = $1 AND user_id = $2`,
      [item.family_id, userId]
    );
    if (membership.length === 0 || membership[0].status !== 'active') {
      throw new AppError(403, 'Not an active family member');
    }
    if (!['owner', 'admin'].includes(membership[0].role)) {
      throw new AppError(403, 'Only owners and admins can delete family items');
    }
  } else if (item.user_id !== userId) {
    throw new AppError(403, 'Not the owner of this item');
  }

  await query('DELETE FROM vault_items WHERE id = $1', [itemId]);
}

export async function moveToFamily(
  userId: string,
  itemId: string,
  familyId: string,
  encryptedData: string
): Promise<VaultItem> {
  // Verify item is personal and owned by user
  const { rows: existing } = await query<VaultItem>(
    'SELECT * FROM vault_items WHERE id = $1',
    [itemId]
  );
  if (existing.length === 0) throw new AppError(404, 'Item not found');
  if (existing[0].user_id !== userId) throw new AppError(403, 'Not the owner');
  if (existing[0].family_id) throw new AppError(400, 'Item is already in a family');

  // Verify user is active member with at least editor role
  const { rows: membership } = await query(
    `SELECT role, status FROM family_members
     WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId]
  );
  if (membership.length === 0 || membership[0].status !== 'active') {
    throw new AppError(403, 'Not an active family member');
  }
  if (membership[0].role === 'viewer') {
    throw new AppError(403, 'Viewers cannot move items to family');
  }

  const { rows } = await query<VaultItem>(
    `UPDATE vault_items SET family_id = $1, encrypted_data = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [familyId, encryptedData, itemId]
  );
  return rows[0];
}

export async function moveToPersonal(
  userId: string,
  itemId: string,
  encryptedData: string
): Promise<VaultItem> {
  const { rows: existing } = await query<VaultItem>(
    'SELECT * FROM vault_items WHERE id = $1',
    [itemId]
  );
  if (existing.length === 0) throw new AppError(404, 'Item not found');
  if (existing[0].user_id !== userId) throw new AppError(403, 'Not the owner');
  if (!existing[0].family_id) throw new AppError(400, 'Item is not in a family');

  const { rows } = await query<VaultItem>(
    `UPDATE vault_items SET family_id = NULL, encrypted_data = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [encryptedData, itemId]
  );
  return rows[0];
}
