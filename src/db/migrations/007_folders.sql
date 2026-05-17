CREATE TABLE folders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      UUID REFERENCES families(id) ON DELETE CASCADE,
  encrypted_name TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_folders_user_id ON folders (user_id);
CREATE INDEX idx_folders_family_id ON folders (family_id) WHERE family_id IS NOT NULL;

-- Add foreign keys from vault_items that depend on families and folders
ALTER TABLE vault_items
  ADD CONSTRAINT fk_vault_items_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;

ALTER TABLE vault_items
  ADD CONSTRAINT fk_vault_items_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL;
