"use strict";

const express = require("express");
const router = express.Router();

const { buildCoverageReport, rankWeakest, rankStrongest } = require("../scripts/audit-hazard-coverage");
const { enrichCourse } = require("../services/osmEnricher");

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
    // Shot-outcome aggregates (P2 — structured outcomes). Computed cheaply over the
    // shot_outcomes table; safe-fallback to zeros when the table is missing.
    totalShotOutcomes: 0,
    shotSuccessRate: 0,
    dominantMissDirection: null,
    missDirectionCounts: { left: 0, right: 0, short: 0, long: 0 },
    topClubMissPatterns: [],
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

    // ── Shot outcome aggregates ────────────────────────────────────────────
    // Scoped to last 90 days so the dashboard reflects recent learning patterns
    // rather than getting drowned by long-tail historical data.
    const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const so = await pool.query(
        `SELECT
            COUNT(*)::int                                                           AS total,
            COUNT(*) FILTER (WHERE success)::int                                     AS successes,
            COUNT(*) FILTER (WHERE miss_direction = 'left')::int                     AS miss_left,
            COUNT(*) FILTER (WHERE miss_direction = 'right')::int                    AS miss_right,
            COUNT(*) FILTER (WHERE miss_direction = 'short')::int                    AS miss_short,
            COUNT(*) FILTER (WHERE miss_direction = 'long')::int                     AS miss_long
         FROM shot_outcomes
         WHERE recorded_at >= $1`,
        [ninetyDaysAgo]
      );
      const row = so.rows[0] || {};
      result.totalShotOutcomes = row.total || 0;
      result.shotSuccessRate   = row.total > 0 ? row.successes / row.total : 0;
      result.missDirectionCounts = {
        left:  row.miss_left  || 0,
        right: row.miss_right || 0,
        short: row.miss_short || 0,
        long:  row.miss_long  || 0
      };
      const dominantPair = Object.entries(result.missDirectionCounts)
        .sort((a, b) => b[1] - a[1])[0];
      result.dominantMissDirection = (dominantPair && dominantPair[1] > 0) ? dominantPair[0] : null;

      const clubAgg = await pool.query(
        `SELECT
            club_used,
            COUNT(*)::int                                       AS total,
            COUNT(*) FILTER (WHERE NOT success)::int            AS misses,
            COUNT(*) FILTER (WHERE miss_direction = 'left')::int  AS miss_left,
            COUNT(*) FILTER (WHERE miss_direction = 'right')::int AS miss_right
         FROM shot_outcomes
         WHERE club_used IS NOT NULL AND recorded_at >= $1
         GROUP BY club_used
         HAVING COUNT(*) >= 3
         ORDER BY (COUNT(*) FILTER (WHERE NOT success))::float / NULLIF(COUNT(*), 0) DESC, COUNT(*) DESC
         LIMIT 8`,
        [ninetyDaysAgo]
      );
      result.topClubMissPatterns = clubAgg.rows.map((r) => ({
        clubUsed: r.club_used,
        total: r.total,
        missRate: r.total > 0 ? r.misses / r.total : 0,
        leftPct:  r.total > 0 ? r.miss_left  / r.total : 0,
        rightPct: r.total > 0 ? r.miss_right / r.total : 0,
      }));
    } catch (err) {
      // Table missing or query error — leave fields at their zero defaults.
      console.warn("[ADMIN] shot_outcomes aggregate skipped:", err.message);
    }

    return res.json(result);
  } catch (err) {
    console.error("[ADMIN] Dashboard error:", err.message);
    return res.status(500).json({ error: "Dashboard query failed" });
  }
});

