"use strict";

/**
 * osmEnricher.js
 *
 * Additive hazard enrichment from OpenStreetMap.
 *
 * Pipeline per course:
 *   1. Compute course bbox from existing tee/green POIs (+ buffer)
 *   2. Fetch hazard-relevant features from Overpass API
 *   3. Map each OSM feature → Caddie+ canonical category via osmHazardMapper
 *   4. Compute centroid (lat/lon)
 *   5. Project centroid onto each hole's tee→green vector to find the
 *      hole this hazard belongs to (carry within [10y, holeYardage+30y]
 *      AND minimum lateral offset)
 *   6. Skip if a source_native POI of the same coarse category already
 *      exists within DEDUPE_DISTANCE_YARDS  (15y default)
 *   7. INSERT with source_type='source_osm', confidence from mapper,
 *      osm_id, osm_tags. ON CONFLICT DO NOTHING via unique osm index.
 *
 * Modes:
 *   - dryRun: returns the proposed inserts without writing
 *   - apply:  writes with source_type='source_osm'
 *
 * SAFETY:
 *   - Never overwrites source_native data (separate UNIQUE on lat/lon
 *     would block, but we explicitly check).
 *   - All confidence values < 1.0 so the engine and UI can reason about
 *     trust later.
 *   - Overpass is rate-limited; we apply a 60s server timeout and a
 *     small bbox per course so per-course requests stay <10MB.
 */

const fetch = require("node-fetch");
const { mapOsmFeature, featureCenter, yardsBetween } = require("./osmHazardMapper");
const { coarseCategory } = require("./hazardClassifier");

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const DEDUPE_DISTANCE_YARDS = 15;
const BBOX_BUFFER_METERS = 250;

/**
 * Run enrichment for a single course.
 *
 * @param {import("pg").Pool} pool
 * @param {string} courseUuid
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true]
 * @param {number}  [opts.maxFeatures=2000]   safety cap per course
 * @param {function} [opts.fetchFn]           optional injection for tests
 */
async function enrichCourse(pool, courseUuid, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const maxFeatures = opts.maxFeatures || 2000;
  const doFetch = opts.fetchFn || fetch;

  const trace = {
    courseUuid,
    courseName: null,
    dryRun,
    bbox: null,
    holesIndexed: 0,
    osmFeaturesFetched: 0,
    osmFeaturesMapped: 0,
    skippedNoCenter: 0,
    skippedOutsideHoles: 0,
    skippedDuplicateOfNative: 0,
    skippedDuplicateOfOsm: 0,
    inserted: 0,
    insertedByType: {},
    insertedByHole: {},
    proposedRows: []
  };

  // ── Step 1: load course geometry ───────────────────────────────────────
  const meta = await pool.query(
    `SELECT course_name FROM golf_courses WHERE id = $1`, [courseUuid]
  );
  if (meta.rows.length === 0) throw new Error(`Course not found: ${courseUuid}`);
  trace.courseName = meta.rows[0].course_name;

  const holes = await loadHoleGeometry(pool, courseUuid);
  trace.holesIndexed = holes.length;
  if (holes.length === 0) {
    trace.error = "No holes with tee+green geometry — cannot project hazards";
    return trace;
  }

  // ── Step 2: bbox from tees + greens + buffer ───────────────────────────
  const bbox = computeBbox(holes, BBOX_BUFFER_METERS);
  trace.bbox = bbox;

  // ── Step 3: Overpass fetch ─────────────────────────────────────────────
  const features = await fetchHazardFeatures(bbox, doFetch);
  trace.osmFeaturesFetched = features.length;

  // Greens (lat/lon) for greenside-vs-fairway bunker classification
  const greenCenters = holes.map((h) => h.green).filter(Boolean);

  // Existing native hazards for dedup
  const native = await loadNativeHazards(pool, courseUuid);

  // Existing OSM hazards (avoid double-applying enrichment)
  const existingOsm = await loadOsmHazards(pool, courseUuid);
  const existingOsmIds = new Set(existingOsm.map((r) => r.osm_id));

  // ── Step 4–6: classify, project, dedup ────────────────────────────────
  for (const f of features) {
    if (trace.osmFeaturesMapped >= maxFeatures) break;

    const center = featureCenter(f);
    if (!center) { trace.skippedNoCenter++; continue; }

    const mapped = mapOsmFeature(f, { greenCenters });
    if (!mapped) continue;
    trace.osmFeaturesMapped++;

    const osmId = `${f.type}/${f.id}`;
    if (existingOsmIds.has(osmId)) { trace.skippedDuplicateOfOsm++; continue; }

    // Project onto holes
    const projection = projectToBestHole(center, holes);
    if (!projection) { trace.skippedOutsideHoles++; continue; }

    // Dedup against native: same coarse category within DEDUPE_DISTANCE_YARDS
    if (isDuplicateOfNative(center, mapped.normalizedType, projection.holeNumber, native)) {
      trace.skippedDuplicateOfNative++;
      continue;
    }

    const proposed = {
      hole_number: projection.holeNumber,
      poi_type: mapped.rawType,
      normalized_type: mapped.normalizedType,
      location_label: mapped.label,
      fairway_side: projection.relativePosition,
      lat: round6(center.lat),
      lon: round6(center.lon),
      source_type: "source_osm",
      confidence: mapped.confidence,
      osm_id: osmId,
      osm_tags: f.tags || {},
      // Diagnostics (not persisted)
      _carryYards: Math.round(projection.carryYards),
      _lateralYards: Math.round(projection.lateralYards)
    };
    trace.proposedRows.push(proposed);
    trace.insertedByType[mapped.normalizedType] = (trace.insertedByType[mapped.normalizedType] || 0) + 1;
    trace.insertedByHole[projection.holeNumber] = (trace.insertedByHole[projection.holeNumber] || 0) + 1;
  }

  // ── Step 7: persist (if not dry-run) ──────────────────────────────────
  if (!dryRun && trace.proposedRows.length > 0) {
    trace.inserted = await persistProposed(pool, courseUuid, trace.proposedRows);
  }

  return trace;
}

