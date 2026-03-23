"use strict";

/**
 * Course intelligence: fetch course, tees, holes, POIs for Play mode.
 * Serves MUST PREFETCH payload from GET /api/courses/:id
 */

async function getCourseById(pool, courseUuid) {
  const res = await pool.query(
    `SELECT gc.id, gc.course_id, gc.course_name, gc.num_holes, gc.lat, gc.lon,
            c.id AS club_id, c.name AS club_name, c.address AS club_address,
            c.city AS club_city, c.state AS club_state, c.country AS club_country,
            c.website AS club_website
     FROM golf_courses gc
     JOIN golf_clubs c ON gc.club_id = c.id
     WHERE gc.id = $1`,
    [courseUuid]
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

  const [tees, holes, poisByHole] = await Promise.all([
    getTeesByCourseId(pool, courseUuid),
    getHolesByCourseId(pool, courseUuid),
    getPoisByCourseHole(pool, courseUuid)
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
async function getHoleLayout(pool, courseUuid, holeNumber) {
  const res = await pool.query(
    `SELECT hole_number, poi_type, location_label, fairway_side, lat, lon
     FROM golf_hole_pois
     WHERE course_id = $1 AND hole_number = $2
     ORDER BY poi_type, location_label`,
    [courseUuid, holeNumber]
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

module.exports = {
  getCourseById,
  getFullCoursePayload,
  getTeesByCourseId,
  getTeeLengthsByTeeId,
  getHolesByCourseId,
  getHoleLayout
};
