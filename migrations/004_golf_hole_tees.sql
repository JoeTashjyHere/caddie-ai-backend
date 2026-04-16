-- Per-tee-set per-hole coordinates.
-- Each tee set (Black, Blue, White, etc.) gets its own GPS coordinate per hole,
-- enabling accurate map orientation, hazard computation, and shot modeling.
--
-- Coordinates are synthesized from:
--   1. Generic tee POIs (Tee Front / Tee Back) from golf_hole_pois
--   2. Per-tee yardage from golf_tee_hole_lengths
--   3. Green center from golf_hole_pois
--   4. Bearing + yardage interpolation along the tee→green axis

CREATE TABLE IF NOT EXISTS golf_hole_tees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES golf_courses(id) ON DELETE CASCADE,
  hole_number INT NOT NULL CHECK (hole_number BETWEEN 1 AND 18),
  tee_set_id UUID NOT NULL REFERENCES golf_tees(id) ON DELETE CASCADE,
  tee_name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  location GEOGRAPHY(POINT, 4326),
  yardage INT NOT NULL CHECK (yardage >= 0),
  is_synthesized BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(course_id, hole_number, tee_set_id)
);

CREATE INDEX IF NOT EXISTS idx_golf_hole_tees_course_id
  ON golf_hole_tees(course_id);
CREATE INDEX IF NOT EXISTS idx_golf_hole_tees_course_hole
  ON golf_hole_tees(course_id, hole_number);
CREATE INDEX IF NOT EXISTS idx_golf_hole_tees_tee_set
  ON golf_hole_tees(tee_set_id);
