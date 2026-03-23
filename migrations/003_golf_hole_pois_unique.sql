-- Idempotent: add unique constraint for golf_hole_pois upsert support.
-- First dedupe (keep one row per course_id, hole_number, lat, lon), then add index.

DELETE FROM golf_hole_pois a
USING golf_hole_pois b
WHERE a.id > b.id
  AND a.course_id = b.course_id
  AND a.hole_number = b.hole_number
  AND a.lat = b.lat
  AND a.lon = b.lon;

CREATE UNIQUE INDEX IF NOT EXISTS idx_golf_hole_pois_unique
  ON golf_hole_pois (course_id, hole_number, lat, lon);
