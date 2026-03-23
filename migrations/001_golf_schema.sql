-- Caddie.AI Week 1 Golf Intelligence Schema
-- Requires PostGIS and pg_trgm extensions.
-- Run: psql $DATABASE_URL -f migrations/001_golf_schema.sql

-- Extensions (required)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. golf_clubs - physical venue from clubs.csv
CREATE TABLE IF NOT EXISTS golf_clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  postal_code TEXT,
  state TEXT,
  country TEXT DEFAULT 'USA',
  website TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  location GEOGRAPHY(POINT, 4326),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_golf_clubs_club_id ON golf_clubs(club_id);
CREATE INDEX IF NOT EXISTS idx_golf_clubs_name_trgm ON golf_clubs USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_golf_clubs_location ON golf_clubs USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_golf_clubs_city_state ON golf_clubs(city, state);

-- 2. golf_courses - course layout at a club, from courses.csv
CREATE TABLE IF NOT EXISTS golf_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT UNIQUE NOT NULL,
  long_course_id TEXT,
  club_id UUID NOT NULL REFERENCES golf_clubs(id) ON DELETE CASCADE,
  course_name TEXT NOT NULL,
  num_holes INT NOT NULL CHECK (num_holes IN (9, 18)),
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  location GEOGRAPHY(POINT, 4326),
  updated_source_timestamp BIGINT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_golf_courses_course_id ON golf_courses(course_id);
CREATE INDEX IF NOT EXISTS idx_golf_courses_club_id ON golf_courses(club_id);
CREATE INDEX IF NOT EXISTS idx_golf_courses_name_trgm ON golf_courses USING gin(course_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_golf_courses_location ON golf_courses USING GIST(location);

-- 3. golf_course_holes - par, handicap per hole, from courses.csv (Par1..Par18, Hcp1..Hcp18)
CREATE TABLE IF NOT EXISTS golf_course_holes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES golf_courses(id) ON DELETE CASCADE,
  hole_number INT NOT NULL CHECK (hole_number BETWEEN 1 AND 18),
  par INT NOT NULL CHECK (par BETWEEN 3 AND 6),
  handicap INT CHECK (handicap BETWEEN 1 AND 18),
  match_index INT,
  split_index INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(course_id, hole_number)
);

CREATE INDEX IF NOT EXISTS idx_golf_course_holes_course_id ON golf_course_holes(course_id);
CREATE INDEX IF NOT EXISTS idx_golf_course_holes_course_number ON golf_course_holes(course_id, hole_number);

-- 4. golf_tees - tee sets per course, from tees.csv
CREATE TABLE IF NOT EXISTS golf_tees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tees_id TEXT UNIQUE NOT NULL,
  course_id UUID NOT NULL REFERENCES golf_courses(id) ON DELETE CASCADE,
  tee_name TEXT NOT NULL,
  tee_color TEXT,
  slope INT,
  slope_front INT,
  slope_back INT,
  course_rating DECIMAL(5,2),
  course_rating_front DECIMAL(5,2),
  course_rating_back DECIMAL(5,2),
  women_slope INT,
  women_slope_front INT,
  women_slope_back INT,
  women_course_rating DECIMAL(5,2),
  women_course_rating_front DECIMAL(5,2),
  women_course_rating_back DECIMAL(5,2),
  measurement_unit TEXT CHECK (measurement_unit IN ('m', 'y')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_golf_tees_tees_id ON golf_tees(tees_id);
CREATE INDEX IF NOT EXISTS idx_golf_tees_course_id ON golf_tees(course_id);

-- 5. golf_tee_hole_lengths - yardage per tee per hole, from tees.csv Length1..Length18
CREATE TABLE IF NOT EXISTS golf_tee_hole_lengths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tees_id UUID NOT NULL REFERENCES golf_tees(id) ON DELETE CASCADE,
  hole_number INT NOT NULL CHECK (hole_number BETWEEN 1 AND 18),
  length INT NOT NULL CHECK (length >= 0),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tees_id, hole_number)
);

CREATE INDEX IF NOT EXISTS idx_golf_tee_hole_lengths_tees_id ON golf_tee_hole_lengths(tees_id);
CREATE INDEX IF NOT EXISTS idx_golf_tee_hole_lengths_tees_hole ON golf_tee_hole_lengths(tees_id, hole_number);

-- 6. golf_hole_pois - POI geometry from coordinates.csv (CourseID, Hole, POI, Location, etc.)
-- Note: coordinates.csv uses CourseID (not ClubID). POIs are per course.
CREATE TABLE IF NOT EXISTS golf_hole_pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES golf_courses(id) ON DELETE CASCADE,
  hole_number INT NOT NULL CHECK (hole_number BETWEEN 1 AND 18),
  poi_type TEXT NOT NULL,
  location_label TEXT,
  fairway_side TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  location GEOGRAPHY(POINT, 4326),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_golf_hole_pois_course_id ON golf_hole_pois(course_id);
CREATE INDEX IF NOT EXISTS idx_golf_hole_pois_course_hole ON golf_hole_pois(course_id, hole_number);
CREATE INDEX IF NOT EXISTS idx_golf_hole_pois_location ON golf_hole_pois USING GIST(location);

-- 7. course_place_mappings - Google Place ID -> golf_courses
CREATE TABLE IF NOT EXISTS course_place_mappings (
  google_place_id TEXT PRIMARY KEY,
  golf_course_uuid UUID NOT NULL REFERENCES golf_courses(id) ON DELETE CASCADE,
  confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  matched_at TIMESTAMPTZ DEFAULT now(),
  source TEXT DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS idx_course_place_mappings_golf_course ON course_place_mappings(golf_course_uuid);

-- golf_courses.location is populated during ingestion (club lat/lon or centroid of green POIs)
