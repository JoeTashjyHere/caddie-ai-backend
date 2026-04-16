"use strict";

const express = require("express");
const router = express.Router();

router.get("/dashboard", async (req, res) => {
  const pool = req.app.get("dbPool");

  const result = {
    totalUsers: 0,
    dailyActiveUsers: 0,
    weeklyActiveUsers: 0,
    totalRounds: 0,
    totalShots: 0,
    totalPutts: 0,
    onboardingCompletionRate: 0,
    avgRoundsPerUser: 0,
    totalRecommendations: 0,
    normalizationRate: 0,
    fallbackRate: 0,
  };

  if (!pool) {
    return res.json(result);
  }

  try {
    const recCountResult = await pool.query(
      "SELECT COUNT(*)::int AS n FROM recommendation_events"
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.totalRecommendations = recCountResult.rows[0]?.n ?? 0;

    const normResult = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE output_json->>'normalizationOccurred' = 'true')::int AS norm,
        COUNT(*) FILTER (WHERE output_json->>'fallbackOccurred' = 'true')::int AS fb,
        COUNT(*)::int AS total
       FROM recommendation_events`
    ).catch(() => ({ rows: [{ norm: 0, fb: 0, total: 0 }] }));

    const nr = normResult.rows[0] || {};
    const total = nr.total || 1;
    result.normalizationRate = nr.norm / total;
    result.fallbackRate = nr.fb / total;

    const userResult = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM recommendation_events WHERE user_id IS NOT NULL`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.totalUsers = userResult.rows[0]?.n ?? 0;

    const now = new Date();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    const dauResult = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM recommendation_events WHERE created_at >= $1 AND user_id IS NOT NULL`,
      [dayAgo]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.dailyActiveUsers = dauResult.rows[0]?.n ?? 0;

    const wauResult = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM recommendation_events WHERE created_at >= $1 AND user_id IS NOT NULL`,
      [weekAgo]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.weeklyActiveUsers = wauResult.rows[0]?.n ?? 0;

    const shotCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM recommendation_events WHERE recommendation_type = 'shot'`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.totalShots = shotCount.rows[0]?.n ?? 0;

    const puttCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM recommendation_events WHERE recommendation_type = 'putt'`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    result.totalPutts = puttCount.rows[0]?.n ?? 0;

    if (result.totalUsers > 0) {
      result.avgRoundsPerUser = result.totalRounds / result.totalUsers;
    }

    return res.json(result);
  } catch (err) {
    console.error("[ADMIN] Dashboard error:", err.message);
    return res.status(500).json({ error: "Dashboard query failed" });
  }
});

// ── Course Geometry / Map Alignment Health ─────────────────────────────────

