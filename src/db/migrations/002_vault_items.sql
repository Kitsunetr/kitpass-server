CREATE TABLE vault_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      UUID,
  folder_id      UUID,
  encrypted_data TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vault_items_user_id ON vault_items (user_id);
CREATE INDEX idx_vault_items_family_id ON vault_items (family_id) WHERE family_id IS NOT NULL;
CREATE INDEX idx_vault_items_updated_at ON vault_items (updated_at);
