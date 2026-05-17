CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   VARCHAR(255) UNIQUE NOT NULL,
  auth_hash               VARCHAR(512) NOT NULL,
  auth_salt               VARCHAR(512) NOT NULL,
  protected_symmetric_key VARCHAR(8192) NOT NULL,
  public_key              VARCHAR(4096) NOT NULL,
  encrypted_private_key   VARCHAR(16384) NOT NULL,
  hkdf_salt               VARCHAR(128),
  kdf_type                VARCHAR(20) NOT NULL CHECK (kdf_type IN ('argon2id', 'pbkdf2')),
  kdf_iterations          INTEGER,
  kdf_memory              INTEGER,
  kdf_parallelism         INTEGER,
  two_factor_secret       TEXT,
  two_factor_enabled      BOOLEAN NOT NULL DEFAULT false,
  lock_timeout_seconds    INTEGER NOT NULL DEFAULT 3600,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
