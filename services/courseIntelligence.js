"use strict";

/**
 * Course intelligence: fetch course, tees, holes, POIs for Play mode.
 * Serves MUST PREFETCH payload from GET /api/courses/:id
 */

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
 * Green center = AVG(lat), AVG(lon) of Green POIs per hole.
 * Hazards = distinct non-Green POI types per hole (Bunker, Water, etc.).
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
    SELECT t.id, t.tee_name, COALESCE(SUM(l.length), 0)::bigint AS total_yards
    FROM golf_tees t
    LEFT JOIN golf_tee_hole_lengths l ON l.tees_id = t.id
    WHERE t.course_id = $1
    GROUP BY t.id, t.tee_name
    ORDER BY t.tee_name
  `;

  const hazardsSql = `
    SELECT hole_number,
           INITCAP(TRIM(poi_type)) AS poi_type,
           location_label,
           fairway_side
    FROM golf_hole_pois
    WHERE course_id = $1
      AND LOWER(TRIM(poi_type)) != 'green'
      AND LOWER(TRIM(poi_type)) != 'tee'
    ORDER BY hole_number, poi_type, location_label
  `;

  const [holesRes, teesRes, hazardsRes] = await Promise.all([
    pool.query(holesSql, [uuid]),
    pool.query(teesSql, [uuid]),
    pool.query(hazardsSql, [uuid])
  ]);

  const hazardsByHole = {};
  for (const r of hazardsRes.rows) {
    if (!hazardsByHole[r.hole_number]) hazardsByHole[r.hole_number] = [];
    const desc = buildHazardDescription(r.poi_type, r.location_label, r.fairway_side);
    if (desc) hazardsByHole[r.hole_number].push(desc);
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
    holes: holesRes.rows.map((r) => ({
      hole_number: r.hole_number,
      par: r.par,
      handicap: r.handicap || null,
      green_center:
        r.green_lat != null && r.green_lon != null
          ? { lat: Number(r.green_lat), lon: Number(r.green_lon) }
          : null,
      hazards: hazardsByHole[r.hole_number] || []
    })),
    tees: teesRes.rows.map((r) => ({
      id: r.id,
      name: r.tee_name,
      total_yards: Number(r.total_yards) || 0
    }))
  };
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
  resolveCourseId
};
