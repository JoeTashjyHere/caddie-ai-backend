#!/usr/bin/env node
"use strict";

/**
 * osm-enrich-batch.js
 *
 * Production-grade batch OSM hazard enricher.
 *
 * Reuses services/osmEnricher.js as the per-course primitive; this file
 * is purely orchestration. It is the natural successor to the per-course
 * admin endpoint POST /api/admin/enrich-osm/:courseId.
 *
 * USAGE
 *   # Preview top 25 weakest courses, no DB writes
 *   node scripts/osm-enrich-batch.js --limit=25
 *
 *   # Apply enrichment to top 25 weakest courses, real writes
 *   node scripts/osm-enrich-batch.js --limit=25 --apply
 *
 *   # Apply with custom throttle (default 1500 ms between Overpass calls)
 *   node scripts/osm-enrich-batch.js --limit=100 --apply --delay-ms=2000
 *
 *   # Resume an aborted run (default behavior — successful courses are skipped)
 *   node scripts/osm-enrich-batch.js --limit=200 --apply
 *
 *   # Force re-attempt courses that failed within the last 7 days
 *   node scripts/osm-enrich-batch.js --limit=50 --apply --retry-failed
 *
 * SAFETY POSTURE
 *   - Default mode is DRY RUN. --apply is required to write.
 *   - Sequential by default (concurrency=1) — no Overpass spam.
 *   - Inter-request delay (default 1500 ms) honors public Overpass etiquette.
 *   - Exponential backoff on 429/504/timeout: 5s -> 15s -> 45s.
 *   - --max-queries-per-run hard cap (default 2000) so a runaway job can't
 *     burn the daily Overpass quota.
 *   - Every course attempt is persisted to osm_enrichment_attempts so the
 *     run is fully resumable across redeploys, Ctrl-C, and operator handoff.
 *   - SIGINT (Ctrl-C) is trapped: the run is marked 'aborted' cleanly
 *     and the most recent attempt is finalized before exit.
 */

const { Pool } = require("pg");
require("dotenv").config();

const { enrichCourse } = require("../services/osmEnricher");
const { buildCoverageReport } = require("./audit-hazard-coverage");

// ── CLI parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    apply: false,
    limit: 25,
    minScore: -1,                   // include all weak by default
    maxScore: 50,                   // skip courses already at moderate+
    delayMs: 1500,
    maxQueriesPerRun: 2000,
    retryFailed: false,
    cooldownDays: 14,               // re-attempt successful courses after this
    courseId: null,                 // run only one course (escape hatch)
    verbose: false
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.split("=")[1], 10) || 25;
    else if (a.startsWith("--min-score=")) args.minScore = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--max-score=")) args.maxScore = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--delay-ms=")) args.delayMs = parseInt(a.split("=")[1], 10) || 1500;
    else if (a.startsWith("--max-queries-per-run=")) args.maxQueriesPerRun = parseInt(a.split("=")[1], 10) || 2000;
    else if (a.startsWith("--cooldown-days=")) args.cooldownDays = parseInt(a.split("=")[1], 10) || 14;
    else if (a.startsWith("--course-id=")) args.courseId = a.split("=")[1];
  }
  return args;
}

// ── Run lifecycle ─────────────────────────────────────────────────────

async function startRun(pool, args) {
  const res = await pool.query(
    `INSERT INTO osm_enrichment_runs (mode, args_json, status)
     VALUES ($1, $2::jsonb, 'running')
     RETURNING run_id, started_at`,
    [args.apply ? "apply" : "dry", JSON.stringify(args)]
  );
  return res.rows[0];
}

async function updateRunCounters(pool, runId, counters) {
  await pool.query(
    `UPDATE osm_enrichment_runs
        SET queue_size     = $2,
            processed      = $3,
            succeeded      = $4,
            failed         = $5,
            skipped        = $6,
            total_inserted = $7
      WHERE run_id = $1`,
    [
      runId,
      counters.queueSize,
      counters.processed,
      counters.succeeded,
      counters.failed,
      counters.skipped,
      counters.totalInserted
    ]
  );
}

