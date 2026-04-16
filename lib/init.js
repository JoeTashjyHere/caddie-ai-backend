"use strict";

/**
 * Non-blocking startup initialization.
 *
 * RULES (enforced to prevent Render health-check timeouts):
 *   1. Nothing in this module is awaited before app.listen(). Callers must
 *      invoke runInitTasksInBackground(pool) and return immediately.
 *   2. Migrations: bounded, wrapped in try/catch, never rethrown.
 *   3. Synthesis: only runs if table is truly empty AND is bounded by a
 *      30s Promise.race timeout so a partial run never blocks boot or
 *      exhausts the event loop.
 *   4. Every meaningful phase emits a bracketed log tag so Render logs
 *      are observable and greppable.
 */

const { runMigrations } = require("../scripts/run-migrations");
const { runSynthesis } = require("../scripts/synthesize-hole-tees");

const SYNTHESIS_TIMEOUT_MS = 30_000;

function timeout(ms, tag = "timeout") {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`[${tag}] exceeded ${ms}ms`)), ms);
  });
}

async function runMigrationsSafe(pool) {
  console.log("[INIT] migrations starting");
  try {
    const result = await runMigrations(pool);
    const applied = result?.applied?.length ?? 0;
    const skipped = result?.skipped?.length ?? 0;
    console.log(`[INIT] migrations complete applied=${applied} skipped=${skipped}`);
    return result;
  } catch (err) {
    console.error("[INIT ERROR] migrations failed:", err.message);
    return null;
  }
}

async function getHoleTeeCount(pool) {
  try {
    const res = await pool.query("SELECT COUNT(*)::int AS n FROM golf_hole_tees");
    return res.rows[0]?.n ?? 0;
  } catch (err) {
    console.warn("[INIT] getHoleTeeCount failed (table missing?):", err.message);
    return -1;
  }
}

async function maybeRunSynthesisSafe(pool) {
  const count = await getHoleTeeCount(pool);

  if (count < 0) {
    console.warn("[SYNTHESIS] skipped — golf_hole_tees table not ready");
    return;
  }

  if (count > 0) {
    console.log(`[SYNTHESIS] skipped — already populated rows=${count}`);
    return;
  }

  console.log("[SYNTHESIS] starting (bounded 30s)");
  try {
    const result = await Promise.race([
      runSynthesis(pool),
      timeout(SYNTHESIS_TIMEOUT_MS, "SYNTHESIS")
    ]);
    console.log(
      `[SYNTHESIS] completed inserted=${result?.totalInserted ?? "?"} ` +
      `skipped=${result?.totalSkipped ?? "?"} ` +
      `coursesProcessed=${result?.coursesProcessed ?? "?"}`
    );
  } catch (err) {
    console.error("[SYNTHESIS ERROR]", err.message);
    console.error("[SYNTHESIS] remaining work must be triggered via POST /api/admin/synthesize-tees");
  }
}

/**
 * Fire and forget: schedule init work on the next tick so callers never block.
 * Safe against double-invocation; idempotent after first completion.
 */
let __initStarted = false;
function runInitTasksInBackground(pool) {
  if (__initStarted) {
    console.log("[INIT] already started — skipping duplicate call");
    return;
  }
  __initStarted = true;

  setTimeout(async () => {
    console.log("[INIT] background tasks starting");
    try {
      if (!pool) {
        console.warn("[INIT] no DB pool — skipping migrations + synthesis");
        return;
      }
      await runMigrationsSafe(pool);
      await maybeRunSynthesisSafe(pool);
      console.log("[INIT] background tasks complete");
    } catch (err) {
      console.error("[INIT ERROR] unexpected:", err.message);
    }
  }, 0);
}

/**
 * Legacy wrapper kept for backward compatibility with callers still using
 * runStartup(). Internally delegates to the non-blocking path so awaiting
 * this never blocks server.listen().
 */
async function runStartup(pool) {
  runInitTasksInBackground(pool);
  return { migrations: null, synthesis: null, mode: "background" };
}

module.exports = { runStartup, runInitTasksInBackground };