// ── Shot-outcome drill-down (founder analytics) ──
//
// Per-club, per-miss-side, per-user breakdowns over the last N days. Useful for
// spotting users with the strongest miss tendencies (potential personalization wins).
router.get("/shot-outcomes/summary", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.json({ ok: true, source: "no-db", clubs: [], topMissUsers: [], byHolePar: [] });

  const days = Math.min(Math.max(parseInt(req.query.days || "90", 10) || 90, 7), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [clubs, users, byPar] = await Promise.all([
      pool.query(
        `SELECT club_used,
                COUNT(*)::int                                            AS total,
                COUNT(*) FILTER (WHERE success)::int                     AS successes,
                COUNT(*) FILTER (WHERE miss_direction = 'left')::int     AS miss_left,
                COUNT(*) FILTER (WHERE miss_direction = 'right')::int    AS miss_right,
                COUNT(*) FILTER (WHERE miss_direction = 'short')::int    AS miss_short,
                COUNT(*) FILTER (WHERE miss_direction = 'long')::int     AS miss_long
         FROM shot_outcomes
         WHERE club_used IS NOT NULL AND recorded_at >= $1
         GROUP BY club_used
         ORDER BY total DESC
         LIMIT 30`,
        [since]
      ),
      pool.query(
        `SELECT user_id,
                COUNT(*)::int                                            AS total,
                COUNT(*) FILTER (WHERE success)::int                     AS successes,
                MODE() WITHIN GROUP (ORDER BY miss_direction)            AS dominant_miss,
                COUNT(*) FILTER (WHERE miss_direction = 'left')::int     AS miss_left,
                COUNT(*) FILTER (WHERE miss_direction = 'right')::int    AS miss_right
         FROM shot_outcomes
         WHERE user_id IS NOT NULL AND recorded_at >= $1
         GROUP BY user_id
         HAVING COUNT(*) >= 5
         ORDER BY (COUNT(*) FILTER (WHERE NOT success))::float / NULLIF(COUNT(*), 0) DESC, COUNT(*) DESC
         LIMIT 20`,
        [since]
      ),
      pool.query(
        `SELECT hole_par,
                COUNT(*)::int                                            AS total,
                COUNT(*) FILTER (WHERE success)::int                     AS successes
         FROM shot_outcomes
         WHERE hole_par IS NOT NULL AND recorded_at >= $1
         GROUP BY hole_par
         ORDER BY hole_par`,
        [since]
      )
    ]);

    return res.json({
      ok: true,
      source: "database",
      windowDays: days,
      clubs: clubs.rows.map((r) => ({
        clubUsed: r.club_used,
        total: r.total,
        successRate: r.total > 0 ? r.successes / r.total : 0,
        missLeftPct:  r.total > 0 ? r.miss_left  / r.total : 0,
        missRightPct: r.total > 0 ? r.miss_right / r.total : 0,
        missShortPct: r.total > 0 ? r.miss_short / r.total : 0,
        missLongPct:  r.total > 0 ? r.miss_long  / r.total : 0,
      })),
      topMissUsers: users.rows.map((r) => ({
        userId: r.user_id,
        total: r.total,
        successRate: r.total > 0 ? r.successes / r.total : 0,
        dominantMiss: r.dominant_miss,
        missLeftPct:  r.total > 0 ? r.miss_left  / r.total : 0,
        missRightPct: r.total > 0 ? r.miss_right / r.total : 0,
      })),
      byHolePar: byPar.rows.map((r) => ({
        par: r.hole_par,
        total: r.total,
        successRate: r.total > 0 ? r.successes / r.total : 0,
      }))
    });
  } catch (err) {
    // Likely table-missing — return empty but ok so the dashboard renders.
    console.warn("[ADMIN] shot-outcomes/summary fallback:", err.message);
    return res.json({ ok: true, source: "fallback", clubs: [], topMissUsers: [], byHolePar: [], windowDays: days });
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
//
// Behavior:
//   - With `courseId`: runs synchronously (bounded work, short request).
//   - Without `courseId` (full repopulate): accepts the request, returns 202 with a jobId,
//     runs synthesis in the background. Status is tracked in-memory via `synthesisJobs`.
//
// In-memory job store is intentional: this is an admin-only endpoint, the job is idempotent,
// and server restarts are acceptable (Render will just lose state; the next invocation
// starts a fresh job).

const { randomUUID } = require("crypto");

/**
 * @type {Map<string, {
 *   id: string,
 *   status: 'queued' | 'running' | 'completed' | 'failed',
 *   startedAt: string,
 *   finishedAt: string | null,
 *   stats: object | null,
 *   error: string | null,
 *   courseId: string | null
 * }>}
 */
const synthesisJobs = new Map();
const SYNTHESIS_JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function pruneSynthesisJobs() {
  const now = Date.now();
  for (const [jobId, job] of synthesisJobs.entries()) {
    const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : null;
    if (finishedAt && now - finishedAt > SYNTHESIS_JOB_TTL_MS) {
      synthesisJobs.delete(jobId);
    }
  }
}

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
      // Scoped synthesis: short, run synchronously so callers get the full result inline.
      const resolved = await resolveCourseId(pool, courseId);
      if (!resolved) {
        return res.status(404).json({ error: `Course not found: ${courseId}` });
      }
      courseId = resolved;
      console.log(`[ADMIN] Triggering tee synthesis for course ${courseId}...`);
      const stats = await runSynthesis(pool, { courseId });
      return res.json({ ok: true, mode: "sync", stats });
    }

    // Full synthesis across ~19k courses: MUST be async. Return 202 + jobId immediately.
    pruneSynthesisJobs();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    synthesisJobs.set(jobId, {
      id: jobId,
      status: "queued",
      startedAt: now,
      finishedAt: null,
      stats: null,
      error: null,
      courseId: null
    });

    // Fire-and-forget. Wrapped so a throw never escapes to the event loop.
    setImmediate(async () => {
      const job = synthesisJobs.get(jobId);
      if (!job) return;
      job.status = "running";
      console.log(`[ADMIN] [SYNTHESIS JOB ${jobId}] starting (all courses)`);
      try {
        const stats = await runSynthesis(pool, {});
        job.stats = stats;
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        console.log(`[ADMIN] [SYNTHESIS JOB ${jobId}] completed`, stats);
      } catch (err) {
        job.status = "failed";
        job.error = err?.message || String(err);
        job.finishedAt = new Date().toISOString();
        console.error(`[ADMIN] [SYNTHESIS JOB ${jobId}] failed:`, err?.message || err);
      }
    });

    return res.status(202).json({
      jobId,
      status: "queued",
      statusUrl: `/api/admin/synthesis-status/${jobId}`
    });
  } catch (err) {
    console.error("[ADMIN] Synthesis error:", err.message);
    return res.status(500).json({ error: "Synthesis failed", message: err.message });
  }
});

