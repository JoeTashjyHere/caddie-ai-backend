"use strict";

/**
 * Production-grade startup initialization.
 * Runs migrations, then synthesizes tee coordinates if the table is empty.
 * Ingestion is decoupled — run via: npm run ingest
 */

const { runMigrations } = require("../scripts/run-migrations");
const { runSynthesis } = require("../scripts/synthesize-hole-tees");

/**
 * Run startup: migrations + conditional tee synthesis.
 * @param {import("pg").Pool} pool
 * @returns {Promise<{ migrations: object, synthesis: object|null }>}
 */
async function runStartup(pool) {
  const result = { migrations: null, synthesis: null };

  try {
    result.migrations = await runMigrations(pool);
  } catch (err) {
    console.error("[init] Migration failed:", err.message);
    throw err;
  }

  try {
    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS n FROM golf_hole_tees"
    );
    const existingCount = countRes.rows[0]?.n ?? 0;
    if (existingCount === 0) {
      console.log("[init] golf_hole_tees is empty — running tee synthesis...");
      result.synthesis = await runSynthesis(pool);
    } else {
      console.log(`[init] golf_hole_tees has ${existingCount} rows — skipping synthesis.`);
    }
  } catch (err) {
    console.warn("[init] Tee synthesis skipped:", err.message);
  }

  return result;
}

module.exports = { runStartup };