// ── Geometry & DB helpers ──────────────────────────────────────────────

async function loadHoleGeometry(pool, courseUuid) {
  // Per-hole tee+green from the canonical sources used elsewhere.
  const sql = `
    SELECT h.hole_number,
           ht.lat AS tee_lat, ht.lon AS tee_lon,
           gg.lat AS green_lat, gg.lon AS green_lon,
           COALESCE(l.length, 0)::int AS yardage
    FROM golf_course_holes h
    LEFT JOIN LATERAL (
      SELECT lat, lon
      FROM golf_hole_tees
      WHERE course_id = h.course_id AND hole_number = h.hole_number
      ORDER BY tee_name LIMIT 1
    ) ht ON TRUE
    LEFT JOIN LATERAL (
      SELECT AVG(lat)::float8 AS lat, AVG(lon)::float8 AS lon
      FROM golf_hole_pois
      WHERE course_id = h.course_id AND hole_number = h.hole_number
        AND LOWER(TRIM(poi_type)) = 'green'
    ) gg ON TRUE
    LEFT JOIN LATERAL (
      SELECT AVG(thl.length)::int AS length
      FROM golf_tee_hole_lengths thl
      JOIN golf_tees t ON t.id = thl.tees_id
      WHERE t.course_id = h.course_id AND thl.hole_number = h.hole_number
    ) l ON TRUE
    WHERE h.course_id = $1
    ORDER BY h.hole_number
  `;
  const res = await pool.query(sql, [courseUuid]);
  const holes = [];
  for (const r of res.rows) {
    if (r.tee_lat == null || r.green_lat == null) continue;
    const tee   = { lat: Number(r.tee_lat),   lon: Number(r.tee_lon) };
    const green = { lat: Number(r.green_lat), lon: Number(r.green_lon) };
    const yd = Number(r.yardage) || Math.round(yardsBetween(tee.lat, tee.lon, green.lat, green.lon));
    holes.push({ holeNumber: Number(r.hole_number), tee, green, yardage: yd });
  }
  return holes;
}

async function loadNativeHazards(pool, courseUuid) {
  const sql = `
    SELECT hole_number, poi_type, lat, lon
    FROM golf_hole_pois
    WHERE course_id = $1
      AND source_type = 'source_native'
      AND LOWER(TRIM(poi_type)) NOT IN ('green', 'tee', 'tee front', 'tee back')
  `;
  const res = await pool.query(sql, [courseUuid]);
  return res.rows.map((r) => ({
    hole_number: Number(r.hole_number),
    poi_type: r.poi_type,
    lat: Number(r.lat),
    lon: Number(r.lon)
  }));
}

async function loadOsmHazards(pool, courseUuid) {
  const sql = `SELECT osm_id FROM golf_hole_pois WHERE course_id = $1 AND osm_id IS NOT NULL`;
  const res = await pool.query(sql, [courseUuid]);
  return res.rows;
}