router.get("/synthesis-status/:jobId", (req, res) => {
  pruneSynthesisJobs();
  const job = synthesisJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  return res.json(job);
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

/**
 * GET /api/admin/hazard-coverage
 *
 * Hazard POI coverage health across the entire course database.
 * Reuses the same scoring logic as scripts/audit-hazard-coverage.js so
 * CLI and admin dashboard can never disagree.
 *
 * Query params:
 *   ?top=50           — number of weakest/strongest courses to return (default 50, cap 200)
 */
router.get("/hazard-coverage", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  const top = Math.min(parseInt(req.query.top, 10) || 50, 200);

  try {
    const report = await buildCoverageReport(pool, { includePerHole: false });
    return res.json({
      totalCourses: report.summary.totalCourses,
      totalHoles: report.summary.totalHoles,
      totalUsableHazards: report.summary.totalUsableHazards,
      avgCoveragePct: report.summary.avgCoveragePct,
      avgCoverageScore: report.summary.avgCoverageScore,
      coursesWithNoHazards: report.summary.coursesWithNoHazards,
      coursesWithLowCoverage: report.summary.coursesWithLowCoverage,
      normalizedTypeCounts: report.summary.normalizedTypeCounts,
      weakestCourses: rankWeakest(report.courses, top),
      strongestCourses: rankStrongest(report.courses, top)
    });
  } catch (err) {
    console.error("[ADMIN] hazard-coverage error:", err.message);
    return res.status(500).json({ error: "Hazard coverage query failed" });
  }
});

/**
 * GET /api/admin/hazard-coverage/:courseId
 *
 * Per-hole hazard breakdown for a specific course. Accepts either the
 * internal UUID or the external course_id (matches resolveCourseId logic).
 */
router.get("/hazard-coverage/:courseId", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  const lookup = String(req.params.courseId || "").trim();
  if (!lookup) return res.status(400).json({ error: "courseId required" });

  try {
    const report = await buildCoverageReport(pool, { includePerHole: true });
    const match = report.courses.find(
      (c) => c.courseId === lookup || c.courseExternalId === lookup
    );
    if (!match) return res.status(404).json({ error: "Course not found" });
    return res.json(match);
  } catch (err) {
    console.error("[ADMIN] hazard-coverage detail error:", err.message);
    return res.status(500).json({ error: "Hazard coverage detail query failed" });
  }
});

