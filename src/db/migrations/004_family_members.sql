CREATE TABLE family_members (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  encrypted_family_key TEXT,
  invited_by           UUID REFERENCES users(id),
  status               VARCHAR(10) NOT NULL CHECK (status IN ('invited', 'pending', 'active', 'revoked')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (family_id, user_id)
);

CREATE INDEX idx_family_members_user_id ON family_members (user_id);
CREATE INDEX idx_family_members_family_id ON family_members (family_id);
