-- Structured shot outcome capture.
--
-- Cross-device, durable record of what actually happened on the shot vs. what was recommended.
-- Drives:
--   - per-player learning (miss patterns, club volatility)
--   - admin / founder analytics (most common miss direction, club mismatch %, success rate)
--   - future recommendation personalization (deterministic ShotDecisionEngine signals)
--
-- Design notes:
--   * One outcome per recommendation: UNIQUE (recommendation_id) enables clean upsert when
--     the user re-taps to correct themselves.
--   * No FK to recommendation_events — outcomes and recommendation events are POSTed
--     independently from the client and may race; we tolerate transient orphans.
--   * round_id stays plain TEXT for now (no rounds table yet); upgradeable to FK later.

CREATE TABLE IF NOT EXISTS shot_outcomes (
  id                TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  user_id           TEXT,
  round_id          TEXT,
  course_id         TEXT,
  hole_number       INTEGER,
  hole_par          INTEGER,
  tee_set_id        TEXT,
  club_used         TEXT,
  intended_shot     TEXT,
  shot_result       TEXT NOT NULL,
  miss_direction    TEXT,
  success           BOOLEAN NOT NULL,
  distance_yards    INTEGER,
  recorded_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shot_outcomes_recommendation_unique UNIQUE (recommendation_id)
);

CREATE INDEX IF NOT EXISTS shot_outcomes_user_idx        ON shot_outcomes (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS shot_outcomes_round_idx       ON shot_outcomes (round_id);
CREATE INDEX IF NOT EXISTS shot_outcomes_course_hole_idx ON shot_outcomes (course_id, hole_number);
CREATE INDEX IF NOT EXISTS shot_outcomes_club_idx        ON shot_outcomes (club_used);