/**
 * POST /api/admin/osm-batch
 *
 * Bounded validation trigger for the batch enricher. NOT the production
 * tool — scripts/osm-enrich-batch.js is the production tool.
 *
 * This endpoint exists so operators can sanity-check the pipeline
 * end-to-end without DATABASE_URL access. It is intentionally capped:
 *   - limit ≤ 10 courses
 *   - hard timeout 90 s
 *   - apply mode requires explicit ?apply=1
 *
 * Full-scale enrichment (hundreds or thousands of courses) MUST be run
 * via the CLI script:
 *   node scripts/osm-enrich-batch.js --limit=200 --apply
 */
router.post("/osm-batch", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 10);
  const apply = req.query.apply === "1" || req.query.apply === "true";
  const delayMs = Math.min(parseInt(req.query["delay-ms"], 10) || 1500, 5000);

  // The batch run() takes its own pool. We pass DATABASE_URL through
  // env to keep the API surface unchanged.
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "DATABASE_URL not configured for batch trigger" });
  }

  const args = {
    apply,
    limit,
    minScore: -1,
    maxScore: 50,
    delayMs,
    maxQueriesPerRun: limit + 5,    // generous but bounded
    retryFailed: false,
    cooldownDays: 14,
    courseId: null,
    verbose: false,
    bounded: true                   // marker for diagnostics
  };

  // Capture the run via a separate Pool so the request handler doesn't
  // hold one of the dyno's main connections for the whole batch.
  const { Pool } = require("pg");
  const isolatedPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 3
  });

  // The run() function in the batch script ends its own pool when done.
  // Here we override its DB by stubbing process.env temporarily — but
  // simpler: import the orchestrator helpers directly and call them
  // with our isolatedPool. We rebuild the loop inline to avoid coupling.
  try {
    const { buildQueue } = require("../scripts/osm-enrich-batch");
    const { enrichCourse } = require("../services/osmEnricher");

    const log = (m) => console.log(`[OSM BATCH BOUNDED] ${m}`);
    log(`mode=${apply ? "APPLY" : "DRY"} limit=${limit}`);

    const startRes = await isolatedPool.query(
      `INSERT INTO osm_enrichment_runs (mode, args_json, status)
       VALUES ($1, $2::jsonb, 'running')
       RETURNING run_id`,
      [apply ? "apply" : "dry", JSON.stringify(args)]
    );
    const runId = startRes.rows[0].run_id;

    const queue = await buildQueue(isolatedPool, args, log);

    await isolatedPool.query(
      `UPDATE osm_enrichment_runs SET queue_size = $2 WHERE run_id = $1`,
      [runId, queue.length]
    );

    const counters = { queueSize: queue.length, processed: 0, succeeded: 0, failed: 0, skipped: 0, totalInserted: 0 };
    const winners = [];

    const deadline = Date.now() + 90_000;
    for (let i = 0; i < queue.length; i++) {
      if (Date.now() >= deadline) {
        log("90 s timeout — stopping early");
        break;
      }
      const c = queue[i];
      const t0 = Date.now();
      let result;
      try {
        const trace = await enrichCourse(isolatedPool, c.courseId, { dryRun: !apply, maxFeatures: 2000 });
        if (trace.error) result = { status: "no_geometry", trace };
        else if (trace.osmFeaturesFetched === 0) result = { status: "no_features", trace };
        else result = { status: "success", trace };
      } catch (err) {
        result = { status: "overpass_error", error: String(err.message || err) };
      }

      counters.processed++;
      const trace = result.trace || {};
      const inserted = apply ? (trace.inserted || 0) : 0;
      const proposed = (trace.proposedRows || []).length;

      if (result.status === "success") {
        counters.succeeded++;
        counters.totalInserted += inserted;
        const before = c.hazardCoverageScore;
        // Cheap after-score: count distinct holes with hazards quickly
        let after = before;
        if (apply && inserted > 0) {
          const r = await isolatedPool.query(
            `SELECT COUNT(*) FILTER (WHERE n > 0)::int AS holes_with_hazards
               FROM (SELECT hole_number, COUNT(*) AS n
                       FROM golf_hole_pois
                      WHERE course_id = $1
                        AND LOWER(TRIM(poi_type)) NOT IN ('green','tee','tee front','tee back')
                      GROUP BY hole_number) h`,
            [c.courseId]
          );
          // Quick & dirty post-score from holes-with-hazards portion (40 pts) + bunkers proxy
          const holesWithHazards = r.rows[0].holes_with_hazards;
          after = Math.min(100, Math.round((holesWithHazards / Math.max(1, c.totalHoles)) * 40 + 50));
        }
        winners.push({ name: c.courseName, before, after, delta: after - before, inserted });
        await isolatedPool.query(
          `INSERT INTO osm_enrichment_attempts
             (run_id, course_id, course_name, status, before_score, after_score, proposed, inserted, trace_summary)
           VALUES ($1, $2, $3, 'success', $4, $5, $6, $7, $8::jsonb)`,
          [runId, c.courseId, c.courseName, before, after, proposed, inserted, JSON.stringify({
            osmFeaturesFetched: trace.osmFeaturesFetched,
            insertedByType: trace.insertedByType,
            insertedByHole: trace.insertedByHole
          })]
        );
        log(`  [${i+1}/${queue.length}] ${c.courseName} ${apply?"INSERTED":"PROPOSED"}=${apply?inserted:proposed} elapsed=${Date.now()-t0}ms`);
      } else {
        counters.skipped++;
        await isolatedPool.query(
          `INSERT INTO osm_enrichment_attempts
             (run_id, course_id, course_name, status, before_score, after_score, reason)
           VALUES ($1, $2, $3, $4, $5, $5, $6)`,
          [runId, c.courseId, c.courseName, result.status, c.hazardCoverageScore, result.error || result.status]
        );
        log(`  [${i+1}/${queue.length}] ${c.courseName} skipped=${result.status}`);
      }

      await isolatedPool.query(
        `UPDATE osm_enrichment_runs
            SET processed=$2, succeeded=$3, failed=$4, skipped=$5, total_inserted=$6
          WHERE run_id=$1`,
        [runId, counters.processed, counters.succeeded, counters.failed, counters.skipped, counters.totalInserted]
      );

      if (i < queue.length - 1) await new Promise((r) => setTimeout(r, delayMs));
    }

    await isolatedPool.query(
      `UPDATE osm_enrichment_runs SET completed_at = now(), status = 'complete' WHERE run_id = $1`,
      [runId]
    );

    return res.json({
      runId,
      mode: apply ? "apply" : "dry",
      bounded: true,
      counters,
      winners: winners.sort((a, b) => b.delta - a.delta).slice(0, 10),
      note: "Bounded validation trigger. For full-scale enrichment, use scripts/osm-enrich-batch.js with DATABASE_URL."
    });
  } catch (err) {
    console.error("[ADMIN] osm-batch error:", err.message, err.stack);
    return res.status(500).json({ error: "Bounded batch failed", detail: err.message });
  } finally {
    isolatedPool.end().catch(() => {});
  }
});

