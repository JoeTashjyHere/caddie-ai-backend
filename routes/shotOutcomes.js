"use strict";

/**
 * Shot outcomes — durable record of what the player actually did vs. recommendation.
 *
 * Endpoints:
 *   POST /api/shot-outcomes           — upsert a single outcome (idempotent on recommendation_id)
 *   GET  /api/shot-outcomes/user/:id  — recent outcomes for a user (capped)
 *
 * iOS posts fire-and-forget; failures must NEVER block the local UX. The endpoints accept
 * partial payloads (only `recommendation_id`, `shot_result`, `success`, `recorded_at`
 * are strictly required — everything else is best-effort metadata).
 */

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const ALLOWED_RESULTS = new Set([
  "as_planned",
  "miss_left",
  "miss_right",
  "short",
  "long"
]);
const ALLOWED_MISS_DIRECTIONS = new Set(["left", "right", "short", "long"]);

function safeStr(value, max = 200) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function safeInt(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function safeBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function normalize(body) {
  const recommendationId = safeStr(body.recommendationId || body.recommendation_id, 128);
  if (!recommendationId) return { error: "recommendationId is required" };

  const shotResult = safeStr(body.shotResult || body.shot_result || body.result, 32);
  if (!shotResult || !ALLOWED_RESULTS.has(shotResult)) {
    return { error: `shotResult must be one of ${[...ALLOWED_RESULTS].join(", ")}` };
  }

  const recordedAtRaw = body.recordedAt || body.recorded_at;
  const recordedAt = recordedAtRaw ? new Date(recordedAtRaw) : new Date();
  if (Number.isNaN(recordedAt.getTime())) {
    return { error: "recordedAt is invalid" };
  }

  const declaredSuccess = safeBool(body.success, undefined);
  const success = declaredSuccess === undefined ? shotResult === "as_planned" : declaredSuccess;

  let missDirection = safeStr(body.missDirection || body.miss_direction, 16);
  if (missDirection) missDirection = missDirection.toLowerCase();
  if (missDirection && !ALLOWED_MISS_DIRECTIONS.has(missDirection)) missDirection = null;

  return {
    record: {
      id: safeStr(body.id, 64) || `so_${randomUUID()}`,
      recommendationId,
      userId: safeStr(body.userId || body.user_id, 64),
      roundId: safeStr(body.roundId || body.round_id, 64),
      courseId: safeStr(body.courseId || body.course_id, 64),
      holeNumber: safeInt(body.holeNumber ?? body.hole_number),
      holePar: safeInt(body.holePar ?? body.hole_par),
      teeSetId: safeStr(body.teeSetId || body.tee_set_id, 64),
      clubUsed: safeStr(body.clubUsed || body.club_used, 64),
      intendedShot: safeStr(body.intendedShot || body.intended_shot, 80),
      shotResult,
      missDirection,
      success,
      distanceYards: safeInt(body.distanceYards ?? body.distance_yards),
      recordedAt
    }
  };
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shot_outcomes (
      id                TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL,
      user_id           TEXT,
      round_id          TEXT,
      course_id         TEXT,
      hole_number       INTEGER,
      hole_par          INTEGER,
      tee_set_id        TEXT,
      club_used         TEXT,
      intended_shot     TEXT,
      shot_result       TEXT NOT NULL,
      miss_direction    TEXT,
      success           BOOLEAN NOT NULL,
      distance_yards    INTEGER,
      recorded_at       TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT shot_outcomes_recommendation_unique UNIQUE (recommendation_id)
    );
  `);
}

router.post("/", async (req, res) => {
  const pool = req.app.get("dbPool");
  if (!pool) {
    // Persistence disabled — return success so iOS never sees a hard failure. The
    // outcome is still saved locally on device; backend persistence is best-effort.
    return res.status(202).json({ ok: true, persisted: false, reason: "no-db" });
  }

  const parsed = normalize(req.body || {});
  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }
  const r = parsed.record;

  try {
    await ensureTable(pool);
    await pool.query(
      `
        INSERT INTO shot_outcomes (
          id, recommendation_id, user_id, round_id, course_id,
          hole_number, hole_par, tee_set_id, club_used, intended_shot,
          shot_result, miss_direction, success, distance_yards, recorded_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (recommendation_id) DO UPDATE SET
          user_id        = EXCLUDED.user_id,
          round_id       = EXCLUDED.round_id,
          course_id      = EXCLUDED.course_id,
          hole_number    = EXCLUDED.hole_number,
          hole_par       = EXCLUDED.hole_par,
          tee_set_id     = EXCLUDED.tee_set_id,
          club_used      = EXCLUDED.club_used,
          intended_shot  = EXCLUDED.intended_shot,
          shot_result    = EXCLUDED.shot_result,
          miss_direction = EXCLUDED.miss_direction,
          success        = EXCLUDED.success,
          distance_yards = EXCLUDED.distance_yards,
          recorded_at    = EXCLUDED.recorded_at;
      `,
      [
        r.id,
        r.recommendationId,
        r.userId,
        r.roundId,
        r.courseId,
        r.holeNumber,
        r.holePar,
        r.teeSetId,
        r.clubUsed,
        r.intendedShot,
        r.shotResult,
        r.missDirection,
        r.success,
        r.distanceYards,
        r.recordedAt
      ]
    );
    return res.json({ ok: true, persisted: true, id: r.id });
  } catch (err) {
    console.error("[shot-outcomes] persist failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to persist shot outcome" });
  }
});

router.get("/user/:id", async (req, res) => {
  const pool = req.app.get("dbPool");
  const userId = safeStr(req.params.id, 64);
  if (!userId) return res.status(400).json({ ok: false, error: "userId is required" });
  if (!pool) return res.json({ ok: true, outcomes: [], source: "no-db" });

  const rawLimit = parseInt(req.query.limit || "100", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;

  try {
    await ensureTable(pool);
    const result = await pool.query(
      `SELECT id, recommendation_id, user_id, round_id, course_id, hole_number, hole_par,
              tee_set_id, club_used, intended_shot, shot_result, miss_direction,
              success, distance_yards, recorded_at, created_at
       FROM shot_outcomes
       WHERE user_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    const outcomes = result.rows.map((row) => ({
      id: row.id,
      recommendationId: row.recommendation_id,
      userId: row.user_id,
      roundId: row.round_id,
      courseId: row.course_id,
      holeNumber: row.hole_number,
      holePar: row.hole_par,
      teeSetId: row.tee_set_id,
      clubUsed: row.club_used,
      intendedShot: row.intended_shot,
      shotResult: row.shot_result,
      missDirection: row.miss_direction,
      success: row.success,
      distanceYards: row.distance_yards,
      recordedAt: row.recorded_at,
      createdAt: row.created_at
    }));
    return res.json({ ok: true, outcomes, source: "database", count: outcomes.length });
  } catch (err) {
    console.error("[shot-outcomes] user fetch failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to load outcomes" });
  }
});

module.exports = router;
