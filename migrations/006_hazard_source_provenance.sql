-- Hazard provenance: track where each POI came from so OSM-enriched data
-- never silently overrides trusted source-CSV data.
--
-- source_type values:
--   source_native          - original CSV ingest (default)
--   source_osm             - enriched from OpenStreetMap
--   source_user_reported   - user-flagged via app feedback (future)
--   source_admin_verified  - manually curated by admin (future)
--
-- All columns are additive and nullable except source_type which defaults
-- to 'source_native' so every existing row is correctly attributed.

ALTER TABLE golf_hole_pois
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'source_native';

ALTER TABLE golf_hole_pois
  ADD COLUMN IF NOT EXISTS confidence REAL NULL;

-- OSM identifier (way/relation/node id, e.g. "way/123456789").
-- Non-unique by itself: a single OSM way can legitimately straddle multiple
-- holes. Uniqueness is enforced by (course_id, hole_number, osm_id) below.
ALTER TABLE golf_hole_pois
  ADD COLUMN IF NOT EXISTS osm_id TEXT NULL;

-- Raw OSM tags so future re-classification can re-derive normalized_type
-- without refetching from Overpass.
ALTER TABLE golf_hole_pois
  ADD COLUMN IF NOT EXISTS osm_tags JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_golf_hole_pois_source_type
  ON golf_hole_pois (source_type);

-- Prevent re-importing the same OSM feature into the same hole twice.
-- Partial unique index — only enforced when osm_id is set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_golf_hole_pois_osm_unique
  ON golf_hole_pois (course_id, hole_number, osm_id)
  WHERE osm_id IS NOT NULL;
