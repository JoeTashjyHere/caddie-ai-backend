"use strict";

/**
 * Synthesize per-tee-set GPS coordinates for each hole.
 *
 * Strategy:
 *   1. For each course+hole, resolve the tee POI pair (Tee Front + Tee Back)
 *      and green center from golf_hole_pois.
 *   2. Compute the bearing from the midpoint of the tee POI pair → green center.
 *   3. For each tee set, compute the expected tee coordinate by projecting
 *      the tee-set yardage backward along that bearing from the green.
 *   4. If no tee POIs exist, infer direction from all non-green POIs on the hole
 *      (hazards, fairway markers). Falls back to due-north ONLY if no POIs at all.
 *
 * Usage:
 *   node scripts/synthesize-hole-tees.js [--dry-run] [--course-id <uuid>]
 *
 * Programmatic:
 *   const { runSynthesis } = require("./synthesize-hole-tees");
 *   await runSynthesis(pool, { courseId, dryRun });
 */

const path = require("path");
const fs = require("fs");

const YARDS_TO_METERS = 0.9144;

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function projectPoint(lat, lon, bearingDegrees, distanceMeters) {
  const R = 6_371_000;
  const δ = distanceMeters / R;
  const θ = toRad(bearingDegrees);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
    Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

/**
 * Infer hole direction from non-green POIs when no tee POI exists.
 * Returns the bearing from green → inferred tee direction, or null.
 */
function inferBearingFromPois(green, allHolePois) {
  if (!allHolePois || allHolePois.length === 0) return null;

  const nonGreenPois = allHolePois.filter(p => {
    const pt = (p.poi_type || "").toLowerCase().trim();
    return pt !== "green";
  });
  if (nonGreenPois.length === 0) return null;

  const centroid = {
    lat: nonGreenPois.reduce((s, p) => s + Number(p.lat), 0) / nonGreenPois.length,
    lon: nonGreenPois.reduce((s, p) => s + Number(p.lon), 0) / nonGreenPois.length
  };

  const dist = Math.sqrt(
    Math.pow(centroid.lat - green.lat, 2) +
    Math.pow(centroid.lon - green.lon, 2)
  );
  if (dist < 0.00001) return null;

  return bearingDeg(green.lat, green.lon, centroid.lat, centroid.lon);
}

/**
 * Run synthesis for all courses or a single course.
 * @param {import("pg").Pool} pool
 * @param {object} [options]
 * @param {string} [options.courseId] - UUID to filter a single course
 * @param {boolean} [options.dryRun]
 * @returns {Promise<object>} stats
 */
async function runSynthesis(pool, options = {}) {
  const dryRun = options.dryRun ?? false;
  const courseFilter = options.courseId || null;

  const migrationPath = path.resolve(__dirname, "../migrations/004_golf_hole_tees.sql");
  if (fs.existsSync(migrationPath)) {
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    await pool.query(migrationSql);
  }

  const courseWhere = courseFilter
    ? `WHERE gc.id = $1`
    : "";
  const courseParams = courseFilter ? [courseFilter] : [];

  const coursesRes = await pool.query(
    `SELECT gc.id, gc.course_name FROM golf_courses gc ${courseWhere} ORDER BY gc.course_name`,
    courseParams
  );
  console.log(`[SYNTH] Processing ${coursesRes.rows.length} courses...`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let coursesWithTeePois = 0;
  let coursesWithoutTeePois = 0;

  for (const course of coursesRes.rows) {
    const courseId = course.id;

    // Get tee POIs, green POIs, and ALL POIs (for fallback inference)
    const poisRes = await pool.query(`
      SELECT hole_number,
             LOWER(TRIM(poi_type)) AS poi_type,
             UPPER(TRIM(COALESCE(location_label, ''))) AS loc,
             lat, lon
      FROM golf_hole_pois
      WHERE course_id = $1
        AND (LOWER(TRIM(poi_type)) LIKE 'tee%' OR LOWER(TRIM(poi_type)) = 'green')
      ORDER BY hole_number
    `, [courseId]);

    const allPoisRes = await pool.query(`
      SELECT hole_number,
             LOWER(TRIM(poi_type)) AS poi_type,
             lat, lon
      FROM golf_hole_pois
      WHERE course_id = $1
      ORDER BY hole_number
    `, [courseId]);

    const allPoisByHole = {};
    for (const r of allPoisRes.rows) {
      if (!allPoisByHole[r.hole_number]) allPoisByHole[r.hole_number] = [];
      allPoisByHole[r.hole_number].push(r);
    }

    const holeGeom = {};
    for (const r of poisRes.rows) {
      if (!holeGeom[r.hole_number]) holeGeom[r.hole_number] = {};
      const h = holeGeom[r.hole_number];
      if (r.poi_type === "tee front" || (r.poi_type === "tee" && r.loc === "F")) {
        h.teeFront = { lat: Number(r.lat), lon: Number(r.lon) };
      } else if (r.poi_type === "tee back" || (r.poi_type === "tee" && r.loc === "B")) {
        h.teeBack = { lat: Number(r.lat), lon: Number(r.lon) };
      } else if (r.poi_type === "green" && r.loc === "C") {
        h.greenCenter = { lat: Number(r.lat), lon: Number(r.lon) };
      } else if (r.poi_type === "green" && !h.greenCenter) {
        h.greenCenter = { lat: Number(r.lat), lon: Number(r.lon) };
      }
    }

    const teeSetsRes = await pool.query(`
      SELECT t.id AS tee_set_id, t.tee_name,
             l.hole_number, l.length AS yardage
      FROM golf_tees t
      JOIN golf_tee_hole_lengths l ON l.tees_id = t.id
      WHERE t.course_id = $1
      ORDER BY t.tee_name, l.hole_number
    `, [courseId]);

    const teeSets = {};
    for (const r of teeSetsRes.rows) {
      if (!teeSets[r.tee_set_id]) {
        teeSets[r.tee_set_id] = { teeSetId: r.tee_set_id, teeName: r.tee_name, holes: {} };
      }
      teeSets[r.tee_set_id].holes[r.hole_number] = r.yardage;
    }

    if (Object.keys(teeSets).length === 0) {
      totalSkipped++;
      continue;
    }

    let courseHasTeePois = false;

    for (const holeNum of Object.keys(holeGeom).map(Number).sort((a, b) => a - b)) {
      const geom = holeGeom[holeNum];
      if (!geom.greenCenter) continue;

      const green = geom.greenCenter;
      const teeFront = geom.teeFront;
      const teeBack = geom.teeBack;
      const hasTeeGeom = !!(teeFront || teeBack);
      if (hasTeeGeom) courseHasTeePois = true;

      let refTee;
      if (teeFront && teeBack) {
        refTee = { lat: (teeFront.lat + teeBack.lat) / 2, lon: (teeFront.lon + teeBack.lon) / 2 };
      } else if (teeBack) {
        refTee = teeBack;
      } else if (teeFront) {
        refTee = teeFront;
      }

      let greenToTeeBearing;
      let bearingSource;
      if (refTee) {
        greenToTeeBearing = bearingDeg(green.lat, green.lon, refTee.lat, refTee.lon);
        bearingSource = "POI";
      } else {
        const inferred = inferBearingFromPois(green, allPoisByHole[holeNum]);
        if (inferred !== null) {
          greenToTeeBearing = inferred;
          bearingSource = "INFERRED";
        } else {
          greenToTeeBearing = 0;
          bearingSource = "FALLBACK_NORTH";
        }
      }

      for (const ts of Object.values(teeSets)) {
        const yardage = ts.holes[holeNum];
        if (!yardage || yardage <= 0) continue;

        const distMeters = yardage * YARDS_TO_METERS;
        const teeCoord = projectPoint(green.lat, green.lon, greenToTeeBearing, distMeters);
        const isSynthesized = !hasTeeGeom;

        if (dryRun) {
          console.log(`[DRY] ${course.course_name} H${holeNum} ${ts.teeName}: (${teeCoord.lat.toFixed(6)}, ${teeCoord.lon.toFixed(6)}) ${yardage}yds bearing=${bearingSource}`);
          totalInserted++;
          continue;
        }

        await pool.query(`
          INSERT INTO golf_hole_tees (course_id, hole_number, tee_set_id, tee_name, lat, lon, location, yardage, is_synthesized, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography, $7, $8, now())
          ON CONFLICT (course_id, hole_number, tee_set_id) DO UPDATE SET
            tee_name = EXCLUDED.tee_name,
            lat = EXCLUDED.lat,
            lon = EXCLUDED.lon,
            location = EXCLUDED.location,
            yardage = EXCLUDED.yardage,
            is_synthesized = EXCLUDED.is_synthesized,
            updated_at = now()
        `, [courseId, holeNum, ts.teeSetId, ts.teeName, teeCoord.lat, teeCoord.lon, yardage, isSynthesized]);

        totalInserted++;
      }
    }

    if (courseHasTeePois) coursesWithTeePois++;
    else coursesWithoutTeePois++;
  }

  const stats = {
    totalInserted,
    totalSkipped,
    coursesWithTeePois,
    coursesWithoutTeePois,
    coursesProcessed: coursesRes.rows.length
  };

  console.log(`\n[SYNTH] ═══════════════════════════════════════`);
  console.log(`[SYNTH] Complete.`);
  console.log(`[SYNTH] Tee coordinates synthesized: ${totalInserted}`);
  console.log(`[SYNTH] Courses with real tee POIs:  ${coursesWithTeePois}`);
  console.log(`[SYNTH] Courses with synthetic only: ${coursesWithoutTeePois}`);
  console.log(`[SYNTH] Skipped (no tee sets):       ${totalSkipped}`);
  if (dryRun) console.log(`[SYNTH] ⚠️  DRY RUN — no database changes made`);
  console.log(`[SYNTH] ═══════════════════════════════════════`);

  return stats;
}

// CLI entry point
if (require.main === module) {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
  const { Pool } = require("pg");

  const dryRun = process.argv.includes("--dry-run");
  const courseIdIdx = process.argv.indexOf("--course-id");
  const courseId = courseIdIdx >= 0 ? process.argv[courseIdIdx + 1] : null;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  runSynthesis(pool, { courseId, dryRun })
    .then(() => pool.end())
    .catch((err) => {
      console.error("[SYNTH] Fatal error:", err);
      pool.end().then(() => process.exit(1));
    });
}

module.exports = { runSynthesis, bearingDeg, projectPoint };