router.get("/geometry-health", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) {
    return res.json({ courses: [], summary: {} });
  }

  try {
    const coursesRes = await pool.query(
      `SELECT gc.id, gc.course_name, c.city AS club_city, c.state AS club_state
       FROM golf_courses gc
       JOIN golf_clubs c ON gc.club_id = c.id
       ORDER BY gc.course_name`
    );

    let hasHoleTeesTable = false;
    try {
      await pool.query("SELECT 1 FROM golf_hole_tees LIMIT 0");
      hasHoleTeesTable = true;
    } catch { /* table doesn't exist yet */ }

    const courses = [];
    let totalHoles = 0;
    let holesWithRealTee = 0;
    let holesWithSynthTee = 0;
    let holesWithFallbackTee = 0;
    let holesWithValidBearing = 0;
    let holesWithFallbackNorth = 0;
    let holesMapAlignReady = 0;

    for (const course of coursesRes.rows) {
      const uuid = course.id;

      const [greenRes, legacyTeeRes, holeTeesRes, holesRes, hazardCountRes] = await Promise.all([
        pool.query(
          `SELECT hole_number, UPPER(TRIM(COALESCE(location_label, ''))) AS loc, lat, lon
           FROM golf_hole_pois WHERE course_id = $1 AND LOWER(TRIM(poi_type)) = 'green'
           ORDER BY hole_number`, [uuid]
        ),
        pool.query(
          `SELECT hole_number, LOWER(TRIM(poi_type)) AS poi_type, lat, lon
           FROM golf_hole_pois WHERE course_id = $1
             AND LOWER(TRIM(poi_type)) IN ('tee', 'tee front', 'tee back')
           ORDER BY hole_number`, [uuid]
        ),
        hasHoleTeesTable
          ? pool.query(
              `SELECT hole_number, tee_set_id, tee_name, lat, lon, yardage, is_synthesized
               FROM golf_hole_tees WHERE course_id = $1
               ORDER BY hole_number, tee_name`, [uuid]
            )
          : Promise.resolve({ rows: [] }),
        pool.query(
          `SELECT hole_number, par FROM golf_course_holes WHERE course_id = $1 ORDER BY hole_number`, [uuid]
        ),
        pool.query(
          `SELECT hole_number, COUNT(*)::int AS cnt FROM golf_hole_pois
           WHERE course_id = $1 AND LOWER(TRIM(poi_type)) NOT IN ('green', 'tee', 'tee front', 'tee back')
           GROUP BY hole_number`, [uuid]
        )
      ]);

      const greenByHole = {};
      for (const r of greenRes.rows) {
        if (!greenByHole[r.hole_number]) greenByHole[r.hole_number] = {};
        const g = greenByHole[r.hole_number];
        const coord = { lat: Number(r.lat), lon: Number(r.lon) };
        if (r.loc === "C") g.center = coord;
        else if (!g.center) g.center = coord;
      }

      const legacyByHole = {};
      for (const r of legacyTeeRes.rows) {
        if (!legacyByHole[r.hole_number]) legacyByHole[r.hole_number] = {};
        const h = legacyByHole[r.hole_number];
        const coord = { lat: Number(r.lat), lon: Number(r.lon) };
        if (r.poi_type === "tee front" || r.poi_type === "tee") {
          if (!h.tee_front) h.tee_front = coord;
        }
        if (r.poi_type === "tee back") h.tee_back = coord;
      }

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

      const hazardCountByHole = {};
      for (const r of hazardCountRes.rows) {
        hazardCountByHole[r.hole_number] = r.cnt;
      }

      const { assessGeometryQuality, bearingDeg } = require("../services/courseIntelligence");

      const holeDetails = [];
      let courseRealTee = 0, courseSynthTee = 0, courseFallback = 0;
      let courseValidBearing = 0, courseFallbackNorth = 0, courseMapReady = 0;

      for (const h of holesRes.rows) {
        const hn = h.hole_number;
        const greenCenter = greenByHole[hn]?.center || null;
        const legacy = legacyByHole[hn] || {};
        const holeTees = holeTeesByHole[hn] || [];
        const quality = assessGeometryQuality(greenCenter, holeTees, legacy);

        totalHoles++;
        if (quality.tee_anchor_quality === "REAL") { holesWithRealTee++; courseRealTee++; }
        else if (quality.tee_anchor_quality === "SYNTH_FROM_POI") { holesWithSynthTee++; courseSynthTee++; }
        else { holesWithFallbackTee++; courseFallback++; }

        if (quality.bearing_quality === "VALID_REAL" || quality.bearing_quality === "VALID_SYNTH") {
          holesWithValidBearing++; courseValidBearing++;
        } else if (quality.bearing_quality === "FALLBACK_NORTH") {
          holesWithFallbackNorth++; courseFallbackNorth++;
        }

        if (quality.map_alignment_ready) { holesMapAlignReady++; courseMapReady++; }

        holeDetails.push({
          hole_number: hn,
          par: h.par,
          tee_source: quality.tee_anchor_quality,
          green_source: greenCenter ? "REAL" : "MISSING",
          bearing: quality.computed_bearing,
          bearing_quality: quality.bearing_quality,
          map_alignment_ready: quality.map_alignment_ready,
          fallback_warning: quality.bearing_quality === "FALLBACK_NORTH",
          hazard_count: hazardCountByHole[hn] || 0
        });
      }

      const numHoles = holesRes.rows.length || 1;
      const geometryScore = Math.round((courseMapReady / numHoles) * 100);

      courses.push({
        id: uuid,
        name: course.course_name,
        city: course.club_city,
        state: course.club_state,
        num_holes: holesRes.rows.length,
        geometry_score: geometryScore,
        real_tee_pct: Math.round((courseRealTee / numHoles) * 100),
        synth_tee_pct: Math.round((courseSynthTee / numHoles) * 100),
        fallback_tee_pct: Math.round((courseFallback / numHoles) * 100),
        valid_bearing_pct: Math.round((courseValidBearing / numHoles) * 100),
        fallback_north_pct: Math.round((courseFallbackNorth / numHoles) * 100),
        map_alignment_ready_pct: Math.round((courseMapReady / numHoles) * 100),
        holes: holeDetails
      });
    }

    const safeTotalHoles = totalHoles || 1;
    return res.json({
      summary: {
        total_courses: courses.length,
        total_holes: totalHoles,
        avg_geometry_score: Math.round(courses.reduce((s, c) => s + c.geometry_score, 0) / (courses.length || 1)),
        real_tee_pct: Math.round((holesWithRealTee / safeTotalHoles) * 100),
        synth_tee_pct: Math.round((holesWithSynthTee / safeTotalHoles) * 100),
        fallback_tee_pct: Math.round((holesWithFallbackTee / safeTotalHoles) * 100),
        valid_bearing_pct: Math.round((holesWithValidBearing / safeTotalHoles) * 100),
        fallback_north_pct: Math.round((holesWithFallbackNorth / safeTotalHoles) * 100),
        map_alignment_ready_pct: Math.round((holesMapAlignReady / safeTotalHoles) * 100)
      },
      courses
    });
  } catch (err) {
    console.error("[ADMIN] Geometry health error:", err.message);
    return res.status(500).json({ error: "Geometry health query failed" });
  }
});