/**
 * GET /api/admin/osm-batch-status
 *
 * Read-only observability for the batch OSM enrichment script.
 * Returns:
 *   - latestRun: most recent run summary (counts, status, timestamps)
 *   - recentRuns: last N runs (default 10)
 *   - queueDepth: an approximate count of courses still eligible for enrichment
 *                 (coverageScore < 50, never successfully enriched, has greens)
 *   - sourceBreakdown: native vs OSM POI totals
 *
 * This endpoint never triggers work. The batch is a CLI script invoked
 * out-of-band; this endpoint is purely for founder/operator visibility.
 */
router.get("/osm-batch-status", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.status(503).json({ error: "Database unavailable" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  try {
    const [latestRes, recentRes, sourceRes, queueDepthRes] = await Promise.all([
      pool.query(`
        SELECT run_id, started_at, completed_at, mode, status,
               queue_size, processed, succeeded, failed, skipped, total_inserted, notes
          FROM osm_enrichment_runs
         ORDER BY started_at DESC
         LIMIT 1
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT run_id, started_at, completed_at, mode, status,
               queue_size, processed, succeeded, failed, skipped, total_inserted
          FROM osm_enrichment_runs
         ORDER BY started_at DESC
         LIMIT $1
      `, [limit]).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE source_type = 'source_native')          AS native_count,
          COUNT(*) FILTER (WHERE source_type = 'source_osm')             AS osm_count,
          COUNT(*) FILTER (WHERE source_type = 'source_user_reported')   AS user_count,
          COUNT(*) FILTER (WHERE source_type = 'source_admin_verified')  AS admin_count
        FROM golf_hole_pois
      `).catch(() => ({ rows: [{}] })),
      // Approx queue depth: courses with green geometry that have never had a
      // 'success' attempt. This is intentionally cheap — operator-grade
      // visibility, not pixel-perfect.
      pool.query(`
        WITH greens AS (
          SELECT DISTINCT course_id
            FROM golf_hole_pois
           WHERE LOWER(TRIM(poi_type)) = 'green'
        ),
        successes AS (
          SELECT DISTINCT course_id FROM osm_enrichment_attempts WHERE status = 'success'
        )
        SELECT COUNT(*)::int AS pending
          FROM greens g
          LEFT JOIN successes s USING (course_id)
         WHERE s.course_id IS NULL
      `).catch(() => ({ rows: [{ pending: null }] }))
    ]);

    return res.json({
      latestRun: latestRes.rows[0] || null,
      recentRuns: recentRes.rows,
      sourceBreakdown: {
        native: Number(sourceRes.rows[0]?.native_count || 0),
        osm: Number(sourceRes.rows[0]?.osm_count || 0),
        user_reported: Number(sourceRes.rows[0]?.user_count || 0),
        admin_verified: Number(sourceRes.rows[0]?.admin_count || 0)
      },
      queueDepth: queueDepthRes.rows[0]?.pending ?? null
    });
  } catch (err) {
    console.error("[ADMIN] osm-batch-status:", err.message);
    return res.status(500).json({ error: "Status query failed", detail: err.message });
  }
});

/**
 * POST /api/admin/enrich-osm/:courseId
 *
 * Additive OSM hazard enrichment for a single course.
 *
 * SAFETY:
 *   - Default mode is dry-run: returns proposed inserts WITHOUT writing.
 *   - To actually write, pass `?apply=1`.
 *   - Never overwrites source_native data; deduplicates against existing
 *     native + OSM rows. All inserts are tagged source_type='source_osm'
 *     with confidence < 1.0 so downstream code can weight trust.
 *
 * Response:
 *   - courseUuid, courseName, dryRun
 *   - osmFeaturesFetched, osmFeaturesMapped
 *   - skippedNoCenter / skippedOutsideHoles / skippedDuplicateOf{Native,Osm}
 *   - inserted (only when apply=1)
 *   - insertedByType, insertedByHole
 *   - proposedRows[]  (what would be / was inserted)
 */
router.post("/enrich-osm/:courseId", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  const courseUuid = String(req.params.courseId || "").trim();
  if (!courseUuid) return res.status(400).json({ error: "courseId required" });

  const apply = req.query.apply === "1" || req.query.apply === "true";
  const maxFeatures = Math.min(parseInt(req.query.max, 10) || 2000, 5000);

  try {
    const trace = await enrichCourse(pool, courseUuid, {
      dryRun: !apply,
      maxFeatures
    });
    return res.json(trace);
  } catch (err) {
    console.error("[ADMIN] enrich-osm error:", err.message);
    return res.status(500).json({ error: "OSM enrichment failed", detail: err.message });
  }
});

module.exports = router;
