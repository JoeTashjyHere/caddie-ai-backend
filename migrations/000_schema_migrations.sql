-- Migration tracking: run first, creates table for idempotent migration execution.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);
