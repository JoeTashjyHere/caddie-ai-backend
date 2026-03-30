"use strict";

/**
 * Production-grade startup initialization.
 * Runs migrations only. Ingestion is decoupled — run via: npm run ingest
 */

const { runMigrations } = require("../scripts/run-migrations");

/**
 * Run lightweight startup (migrations only).
 * @param {import("pg").Pool} pool
 * @returns {Promise<{ migrations: object }>}
 */
async function runStartup(pool) {
  const result = { migrations: null };

  try {
    result.migrations = await runMigrations(pool);
  } catch (err) {
    console.error("[init] Migration failed:", err.message);
    throw err;
  }

  return result;
}

module.exports = { runStartup };
