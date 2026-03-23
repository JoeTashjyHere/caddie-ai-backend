"use strict";

/**
 * Course matching: Google Place ID -> golf_courses
 * Course-first mapping (POIs are per course; no club-level disambiguation needed).
 * Queries golf_courses within 2km; scores by name, distance, city, state.
 * If one confident match: auto-resolve. If multiple candidates: return for disambiguation.
 */

const SUFFIXES = [
  "golf links", "golf club", "country club", "golf course", "golf & country club",
  "golf and tennis club", "golf resort", "golf center"
];

function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  let s = name.toLowerCase().trim();
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf)) s = s.slice(0, -suf.length).trim();
  }
  return s.replace(/\s+/g, " ");
}

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const longer = na.length > nb.length ? na : nb;
  const shorter = na.length > nb.length ? nb : na;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  let matches = 0;
  const wordsA = na.split(/\s+/);
  const wordsB = new Set(nb.split(/\s+/));
  for (const w of wordsA) {
    if (w.length >= 2 && wordsB.has(w)) matches++;
  }
  return matches / Math.max(wordsA.length, wordsB.size, 1);
}

async function resolveFromMappings(pool, googlePlaceId) {
  const res = await pool.query(
    "SELECT golf_course_uuid, confidence FROM course_place_mappings WHERE google_place_id = $1",
    [googlePlaceId]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].golf_course_uuid;
}

async function findCandidates(pool, lat, lon, limit = 20) {
  const res = await pool.query(
    `SELECT gc.id, gc.course_id, gc.course_name, gc.lat, gc.lon, c.name AS club_name, c.city AS club_city, c.state AS club_state,
            (ST_Distance(gc.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000)::float AS dist_km
     FROM golf_courses gc
     JOIN golf_clubs c ON gc.club_id = c.id
     WHERE gc.location IS NOT NULL
       AND ST_DWithin(gc.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 2000)
     ORDER BY dist_km
     LIMIT $3`,
    [lat, lon, limit]
  );
  return res.rows;
}

async function scoreCandidates(candidates, placeName, placeCity, placeState) {
  const scored = [];
  for (const c of candidates) {
    const nameSim = Math.max(
      nameSimilarity(placeName, c.course_name),
      nameSimilarity(placeName, c.club_name)
    );
    const distKm = parseFloat(c.dist_km) || 2;
    const distScore = Math.max(0, 1 - distKm / 2);
    const cityMatch = placeCity && c.club_city
      ? normalizeName(placeCity) === normalizeName(c.club_city) ? 1 : 0
      : 0.5;
    const stateMatch = placeState && c.club_state
      ? String(placeState).toUpperCase() === String(c.club_state).toUpperCase() ? 1 : 0
      : 0.5;
    const confidence = 0.5 * nameSim + 0.3 * distScore + 0.1 * cityMatch + 0.1 * stateMatch;
    scored.push({
      ...c,
      confidence,
      nameSimilarity: nameSim,
      distanceKm: distKm
    });
  }
  return scored.sort((a, b) => b.confidence - a.confidence);
}

async function persistMapping(pool, googlePlaceId, golfCourseUuid, confidence, source = "auto") {
  await pool.query(
    `INSERT INTO course_place_mappings (google_place_id, golf_course_uuid, confidence, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_place_id) DO NOTHING`,
    [googlePlaceId, golfCourseUuid, confidence, source]
  );
}

/**
 * Resolve Google Place ID to golf course.
 * Returns: { courseId, course, matched } or { candidates } or { error }
 */
async function resolve(pool, googlePlaceId, placeDetails = null) {
  if (!pool) throw new Error("Database pool required");
  const pid = String(googlePlaceId || "").trim();
  if (!pid) return { error: "placeId is required" };

  const cached = await resolveFromMappings(pool, pid);
  if (cached) {
    return { courseId: cached, matched: true, fromCache: true };
  }

  const details = placeDetails || null;
  const lat = details?.lat ?? null;
  const lon = details?.lon ?? null;
  const placeName = details?.name ?? "";
  const placeCity = details?.city ?? null;
  const placeState = details?.state ?? null;

  if (lat == null || lon == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
    return { error: "Place coordinates required for matching" };
  }

  const candidates = await findCandidates(pool, lat, lon);
  if (candidates.length === 0) {
    return { error: "No courses found within 2km" };
  }

  const scored = await scoreCandidates(
    candidates,
    placeName,
    placeCity,
    placeState
  );

  const top = scored[0];
  if (top.confidence >= 0.8) {
    await persistMapping(pool, pid, top.id, top.confidence);
    return {
      courseId: top.id,
      course: {
        id: top.id,
        courseId: top.course_id,
        name: top.course_name,
        clubName: top.club_name,
        city: top.club_city,
        state: top.club_state
      },
      matched: true,
      confidence: top.confidence
    };
  }

  if (top.confidence >= 0.5) {
    return {
      candidates: scored.slice(0, 3).map((c) => ({
        id: c.id,
        courseId: c.course_id,
        name: c.course_name,
        clubName: c.club_name,
        city: c.club_city,
        state: c.club_state,
        confidence: c.confidence
      })),
      matched: false
    };
  }

  return { error: "No confident match found" };
}

/**
 * Manual disambiguation: user selected a course from candidates
 */
async function confirmMatch(pool, googlePlaceId, golfCourseUuid) {
  if (!pool) throw new Error("Database pool required");
  await persistMapping(pool, googlePlaceId, golfCourseUuid, 1, "manual");
  return { courseId: golfCourseUuid, matched: true };
}

module.exports = {
  resolve,
  confirmMatch,
  normalizeName,
  nameSimilarity
};
