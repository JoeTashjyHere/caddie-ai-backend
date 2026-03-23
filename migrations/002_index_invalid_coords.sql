-- Optional: Speed up "courses with invalid coordinates" queries
-- Run if Step 6.1 data quality check takes >5 seconds
-- location IS NULL covers: no green POIs + club had 0,0 or null
CREATE INDEX IF NOT EXISTS idx_golf_courses_null_location
  ON golf_courses(id) WHERE location IS NULL;
