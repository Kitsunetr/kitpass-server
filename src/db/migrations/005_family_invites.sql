CREATE TABLE family_invites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_hash TEXT NOT NULL,
  family_id        UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role             VARCHAR(10) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  expires_at       TIMESTAMPTZ NOT NULL,
  used             BOOLEAN NOT NULL DEFAULT false,
  created_by       UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_family_invites_family_id ON family_invites (family_id);
