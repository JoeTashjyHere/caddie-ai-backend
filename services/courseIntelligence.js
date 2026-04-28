"use strict";

/**
 * Course intelligence: fetch course, tees, holes, POIs for Play mode.
 * Serves MUST PREFETCH payload from GET /api/courses/:id
 */

const { isHazardPoi, normalizeHazardType } = require("./hazardClassifier");

async function resolveCourseId(pool, idOrSlug) {
  const val = String(idOrSlug || "").trim();
  if (!val) return null;
  const byUuid = await pool.query(
    `SELECT gc.id FROM golf_courses gc WHERE gc.id::text = $1`,
    [val]
  );
  if (byUuid.rows.length > 0) return byUuid.rows[0].id;
  const byCourseId = await pool.query(
    `SELECT gc.id FROM golf_courses gc WHERE gc.course_id = $1`,
    [val]
  );
  if (byCourseId.rows.length > 0) return byCourseId.rows[0].id;
  return null;
}

async function getCourseById(pool, courseUuid) {
  const resolved = await resolveCourseId(pool, courseUuid);
  if (!resolved) return null;
  const res = await pool.query(
    `SELECT gc.id, gc.course_id, gc.course_name, gc.num_holes, gc.lat, gc.lon,
            c.id AS club_id, c.name AS club_name, c.address AS club_address,
            c.city AS club_city, c.state AS club_state, c.country AS club_country,
            c.website AS club_website
     FROM golf_courses gc
     JOIN golf_clubs c ON gc.club_id = c.id
     WHERE gc.id = $1`,
    [resolved]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

async function getTeesByCourseId(pool, courseUuid) {
  const res = await pool.query(
    `SELECT id, tees_id, tee_name, tee_color, slope, course_rating, measurement_unit
     FROM golf_tees
     WHERE course_id = $1
     ORDER BY tee_name`,
    [courseUuid]
  );
  return res.rows;
}

async function getTeeLengthsByTeeId(pool, teeUuid) {
  const res = await pool.query(
    `SELECT hole_number, length FROM golf_tee_hole_lengths WHERE tees_id = $1 ORDER BY hole_number`,
    [teeUuid]
  );
  const map = {};
  for (const r of res.rows) map[r.hole_number] = r.length;
  return map;
}

async function getHolesByCourseId(pool, courseUuid) {
  const res = await pool.query(
    `SELECT id, hole_number, par, handicap, match_index, split_index
     FROM golf_course_holes
     WHERE course_id = $1
     ORDER BY hole_number`,
    [courseUuid]
  );
  return res.rows;
}

async function getPoisByCourseHole(pool, courseUuid) {
  const res = await pool.query(
    `SELECT hole_number, poi_type, location_label, lat, lon
     FROM golf_hole_pois
     WHERE course_id = $1
     ORDER BY hole_number, poi_type, location_label`,
    [courseUuid]
  );
  const byHole = {};
  for (const r of res.rows) {
    if (!byHole[r.hole_number]) byHole[r.hole_number] = [];
    byHole[r.hole_number].push({
      poiType: r.poi_type,
      locationLabel: r.location_label,
      lat: r.lat,
      lon: r.lon
    });
  }
  return byHole;
}

function extractGreenCenter(pois) {
  if (!pois || !Array.isArray(pois)) return null;
  const greenC = pois.find((p) => p.poiType === "Green" && p.locationLabel === "C");
  if (greenC) return { lat: greenC.lat, lon: greenC.lon };
  const green = pois.find((p) => p.poiType === "Green");
  if (green) return { lat: green.lat, lon: green.lon };
  return null;
}

function extractGreenFrontBack(pois) {
  const front = pois?.find((p) => p.poiType === "Green" && p.locationLabel === "F");
  const back = pois?.find((p) => p.poiType === "Green" && p.locationLabel === "B");
  return {
    greenFront: front ? { lat: front.lat, lon: front.lon } : null,
    greenBack: back ? { lat: back.lat, lon: back.lon } : null
  };
}

/**
 * Full course payload for MUST PREFETCH
 */
async function getFullCoursePayload(pool, courseUuid) {
  const course = await getCourseById(pool, courseUuid);
  if (!course) return null;
  const uuid = course.id;

  const [tees, holes, poisByHole] = await Promise.all([
    getTeesByCourseId(pool, uuid),
    getHolesByCourseId(pool, uuid),
    getPoisByCourseHole(pool, uuid)
  ]);

  const teeLengthsMap = {};
  for (const tee of tees) {
    teeLengthsMap[tee.id] = await getTeeLengthsByTeeId(pool, tee.id);
  }

  const holesPayload = holes.map((h) => {
    const pois = poisByHole[h.hole_number] || [];
    const greenCenter = extractGreenCenter(pois);
    const { greenFront, greenBack } = extractGreenFrontBack(pois);
    const yardagesByTee = {};
    for (const tee of tees) {
      const len = teeLengthsMap[tee.id]?.[h.hole_number];
      if (len != null) yardagesByTee[tee.tee_name] = len;
    }
    return {
      holeNumber: h.hole_number,
      par: h.par,
      handicap: h.handicap,
      greenCenter: greenCenter || null,
      greenFront: greenFront || null,
      greenBack: greenBack || null,
      yardagesByTee,
      pois
    };
  });

  const teesPayload = tees.map((t) => ({
    id: t.id,
    name: t.tee_name,
    color: t.tee_color,
    slope: t.slope,
    courseRating: t.course_rating,
    totalYards: Object.values(teeLengthsMap[t.id] || {}).reduce((a, b) => a + b, 0)
  }));

  return {
    id: course.id,
    courseId: course.course_id,
    name: course.course_name,
    numHoles: course.num_holes,
    lat: course.lat,
    lon: course.lon,
    club: {
      id: course.club_id,
      name: course.club_name,
      address: course.club_address,
      city: course.club_city,
      state: course.club_state,
      country: course.club_country,
      website: course.club_website
    },
    tees: teesPayload,
    holes: holesPayload
  };
}

/**
 * Hole layout: POIs for a hole (for future polygon / point-in-polygon)
 * Returns structured POI data; polygons are future enhancement.
 */
async function getHoleLayout(pool, courseUuidOrSlug, holeNumber) {
  const uuid = await resolveCourseId(pool, courseUuidOrSlug);
  if (!uuid) return null;
  const res = await pool.query(
    `SELECT hole_number, poi_type, location_label, fairway_side, lat, lon
     FROM golf_hole_pois
     WHERE course_id = $1 AND hole_number = $2
     ORDER BY poi_type, location_label`,
    [uuid, holeNumber]
  );
  if (res.rows.length === 0) return null;
  return {
    holeNumber: parseInt(holeNumber, 10),
    pois: res.rows.map((r) => ({
      poiType: r.poi_type,
      locationLabel: r.location_label,
      fairwaySide: r.fairway_side,
      lat: r.lat,
      lon: r.lon
    }))
  };
}

/**
 * Round engine: course + holes + tees + per-hole hazards in one payload.
 *
 * Hole geometry is now tee-specific:
 *   - Per-tee coordinates from golf_hole_tees (synthesized from POI + yardage)
 *   - Green front/center/back from golf_hole_pois
 *   - Hazards as raw POIs (tee-relative computation available client-side)
 *   - Legacy tee_front/tee_back kept for backward compat
 */
async function getRoundCourseContext(pool, idOrSlug) {
  const uuid = await resolveCourseId(pool, idOrSlug);
  if (!uuid) return null;
  const course = await getCourseById(pool, uuid);
  if (!course) return null;

  const holesSql = `
    SELECT h.hole_number, h.par, h.handicap,
           gg.green_lat, gg.green_lon
    FROM golf_course_holes h
    LEFT JOIN (
      SELECT course_id, hole_number,
             AVG(lat) AS green_lat,
             AVG(lon) AS green_lon
      FROM golf_hole_pois
      WHERE LOWER(TRIM(poi_type)) = 'green'
      GROUP BY course_id, hole_number
    ) gg ON gg.course_id = h.course_id AND gg.hole_number = h.hole_number
    WHERE h.course_id = $1
    ORDER BY h.hole_number
  `;

  const teesSql = `
    SELECT t.id, t.tee_name, t.tee_color, t.slope, t.course_rating,
           COALESCE(SUM(l.length), 0)::bigint AS total_yards
    FROM golf_tees t
    LEFT JOIN golf_tee_hole_lengths l ON l.tees_id = t.id
    WHERE t.course_id = $1
    GROUP BY t.id, t.tee_name, t.tee_color, t.slope, t.course_rating
    ORDER BY total_yards DESC
  `;

  // Coarse pre-filter: tee/green are never hazards. Final classification
  // happens in JS via normalizeHazardType() so non-hazards (yardage markers,
  // doglegs, unknown POI types) are dropped before being injected into the
  // decision engine or AI prompt.
  //
  // source_type/confidence columns may not exist on older deploys (mig 006);
  // we still want to return safe defaults so iOS decoders never break.
  const hasProvenance = await columnExists(pool, "golf_hole_pois", "source_type");
  const provenanceCols = hasProvenance
    ? `COALESCE(source_type, 'source_native') AS source_type, confidence`
    : `'source_native'::text AS source_type, NULL::real AS confidence`;
  const hazardsSql = `
    SELECT id::text AS id,
           hole_number,
           TRIM(poi_type) AS poi_type,
           location_label,
           fairway_side,
           lat, lon,
           ${provenanceCols}
    FROM golf_hole_pois
    WHERE course_id = $1
      AND LOWER(TRIM(poi_type)) NOT IN ('green', 'tee', 'tee front', 'tee back')
    ORDER BY hole_number, poi_type, location_label
  `;

  // Green geometry POIs: front/center/back
  const greenGeomSql = `
    SELECT hole_number,
           UPPER(TRIM(COALESCE(location_label, ''))) AS loc,
           lat, lon
    FROM golf_hole_pois
    WHERE course_id = $1
      AND LOWER(TRIM(poi_type)) = 'green'
    ORDER BY hole_number, location_label
  `;

  // Per-tee per-hole coordinates from golf_hole_tees
  const holeTeesSql = `
    SELECT ht.hole_number, ht.tee_set_id, ht.tee_name,
           ht.lat, ht.lon, ht.yardage, ht.is_synthesized
    FROM golf_hole_tees ht
    WHERE ht.course_id = $1
    ORDER BY ht.hole_number, ht.tee_name
  `;

  // Authoritative per-hole, per-tee yardage from golf_tee_hole_lengths.
  // This is the canonical source — separate from golf_hole_tees.yardage which is sometimes
  // synthesized for geometry. Keyed by tee_set_id + tee_name so iOS can resolve by selectedTee.id.
  const holeLengthsSql = `
    SELECT l.hole_number,
           t.id  AS tee_set_id,
           t.tee_name,
           l.length AS yardage
    FROM golf_tee_hole_lengths l
    JOIN golf_tees t ON t.id = l.tees_id
    WHERE t.course_id = $1
    ORDER BY l.hole_number, t.tee_name
  `;

  // Legacy tee POIs (fallback if golf_hole_tees not populated)
  const legacyTeeSql = `
    SELECT hole_number,
           LOWER(TRIM(poi_type)) AS poi_type,
           lat, lon
    FROM golf_hole_pois
    WHERE course_id = $1
      AND LOWER(TRIM(poi_type)) IN ('tee', 'tee front', 'tee back')
    ORDER BY hole_number
  `;

  // Check if golf_hole_tees table exists
  let hasHoleTeesTable = false;
  try {
    await pool.query("SELECT 1 FROM golf_hole_tees LIMIT 0");
    hasHoleTeesTable = true;
  } catch { /* table doesn't exist yet */ }

  const queries = [
    pool.query(holesSql, [uuid]),
    pool.query(teesSql, [uuid]),
    pool.query(hazardsSql, [uuid]),
    pool.query(greenGeomSql, [uuid]),
    pool.query(legacyTeeSql, [uuid]),
    pool.query(holeLengthsSql, [uuid])
  ];
  if (hasHoleTeesTable) {
    queries.push(pool.query(holeTeesSql, [uuid]));
  }

  const results = await Promise.all(queries);
  const [holesRes, teesRes, hazardsRes, greenGeomRes, legacyTeeRes, holeLengthsRes] = results;
  const holeTeesRes = hasHoleTeesTable ? results[6] : { rows: [] };

  // Positive-whitelist classification: drop any POI whose normalized type
  // is null (yardage markers, doglegs, mislabeled rows). Attach the canonical
  // normalized_type so the iOS engine + admin dashboard can match without
  // fragile substring logic.
  const rawHazardsByHole = {};
  const hazardDescsByHole = {};
  let droppedNonHazardCount = 0;
  for (const r of hazardsRes.rows) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      droppedNonHazardCount++;
      continue;
    }
    const normalizedType = normalizeHazardType(r.poi_type, r.location_label, r.fairway_side);
    if (!normalizedType) {
      droppedNonHazardCount++;
      continue;
    }
    if (!rawHazardsByHole[r.hole_number]) rawHazardsByHole[r.hole_number] = [];
    rawHazardsByHole[r.hole_number].push({
      id: r.id || null,
      type: r.poi_type,
      normalized_type: normalizedType,
      location_label: r.location_label || null,
      fairway_side: r.fairway_side || null,
      lat,
      lon,
      source_type: r.source_type || "source_native",
      confidence: r.confidence != null ? Number(r.confidence) : null
    });
    if (!hazardDescsByHole[r.hole_number]) hazardDescsByHole[r.hole_number] = [];
    const desc = buildHazardDescription(r.poi_type, r.location_label, r.fairway_side);
    if (desc) hazardDescsByHole[r.hole_number].push(desc);
  }
  if (droppedNonHazardCount > 0) {
    console.log(`[COURSE_CONTEXT] dropped ${droppedNonHazardCount} non-hazard POIs (markers/doglegs/invalid coords)`);
  }

  // Index green geometry by hole
  const greenByHole = {};
  for (const r of greenGeomRes.rows) {
    if (!greenByHole[r.hole_number]) greenByHole[r.hole_number] = {};
    const g = greenByHole[r.hole_number];
    const coord = { lat: Number(r.lat), lon: Number(r.lon) };
    if (r.loc === "C") g.center = coord;
    else if (r.loc === "F") g.front = coord;
    else if (r.loc === "B") g.back = coord;
    else if (!g.center) g.center = coord; // first green POI as fallback center
  }

  // Index per-tee coordinates by hole → tee_set_id
  const holeTeesByHole = {};
  for (const r of holeTeesRes.rows) {
    if (!holeTeesByHole[r.hole_number]) holeTeesByHole[r.hole_number] = [];
    holeTeesByHole[r.hole_number].push({
      tee_set_id: r.tee_set_id,
      tee_name: r.tee_name,
      coordinate: { lat: Number(r.lat), lon: Number(r.lon) },
      yardage: r.yardage,
      is_synthesized: r.is_synthesized
    });
  }

  // Index canonical per-hole yardage by hole → [{tee_set_id, tee_name, yardage}].
  // This is the table the iOS decision engine should use as the source of truth.
  const holeLengthsByHole = {};
  for (const r of holeLengthsRes.rows) {
    if (!holeLengthsByHole[r.hole_number]) holeLengthsByHole[r.hole_number] = [];
    holeLengthsByHole[r.hole_number].push({
      tee_set_id: r.tee_set_id,
      tee_name: r.tee_name,
      yardage: Number(r.yardage)
    });
  }

  // Index legacy tee POIs by hole (fallback)
  const legacyTeeByHole = {};
  for (const r of legacyTeeRes.rows) {
    if (!legacyTeeByHole[r.hole_number]) legacyTeeByHole[r.hole_number] = {};
    const h = legacyTeeByHole[r.hole_number];
    const coord = { lat: Number(r.lat), lon: Number(r.lon) };
    if (r.poi_type === "tee front" || r.poi_type === "tee") {
      if (!h.tee_front) h.tee_front = coord;
    }
    if (r.poi_type === "tee back") h.tee_back = coord;
  }

  return {
    course: {
      id: course.id,
      name: course.course_name,
      lat: course.lat,
      lon: course.lon,
      city: course.club_city || null,
      state: course.club_state || null,
      clubName: course.club_name || null
    },
    holes: holesRes.rows.map((r) => {
      const green = greenByHole[r.hole_number] || {};
      const legacy = legacyTeeByHole[r.hole_number] || {};

      // Green center: prefer explicit Center POI, then AVG
      const greenCenter = green.center
        || (r.green_lat != null && r.green_lon != null
            ? { lat: Number(r.green_lat), lon: Number(r.green_lon) }
            : null);

      const holeTees = holeTeesByHole[r.hole_number] || [];
      const geometryQuality = assessGeometryQuality(greenCenter, holeTees, legacy);

      return {
        hole_number: r.hole_number,
        par: r.par,
        handicap: r.handicap || null,
        green: {
          center: greenCenter,
          front: green.front || null,
          back: green.back || null
        },
        // Per-tee coordinates (from golf_hole_tees)
        tees: holeTees,
        // Canonical per-hole yardage by tee (from golf_tee_hole_lengths) — additive,
        // backward-compatible. iOS uses this for accurate course-demand math.
        hole_lengths: holeLengthsByHole[r.hole_number] || [],
        // Legacy fallback: generic tee POIs (for backward compat)
        tee_front: legacy.tee_front || null,
        tee_back: legacy.tee_back || null,
        // Backward-compat flat field
        green_center: greenCenter,
        green_front: green.front || null,
        green_back: green.back || null,
        // Raw hazard POIs (for tee-relative client-side computation)
        hazard_pois: rawHazardsByHole[r.hole_number] || [],
        // Legacy text descriptions
        hazards: hazardDescsByHole[r.hole_number] || [],
        // Geometry quality audit
        geometry_quality: geometryQuality
      };
    }),
    tees: teesRes.rows.map((r) => ({
      id: r.id,
      name: r.tee_name,
      color: r.tee_color || null,
      total_yards: Number(r.total_yards) || 0,
      slope: r.slope || null,
      course_rating: r.course_rating ? Number(r.course_rating) : null
    }))
  };
}

