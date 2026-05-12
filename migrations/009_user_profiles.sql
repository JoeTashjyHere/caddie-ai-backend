-- 009_user_profiles.sql
-- Profile JSON storage for authenticated users.
--
-- Design rationale (Caddie+ V8.1 — Backend Profile Sync):
--   • We keep `users` clean (auth + identity only). All personalized
--     caddie data (bag, handedness, age, skill, play style, handicap,
--     tendencies, trusted clubs, etc.) lives here under `profile_json`
--     so the iOS schema can evolve without backend migrations every
--     time we add a field.
--   • `user_id` is both PK and FK ON DELETE CASCADE so a hard account
--     delete (DELETE /auth/account) wipes the profile too — matches
--     App Store account-deletion expectations.
--   • The JSON column is `NOT NULL DEFAULT '{}'` so reads always
--     succeed; an empty object is meaningful ("user authenticated but
--     hasn't completed onboarding yet").
--
-- The route layer (`backend/routes/userProfile.js`) is responsible for
-- stripping forbidden fields (`user_id`, `id`, password hashes,
-- session tokens) from the payload before write. Validation is in code
-- because JSONB-side constraints would be brittle as the schema grows.

BEGIN;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GIN index on the JSONB column so future queries like "find users
-- with handedness=left" or "users with handicap < 10" are cheap. Built
-- with `jsonb_path_ops` because we only care about containment
-- queries, not full-key tracking, and it produces a much smaller
-- index than the default opclass.
CREATE INDEX IF NOT EXISTS idx_user_profiles_json
  ON user_profiles USING GIN (profile_json jsonb_path_ops);

INSERT INTO schema_migrations (name)
  VALUES ('009_user_profiles')
  ON CONFLICT DO NOTHING;

COMMIT;
