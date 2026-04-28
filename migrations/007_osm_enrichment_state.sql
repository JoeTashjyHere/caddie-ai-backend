-- OSM batch enrichment state.
--
-- Persists run history and per-course attempts so the batch enricher
-- script (scripts/osm-enrich-batch.js) is fully resumable across:
--   - Render redeploys (ephemeral filesystem)
--   - operator interruption / Ctrl-C
--   - Overpass rate-limit pauses
--   - multi-operator runs from different machines
--
-- The "queue" is computed at run-start from buildCoverageReport(); the
-- attempts table acts as the durable filter that says "skip already-
-- enriched courses". No separate queue table is needed.
--
-- Both tables are additive and idempotent.

CREATE TABLE IF NOT EXISTS osm_enrichment_runs (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ NULL,

  -- 'dry'   = preview only, no writes  (default for safety)
  -- 'apply' = real writes
  mode            TEXT NOT NULL CHECK (mode IN ('dry', 'apply')),

  -- CLI args echoed for audit (limit, max-queries, delay-ms, etc.)
  args_json       JSONB NULL,

  -- Aggregate counters updated as the run progresses
  queue_size      INT NOT NULL DEFAULT 0,
  processed       INT NOT NULL DEFAULT 0,
  succeeded       INT NOT NULL DEFAULT 0,
  failed          INT NOT NULL DEFAULT 0,
  skipped         INT NOT NULL DEFAULT 0,
  total_inserted  INT NOT NULL DEFAULT 0,

  -- Final status: 'running' | 'complete' | 'aborted' | 'rate_limited'
  status          TEXT NOT NULL DEFAULT 'running',
  notes           TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_osm_enrichment_runs_started
  ON osm_enrichment_runs (started_at DESC);

-- Per-course outcomes. One row per (run_id, course_id) attempt.
-- The (course_id, attempted_at) index supports cheap "has this course
-- already been enriched?" lookups across all runs.
CREATE TABLE IF NOT EXISTS osm_enrichment_attempts (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NULL REFERENCES osm_enrichment_runs(run_id) ON DELETE SET NULL,
  course_id     UUID NOT NULL,
  course_name   TEXT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 'success' | 'no_geometry' | 'no_features' | 'duplicate'
  -- 'rate_limited' | 'overpass_error' | 'db_error' | 'failed' | 'skipped'
  status        TEXT NOT NULL,

  -- Coverage delta
  before_score  INT NULL,
  after_score   INT NULL,

  -- Counts from the enricher trace
  proposed      INT NOT NULL DEFAULT 0,
  inserted      INT NOT NULL DEFAULT 0,

  reason        TEXT NULL,
  trace_summary JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_osm_enrichment_attempts_course_time
  ON osm_enrichment_attempts (course_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_osm_enrichment_attempts_run
  ON osm_enrichment_attempts (run_id);

CREATE INDEX IF NOT EXISTS idx_osm_enrichment_attempts_status
  ON osm_enrichment_attempts (status);