function computeBbox(holes, bufferMeters) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const h of holes) {
    for (const p of [h.tee, h.green]) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  // Convert buffer meters to degrees (rough, OK for bbox)
  const latBuf = bufferMeters / 111_320;
  const lonBuf = bufferMeters / (111_320 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  return {
    south: minLat - latBuf,
    west:  minLon - lonBuf,
    north: maxLat + latBuf,
    east:  maxLon + lonBuf
  };
}

function buildOverpassQuery(bbox) {
  // Conservative query targeting only hazard-relevant tags.
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:60];
(
  way["golf"="bunker"](${b});
  way["golf"="water_hazard"](${b});
  way["golf"="lateral_water_hazard"](${b});
  way["golf"="rough"](${b});
  way["golf"="out_of_bounds"](${b});
  way["natural"="water"](${b});
  way["waterway"~"^(stream|river|ditch|drain)$"](${b});
  way["natural"~"^(wood|tree_row|scrub)$"](${b});
  way["landuse"="forest"](${b});
  relation["natural"="water"](${b});
  relation["landuse"="forest"](${b});
  way["barrier"~"^(fence|wall)$"](${b});
);
out center tags;
`;
}

async function fetchHazardFeatures(bbox, doFetch) {
  const query = buildOverpassQuery(bbox);
  const res = await doFetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    timeout: 60_000
  });
  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return Array.isArray(json.elements) ? json.elements : [];
}

/**
 * Project a point onto each hole's tee→green centerline and pick the hole
 * for which:
 *   - the carry distance falls inside [10y, holeYardage + 30y]
 *   - the lateral offset is minimised
 * This mirrors the "in-play" filter used by HazardEngine.
 */
function projectToBestHole(point, holes) {
  let best = null;
  for (const h of holes) {
    const totalDistYd = yardsBetween(h.tee.lat, h.tee.lon, h.green.lat, h.green.lon);
    if (totalDistYd <= 0) continue;

    const distToHazardYd = yardsBetween(h.tee.lat, h.tee.lon, point.lat, point.lon);
    const teeBearing = bearingDeg(h.tee.lat, h.tee.lon, h.green.lat, h.green.lon);
    const hazardBearing = bearingDeg(h.tee.lat, h.tee.lon, point.lat, point.lon);
    const angleDiff = ((hazardBearing - teeBearing) * Math.PI) / 180;

    const carryYd   = distToHazardYd * Math.cos(angleDiff);
    const lateralYd = distToHazardYd * Math.sin(angleDiff);
    const upperBound = (h.yardage > 0 ? h.yardage : Math.round(totalDistYd)) + 30;

    const inPlay = carryYd > 10 && carryYd < upperBound && Math.abs(lateralYd) < 100;
    if (!inPlay) continue;

    const score = Math.abs(lateralYd);
    if (best === null || score < best.score) {
      best = {
        score,
        holeNumber: h.holeNumber,
        carryYards: carryYd,
        lateralYards: lateralYd,
        relativePosition: lateralYd < -10 ? "L" : (lateralYd > 10 ? "R" : "C")
      };
    }
  }
  return best;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function isDuplicateOfNative(point, normalizedType, holeNumber, natives) {
  const cat = coarseCategory(normalizedType);
  for (const n of natives) {
    if (n.hole_number !== holeNumber) continue;
    const nCat = coarseCategory(require("./hazardClassifier").normalizeHazardType(n.poi_type));
    if (nCat !== cat) continue;
    if (yardsBetween(point.lat, point.lon, n.lat, n.lon) <= DEDUPE_DISTANCE_YARDS) return true;
  }
  return false;
}

async function persistProposed(pool, courseUuid, rows) {
  const insertSql = `
    INSERT INTO golf_hole_pois
      (course_id, hole_number, poi_type, location_label, fairway_side,
       lat, lon, location, source_type, confidence, osm_id, osm_tags, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7,
       ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography,
       $8, $9, $10, $11::jsonb, now())
    ON CONFLICT (course_id, hole_number, lat, lon) DO NOTHING
  `;
  let inserted = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const result = await client.query(insertSql, [
        courseUuid,
        r.hole_number,
        r.poi_type,
        r.location_label,
        r.fairway_side,
        r.lat,
        r.lon,
        r.source_type,
        r.confidence,
        r.osm_id,
        JSON.stringify(r.osm_tags || {})
      ]);
      inserted += result.rowCount || 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return inserted;
}

function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

module.exports = {
  enrichCourse,
  // Exposed for unit tests / endpoints that already have data
  buildOverpassQuery,
  computeBbox,
  projectToBestHole
};