async function finishRun(pool, runId, status, notes) {
  await pool.query(
    `UPDATE osm_enrichment_runs
        SET completed_at = now(),
            status       = $2,
            notes        = $3
      WHERE run_id = $1`,
    [runId, status, notes || null]
  );
}

async function recordAttempt(pool, runId, attempt) {
  await pool.query(
    `INSERT INTO osm_enrichment_attempts
       (run_id, course_id, course_name, status,
        before_score, after_score, proposed, inserted,
        reason, trace_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      runId,
      attempt.courseId,
      attempt.courseName || null,
      attempt.status,
      attempt.beforeScore != null ? attempt.beforeScore : null,
      attempt.afterScore != null ? attempt.afterScore : null,
      attempt.proposed || 0,
      attempt.inserted || 0,
      attempt.reason || null,
      JSON.stringify(attempt.traceSummary || {})
    ]
  );
}

// ── Queue construction ────────────────────────────────────────────────

/**
 * Compute the prioritized queue of courses to enrich.
 *
 * Sources:
 *   - buildCoverageReport(pool) for current coverage scores per course
 *   - osm_enrichment_attempts for "do not retry" filtering
 *
 * Filtering:
 *   1. coverageScore between [minScore, maxScore]
 *   2. Course has at least one hole that joins both a tee POI and a
 *      green POI (otherwise enrichCourse will skip with no_geometry).
 *      We pre-filter here so we don't burn Overpass budget on dead courses.
 *   3. Skip courses whose most recent attempt was a success within
 *      cooldownDays. Skip courses whose most recent attempt was failed
 *      within cooldownDays UNLESS --retry-failed.
 *
 * Sort:
 *   1. coverageScore ascending      (weakest first)
 *   2. totalHoles descending        (18-hole > 9-hole — more leverage)
 *   3. courseName ascending         (deterministic)
 *
 * Future hook:
 *   When rounds_played_30d arrives, multiply primary key by max(rounds, 1).
 */
async function buildQueue(pool, args, log) {
  log("loading coverage report (single SQL pass over ~19k courses)...");
  const t0 = Date.now();
  const report = await buildCoverageReport(pool, { includePerHole: false });
  log(`coverage report ready in ${Date.now() - t0}ms — ${report.courses.length} courses`);

  log("loading recent enrichment attempts for cooldown check...");
  const cooldownCutoff = new Date(Date.now() - args.cooldownDays * 86_400_000).toISOString();
  const recentRes = await pool.query(
    `SELECT course_id, status, MAX(attempted_at) AS last_at
       FROM osm_enrichment_attempts
      WHERE attempted_at > $1
      GROUP BY course_id, status`,
    [cooldownCutoff]
  );
  // Per-course: last seen status (most recent wins)
  const lastStatusByCourse = new Map();
  for (const r of recentRes.rows) {
    const cur = lastStatusByCourse.get(r.course_id);
    if (!cur || new Date(r.last_at) > new Date(cur.last_at)) {
      lastStatusByCourse.set(r.course_id, { status: r.status, last_at: r.last_at });
    }
  }
  log(`found ${lastStatusByCourse.size} courses in cooldown window (${args.cooldownDays}d)`);

  log("loading geometry-eligibility hint (hole+green presence)...");
  const eligibilityRes = await pool.query(`
    SELECT c.id AS course_id
      FROM golf_courses c
      JOIN golf_course_holes h ON h.course_id = c.id
      JOIN golf_hole_pois gp
        ON gp.course_id = c.id AND gp.hole_number = h.hole_number
       AND LOWER(TRIM(gp.poi_type)) = 'green'
     GROUP BY c.id
    HAVING COUNT(*) >= 1
  `);
  const eligibleCourseIds = new Set(eligibilityRes.rows.map((r) => r.course_id));
  log(`${eligibleCourseIds.size} courses have at least one hole with green geometry`);

  // Filter
  const candidates = [];
  for (const c of report.courses) {
    if (!eligibleCourseIds.has(c.courseId)) continue;
    if (c.hazardCoverageScore < args.minScore) continue;
    if (c.hazardCoverageScore > args.maxScore) continue;

    const last = lastStatusByCourse.get(c.courseId);
    if (last) {
      // Skip courses successfully enriched within cooldown
      if (last.status === "success") continue;
      // Skip recently failed unless --retry-failed
      if (
        !args.retryFailed
        && (last.status === "failed" || last.status === "rate_limited" || last.status === "overpass_error")
      ) continue;
      // 'no_geometry' / 'no_features' are also skipped — they won't change
      if (last.status === "no_geometry" || last.status === "no_features") continue;
    }
    candidates.push(c);
  }

  // Sort
  candidates.sort((a, b) => {
    const scoreDelta = a.hazardCoverageScore - b.hazardCoverageScore;
    if (scoreDelta !== 0) return scoreDelta;
    const holesDelta = b.totalHoles - a.totalHoles;
    if (holesDelta !== 0) return holesDelta;
    return a.courseName.localeCompare(b.courseName);
  });

  return candidates.slice(0, args.limit);
}

// ── Throttle + backoff ────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Run enrichCourse() for one course with retry and exponential backoff
 * on transient Overpass failures. Returns a `result` object that the
 * caller turns into an osm_enrichment_attempts row.
 */
async function enrichWithBackoff(pool, course, opts) {
  const backoffSchedule = [5_000, 15_000, 45_000];
  let lastErr = null;

  for (let attempt = 0; attempt <= backoffSchedule.length; attempt++) {
    try {
      const trace = await enrichCourse(pool, course.courseId, {
        dryRun: opts.dryRun,
        maxFeatures: 2000
      });

      if (trace.error === "No holes with tee+green geometry — cannot project hazards") {
        return { status: "no_geometry", trace };
      }
      if (trace.osmFeaturesFetched === 0) {
        return { status: "no_features", trace };
      }
      return { status: "success", trace };
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      // Classify
      const isRateLimit = /HTTP (429|504|503)/.test(msg);
      const isTimeout = /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(msg);
      if (!isRateLimit && !isTimeout) {
        // Hard error — don't retry
        return { status: "overpass_error", error: msg };
      }
      if (attempt >= backoffSchedule.length) break;
      const wait = backoffSchedule[attempt];
      console.warn(`    backoff ${wait}ms after: ${msg.slice(0, 120)}`);
      await sleep(wait);
    }
  }
  return { status: "rate_limited", error: lastErr ? String(lastErr.message || lastErr) : "exhausted retries" };
}

// ── Main loop ─────────────────────────────────────────────────────────

async function run(args) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  // Bracketed log helper for greppable Render logs
  const log = (msg) => console.log(`[OSM BATCH] ${msg}`);

  log(`mode=${args.apply ? "APPLY" : "DRY"} limit=${args.limit} delay-ms=${args.delayMs} max-queries-per-run=${args.maxQueriesPerRun} cooldown-days=${args.cooldownDays}`);

  const run = await startRun(pool, args);
  log(`run_id=${run.run_id} started_at=${run.started_at.toISOString ? run.started_at.toISOString() : run.started_at}`);

  // Trap Ctrl-C: finalize the run cleanly
  let aborted = false;
  process.on("SIGINT", () => {
    aborted = true;
    log("SIGINT received — will finalize run as 'aborted' after current course");
  });

  let queue = [];
  if (args.courseId) {
    log(`single-course mode: ${args.courseId}`);
    const r = await pool.query(
      `SELECT id AS "courseId", course_name AS "courseName" FROM golf_courses WHERE id = $1`,
      [args.courseId]
    );
    queue = r.rows.map((row) => ({
      courseId: row.courseId,
      courseName: row.courseName,
      hazardCoverageScore: 0,
      totalHoles: 18
    }));
  } else {
    queue = await buildQueue(pool, args, log);
  }

  log(`queue size: ${queue.length} courses`);
  await updateRunCounters(pool, run.run_id, {
    queueSize: queue.length, processed: 0, succeeded: 0, failed: 0, skipped: 0, totalInserted: 0
  });

  if (queue.length === 0) {
    log("nothing to enrich — exiting cleanly");
    await finishRun(pool, run.run_id, "complete", "empty queue");
    await pool.end();
    return;
  }

  // ── Process queue sequentially ──────────────────────────────────────
  const counters = { queueSize: queue.length, processed: 0, succeeded: 0, failed: 0, skipped: 0, totalInserted: 0 };
  let queriesUsed = 0;
  const winners = [];   // courses with biggest delta — for final report

  for (let i = 0; i < queue.length; i++) {
    if (aborted) break;
    if (queriesUsed >= args.maxQueriesPerRun) {
      log(`max-queries-per-run cap reached (${args.maxQueriesPerRun}) — pausing`);
      await finishRun(pool, run.run_id, "rate_limited", `max-queries-per-run reached at ${queriesUsed}`);
      await pool.end();
      return;
    }

    const c = queue[i];
    const beforeScore = c.hazardCoverageScore;
    const prefix = `[${i + 1}/${queue.length}]`;

    log(`${prefix} ${c.courseName} (${c.courseId}) before=${beforeScore}`);

    queriesUsed++;
    const t0 = Date.now();
    const result = await enrichWithBackoff(pool, c, { dryRun: !args.apply });
    const elapsed = Date.now() - t0;
    counters.processed++;

    if (result.status === "success") {
      const trace = result.trace;
      const inserted = args.apply ? (trace.inserted || 0) : 0;
      const proposed = (trace.proposedRows || []).length;
      counters.succeeded++;
      counters.totalInserted += inserted;

      // Recompute coverage score for this course (cheap — single course pass)
      let afterScore = beforeScore;
      if (args.apply && inserted > 0) {
        afterScore = await scoreSingleCourse(pool, c.courseId);
      }
      const delta = afterScore - beforeScore;
      if (delta > 0) winners.push({ name: c.courseName, before: beforeScore, after: afterScore, delta, inserted });

      log(`  ${prefix} ${args.apply ? "INSERTED" : "PROPOSED"}=${args.apply ? inserted : proposed} fetched=${trace.osmFeaturesFetched} mapped=${trace.osmFeaturesMapped} skipped(outside=${trace.skippedOutsideHoles}, dupNative=${trace.skippedDuplicateOfNative}, dupOsm=${trace.skippedDuplicateOfOsm}) afterScore=${afterScore} (+${delta}) elapsed=${elapsed}ms`);

      await recordAttempt(pool, run.run_id, {
        courseId: c.courseId, courseName: c.courseName,
        status: "success", beforeScore, afterScore,
        proposed, inserted,
        traceSummary: {
          osmFeaturesFetched: trace.osmFeaturesFetched,
          osmFeaturesMapped: trace.osmFeaturesMapped,
          insertedByType: trace.insertedByType,
          insertedByHole: trace.insertedByHole,
          skippedOutsideHoles: trace.skippedOutsideHoles,
          skippedDuplicateOfNative: trace.skippedDuplicateOfNative,
          skippedDuplicateOfOsm: trace.skippedDuplicateOfOsm
        }
      });
    } else if (result.status === "no_geometry") {
      counters.skipped++;
      log(`  ${prefix} skipped — no_geometry`);
      await recordAttempt(pool, run.run_id, {
        courseId: c.courseId, courseName: c.courseName,
        status: "no_geometry", beforeScore, afterScore: beforeScore,
        reason: "no holes with tee+green geometry"
      });
    } else if (result.status === "no_features") {
      counters.skipped++;
      log(`  ${prefix} skipped — no_features (Overpass returned 0 elements)`);
      await recordAttempt(pool, run.run_id, {
        courseId: c.courseId, courseName: c.courseName,
        status: "no_features", beforeScore, afterScore: beforeScore,
        reason: "OSM has no hazard features in this bbox"
      });
    } else {
      counters.failed++;
      log(`  ${prefix} ${result.status.toUpperCase()}: ${result.error}`);
      await recordAttempt(pool, run.run_id, {
        courseId: c.courseId, courseName: c.courseName,
        status: result.status, beforeScore, afterScore: beforeScore,
        reason: result.error
      });
    }

    await updateRunCounters(pool, run.run_id, counters);
    if (i < queue.length - 1 && !aborted) await sleep(args.delayMs);
  }

  const finalStatus = aborted ? "aborted" : "complete";
  await finishRun(pool, run.run_id, finalStatus, null);

  // ── Final report ───────────────────────────────────────────────────
  log("");
  log("════════ FINAL SUMMARY ════════");
  log(`run_id:           ${run.run_id}`);
  log(`mode:             ${args.apply ? "APPLY" : "DRY"}`);
  log(`status:           ${finalStatus}`);
  log(`processed:        ${counters.processed}`);
  log(`succeeded:        ${counters.succeeded}`);
  log(`skipped:          ${counters.skipped}`);
  log(`failed:           ${counters.failed}`);
  log(`hazards inserted: ${counters.totalInserted}`);
  log(`overpass calls:   ${queriesUsed}`);

  if (winners.length > 0) {
    winners.sort((a, b) => b.delta - a.delta);
    log("");
    log("Top winners (largest score delta):");
    for (const w of winners.slice(0, 10)) {
      log(`  +${String(w.delta).padStart(2)} pts  ${String(w.before).padStart(2)} → ${String(w.after).padStart(3)}  (+${w.inserted} hazards)  ${w.name}`);
    }
  }

  // Coverage status counts after the run (cheap — separate query, may include
  // courses outside this run's queue, gives macro picture)
  try {
    const statusCountsRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE source_type = 'source_native') AS native_count,
        COUNT(*) FILTER (WHERE source_type = 'source_osm')    AS osm_count
      FROM golf_hole_pois
    `);
    const r = statusCountsRes.rows[0] || {};
    log("");
    log(`Source breakdown (live, all courses): native=${r.native_count}  osm=${r.osm_count}`);
  } catch { /* ignore */ }

  await pool.end();
}

