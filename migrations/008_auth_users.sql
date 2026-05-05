-- 008_auth_users.sql
-- True user accounts and authentication.
-- Creates: users, user_identities, email_credentials, auth_revoked_tokens.
-- Designed so existing local-only "caddie_user_id" anonymous users can be
-- linked into authenticated accounts without losing their analytics/history.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name          TEXT,
  email                 TEXT UNIQUE,
  phone                 TEXT,
  anonymous_user_id     TEXT UNIQUE,
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_anon
  ON users (anonymous_user_id)
  WHERE anonymous_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_identities (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL CHECK (provider IN ('apple','google','email')),
  provider_user_id      TEXT NOT NULL,
  email                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_identities_user
  ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS email_credentials (
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash         TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stateless JWT model with a small revocation/blacklist table for sign-out
-- of long-lived tokens (Keychain may persist them past a deliberate sign-out).
CREATE TABLE IF NOT EXISTS auth_revoked_tokens (
  jti                   TEXT PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_expires
  ON auth_revoked_tokens (expires_at);

INSERT INTO schema_migrations (name)
  VALUES ('008_auth_users')
  ON CONFLICT DO NOTHING;

COMMIT;