// ── On-demand tee synthesis trigger ──────────────────────────────────────────

router.post("/synthesize-tees", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const { runSynthesis } = require("../scripts/synthesize-hole-tees");
    const { resolveCourseId } = require("../services/courseIntelligence");
    let courseId = req.body?.courseId || req.query?.courseId || null;
    if (courseId) {
      const resolved = await resolveCourseId(pool, courseId);
      if (!resolved) {
        return res.status(404).json({ error: `Course not found: ${courseId}` });
      }
      courseId = resolved;
    }
    console.log(`[ADMIN] Triggering tee synthesis${courseId ? ` for course ${courseId}` : " (all courses)"}...`);
    const stats = await runSynthesis(pool, { courseId });
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error("[ADMIN] Synthesis error:", err.message);
    return res.status(500).json({ error: "Synthesis failed", message: err.message });
  }
});

// ── Per-course hole audit (for debugging specific courses like Herndon) ─────

router.get("/course-audit/:courseId", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const { resolveCourseId, bearingDeg } = require("../services/courseIntelligence");
    const uuid = await resolveCourseId(pool, req.params.courseId);
    if (!uuid) {
      return res.status(404).json({ error: "Course not found" });
    }

    const courseRes = await pool.query(
      `SELECT gc.course_name, c.city, c.state
       FROM golf_courses gc JOIN golf_clubs c ON gc.club_id = c.id
       WHERE gc.id = $1`, [uuid]
    );

    let hasHoleTeesTable = false;
    try { await pool.query("SELECT 1 FROM golf_hole_tees LIMIT 0"); hasHoleTeesTable = true; } catch {}

    const [greenRes, teePoisRes, holeTeesRes, holesRes] = await Promise.all([
      pool.query(
        `SELECT hole_number, UPPER(TRIM(COALESCE(location_label, ''))) AS loc, lat, lon
         FROM golf_hole_pois WHERE course_id = $1 AND LOWER(TRIM(poi_type)) = 'green'
         ORDER BY hole_number, location_label`, [uuid]
      ),
      pool.query(
        `SELECT hole_number, poi_type, location_label, lat, lon
         FROM golf_hole_pois WHERE course_id = $1
           AND LOWER(TRIM(poi_type)) IN ('tee', 'tee front', 'tee back')
         ORDER BY hole_number, poi_type`, [uuid]
      ),
      hasHoleTeesTable
        ? pool.query(
            `SELECT hole_number, tee_set_id, tee_name, lat, lon, yardage, is_synthesized
             FROM golf_hole_tees WHERE course_id = $1
             ORDER BY hole_number, tee_name`, [uuid]
          )
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT hole_number, par FROM golf_course_holes WHERE course_id = $1 ORDER BY hole_number`, [uuid]
      )
    ]);

    const greenByHole = {};
    for (const r of greenRes.rows) {
      if (!greenByHole[r.hole_number]) greenByHole[r.hole_number] = {};
      const coord = { lat: Number(r.lat), lon: Number(r.lon) };
      if (r.loc === "C") greenByHole[r.hole_number].center = coord;
      else if (r.loc === "F") greenByHole[r.hole_number].front = coord;
      else if (r.loc === "B") greenByHole[r.hole_number].back = coord;
      else if (!greenByHole[r.hole_number].center) greenByHole[r.hole_number].center = coord;
    }

    const teePoisByHole = {};
    for (const r of teePoisRes.rows) {
      if (!teePoisByHole[r.hole_number]) teePoisByHole[r.hole_number] = [];
      teePoisByHole[r.hole_number].push({
        poi_type: r.poi_type,
        location_label: r.location_label,
        lat: Number(r.lat),
        lon: Number(r.lon)
      });
    }

    const holeTeesByHole = {};
    for (const r of holeTeesRes.rows) {
      if (!holeTeesByHole[r.hole_number]) holeTeesByHole[r.hole_number] = [];
      holeTeesByHole[r.hole_number].push({
        tee_set_id: r.tee_set_id,
        tee_name: r.tee_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        yardage: r.yardage,
        is_synthesized: r.is_synthesized
      });
    }

    const holes = holesRes.rows.map(h => {
      const hn = h.hole_number;
      const green = greenByHole[hn] || {};
      const teePois = teePoisByHole[hn] || [];
      const holeTees = holeTeesByHole[hn] || [];

      const teeFront = teePois.find(p => p.poi_type.toLowerCase().trim() === "tee front");
      const teeBack = teePois.find(p => p.poi_type.toLowerCase().trim() === "tee back");
      const greenCenter = green.center || null;

      let poiBearing = null;
      let bearingSource = "NONE";
      if (greenCenter && (teeFront || teeBack)) {
        const ref = (teeFront && teeBack)
          ? { lat: (teeFront.lat + teeBack.lat) / 2, lon: (teeFront.lon + teeBack.lon) / 2 }
          : (teeFront || teeBack);
        poiBearing = Math.round(bearingDeg(ref.lat, ref.lon, greenCenter.lat, greenCenter.lon) * 10) / 10;
        bearingSource = "POI";
      }

      const synthBearings = holeTees.map(t => ({
        tee_name: t.tee_name,
        bearing: greenCenter
          ? Math.round(bearingDeg(t.lat, t.lon, greenCenter.lat, greenCenter.lon) * 10) / 10
          : null,
        is_synthesized: t.is_synthesized
      }));

      return {
        hole_number: hn,
        par: h.par,
        green: green,
        tee_pois: teePois,
        has_tee_front: !!teeFront,
        has_tee_back: !!teeBack,
        has_green_center: !!greenCenter,
        poi_bearing: poiBearing,
        bearing_source: bearingSource,
        hole_tees_count: holeTees.length,
        hole_tees: holeTees,
        synth_bearings: synthBearings,
        tee_quality: teePois.length > 0 ? "REAL" : "MISSING",
        bearing_quality: poiBearing !== null ? "VALID" : (holeTees.length > 0 ? "SYNTH" : "FALLBACK")
      };
    });

    return res.json({
      course: {
        id: uuid,
        name: courseRes.rows[0]?.course_name,
        city: courseRes.rows[0]?.city,
        state: courseRes.rows[0]?.state
      },
      has_hole_tees_table: hasHoleTeesTable,
      total_hole_tees: holeTeesRes.rows.length,
      holes
    });
  } catch (err) {
    console.error("[ADMIN] Course audit error:", err.message);
    return res.status(500).json({ error: "Course audit failed", message: err.message });
  }
});

router.get("/users", async (req, res) => {
  const pool = req.app.get("dbPool");

  if (!pool) {
    return res.json([]);
  }

  try {
    const result = await pool.query(`
      SELECT
        user_id AS id,
        user_id AS name,
        MAX(created_at) AS "lastActiveAt",
        COUNT(*)::int AS "roundsPlayed",
        COUNT(*) FILTER (WHERE recommendation_type = 'shot')::int AS shots,
        COUNT(*) FILTER (WHERE recommendation_type = 'putt')::int AS putts
      FROM recommendation_events
      WHERE user_id IS NOT NULL
      GROUP BY user_id
      ORDER BY MAX(created_at) DESC
      LIMIT 200
    `);

    const users = result.rows.map((r) => ({
      id: r.id,
      userId: r.id,
      name: r.name || "Unknown",
      email: null,
      phone: null,
      handicap: null,
      roundsPlayed: r.roundsPlayed || 0,
      lastActiveAt: r.lastActiveAt,
      clubCount: 0,
    }));

    return res.json(users);
  } catch (err) {
    console.error("[ADMIN] Users error:", err.message);
    return res.status(500).json({ error: "Users query failed" });
  }
});

module.exports = router;