/**
 * Compute the coverage score for a single course. Used after enrichment
 * to report the AFTER score in logs without re-running the global audit.
 */
async function scoreSingleCourse(pool, courseUuid) {
  const { computeCoverageScore } = require("../services/hazardClassifier");
  const { normalizeHazardType, coarseCategory } = require("../services/hazardClassifier");

  const res = await pool.query(`
    SELECT h.hole_number,
           p.poi_type, p.location_label, p.fairway_side, p.lat, p.lon
      FROM golf_course_holes h
      LEFT JOIN golf_hole_pois p
        ON p.course_id = h.course_id AND p.hole_number = h.hole_number
       AND LOWER(TRIM(p.poi_type)) NOT IN ('green', 'tee', 'tee front', 'tee back')
     WHERE h.course_id = $1
  `, [courseUuid]);

  const perHole = new Map();
  for (const r of res.rows) {
    if (!perHole.has(r.hole_number)) perHole.set(r.hole_number, { hazardCount: 0, hasBunker: false, hasWater: false });
    if (!r.poi_type) continue;
    if (!Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lon))) continue;
    const t = normalizeHazardType(r.poi_type, r.location_label, r.fairway_side);
    if (!t) continue;
    const h = perHole.get(r.hole_number);
    h.hazardCount++;
    const cc = coarseCategory(t);
    if (cc === "bunker") h.hasBunker = true;
    if (cc === "water") h.hasWater = true;
  }
  let totalHoles = 0, holesWithHazards = 0, holesWithBunkers = 0, holesWithWater = 0, totalPois = 0;
  for (const h of perHole.values()) {
    totalHoles++;
    if (h.hazardCount > 0) holesWithHazards++;
    if (h.hasBunker) holesWithBunkers++;
    if (h.hasWater) holesWithWater++;
    totalPois += h.hazardCount;
  }
  const { score } = computeCoverageScore({
    totalHoles, holesWithHazards, holesWithBunkers, holesWithWater,
    totalPois, poisWithCoords: totalPois
  });
  return score;
}

// Standalone entrypoint
if (require.main === module) {
  const args = parseArgs(process.argv);
  run(args).catch((err) => {
    console.error("[OSM BATCH] FATAL:", err);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, buildQueue };