// ── Bearing math (matches iOS DistanceEngine.bearingDegrees) ──

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Assess geometry quality for a hole.
 *
 * teeAnchorQuality:     REAL | SYNTH_FROM_POI | SYNTH_FALLBACK
 * bearingQuality:       VALID_REAL | VALID_SYNTH | FALLBACK_NORTH | INVALID
 * mapAlignmentReady:    true if tee/green geometry supports accurate rendering
 */
function assessGeometryQuality(greenCenter, holeTees, legacyTee) {
  const hasGreen = !!greenCenter;
  const hasLegacyPoi = !!(legacyTee.tee_front || legacyTee.tee_back);
  const hasHoleTees = holeTees && holeTees.length > 0;
  const allSynth = hasHoleTees && holeTees.every(t => t.is_synthesized);

  let teeAnchorQuality, bearingQuality;
  if (!hasHoleTees && !hasLegacyPoi) {
    teeAnchorQuality = "SYNTH_FALLBACK";
    bearingQuality = hasGreen ? "FALLBACK_NORTH" : "INVALID";
  } else if (!hasHoleTees || allSynth) {
    teeAnchorQuality = hasLegacyPoi ? "SYNTH_FROM_POI" : "SYNTH_FALLBACK";
    bearingQuality = hasGreen ? (hasLegacyPoi ? "VALID_SYNTH" : "FALLBACK_NORTH") : "INVALID";
  } else {
    teeAnchorQuality = "REAL";
    bearingQuality = hasGreen ? "VALID_REAL" : "INVALID";
  }

  const mapAlignmentReady = hasGreen && bearingQuality !== "INVALID" && bearingQuality !== "FALLBACK_NORTH";

  let computedBearing = null;
  if (hasGreen) {
    const tee = hasHoleTees
      ? holeTees[0].coordinate
      : (legacyTee.tee_front || legacyTee.tee_back || null);
    if (tee) {
      computedBearing = Math.round(bearingDeg(tee.lat, tee.lon, greenCenter.lat, greenCenter.lon) * 10) / 10;
    }
  }

  return {
    tee_anchor_quality: teeAnchorQuality,
    bearing_quality: bearingQuality,
    map_alignment_ready: mapAlignmentReady,
    computed_bearing: computedBearing
  };
}

/**
 * Check whether a column exists. Used so /api/course-context degrades
 * gracefully on deploys that have not yet applied newer migrations.
 */
async function columnExists(pool, table, column) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column]
    );
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

function buildHazardDescription(poiType, locationLabel, fairwaySide) {
  const type = (poiType || "").trim();
  if (!type) return null;
  const parts = [type];
  if (fairwaySide && fairwaySide.trim()) {
    parts.push(fairwaySide.trim().toLowerCase());
  }
  if (locationLabel && locationLabel.trim() && locationLabel.trim() !== "C") {
    parts.push(`(${locationLabel.trim()})`);
  }
  return parts.join(" ");
}

module.exports = {
  getCourseById,
  getFullCoursePayload,
  getTeesByCourseId,
  getTeeLengthsByTeeId,
  getHolesByCourseId,
  getHoleLayout,
  getRoundCourseContext,
  resolveCourseId,
  assessGeometryQuality,
  bearingDeg
};
