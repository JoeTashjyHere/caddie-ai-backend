"use strict";

/**
 * Production-grade startup initialization.
 * Orchestrates: migrations -> data check -> conditional ingestion.
 * Runs automatically on server start.
 */

const path = require("path");
const { runMigrations } = require("../scripts/run-migrations");
const { runIngestion } = require("../scripts/ingest");

const RUN_INGEST_ON_START =
  process.env.RUN_INGEST_ON_START === "true" || process.env.RUN_INGEST_ON_START === "1";
const DATA_SOURCE_TYPE = (process.env.DATA_SOURCE_TYPE || "local").toLowerCase();
const DATA_SOURCE_PATH = process.env.DATA_SOURCE_PATH || path.resolve(__dirname, "../data");

/**
 * Get row counts for golf tables. Returns null if tables don't exist.
 * @param {import("pg").Pool} pool
 * @returns {Promise<{ courses: number; holes: number; tees: number; pois: number } | null>}
 */
async function getDataCounts(pool) {
  try {
    const [courses, holes, tees, pois] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM golf_courses"),
      pool.query("SELECT COUNT(*)::int AS n FROM golf_course_holes"),
      pool.query("SELECT COUNT(*)::int AS n FROM golf_tees"),
      pool.query("SELECT COUNT(*)::int AS n FROM golf_hole_pois")
    ]);
    return {
      courses: courses.rows[0]?.n ?? 0,
      holes: holes.rows[0]?.n ?? 0,
      tees: tees.rows[0]?.n ?? 0,
      pois: pois.rows[0]?.n ?? 0
    };
  } catch {
    return null;
  }
}

/**
 * Run full startup sequence.
 * @param {import("pg").Pool} pool
 * @returns {Promise<{ migrations: object; ingestion?: object }>}
 */
async function runStartup(pool) {
  const result = { migrations: null, ingestion: null };

  // 1. Run migrations
  try {
    result.migrations = await runMigrations(pool);
  } catch (err) {
    console.error("[init] Migration failed:", err.message);
    throw err;
  }

  // 2. Check data presence
  const counts = await getDataCounts(pool);
  const dataExists = counts && counts.courses > 0;

  // 3. Conditionally run ingestion
  if (!RUN_INGEST_ON_START) {
    return result;
  }

  if (dataExists) {
    return result;
  }

  try {
    result.ingestion = await runIngestion(pool, {
      dataDir: DATA_SOURCE_TYPE === "local" ? DATA_SOURCE_PATH : undefined,
      dataSourceType: DATA_SOURCE_TYPE,
      dataSourcePath: DATA_SOURCE_PATH,
      dryRun: false,
      force: false,
      closePool: false
    });
  } catch (err) {
    console.error("[init] Ingestion failed (run manually):", err.message);
  }

  return result;
}

module.exports = { runStartup, getDataCounts };
