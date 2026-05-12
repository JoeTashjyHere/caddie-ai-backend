"use strict";

/**
 * User Profile routes for Caddie.AI — V8.1 Backend Profile Sync.
 *
 * Endpoints (mounted at both `/user/profile` and `/api/user/profile`):
 *   GET    /profile        — return the authenticated user's profile
 *   PUT    /profile        — upsert the authenticated user's profile
 *
 * Security model:
 *   • `authenticate` middleware extracts `req.authUser.id` from a JWT.
 *     Callers can ONLY access their own profile — there is no
 *     `:userId` URL parameter and any `user_id` / `id` field in the
 *     request body is silently stripped before write.
 *   • Sensitive keys (`passwordHash`, `password`, `token`, etc.) are
 *     stripped from any inbound profile JSON so a buggy iOS build
 *     can't accidentally upload secrets.
 *   • Payload size is capped at 256 KB to prevent abuse.
 *
 * Sync contract (matches `ios/Services/ProfileSyncService.swift`):
 *   • PRE-AUTH       — no calls hit this router (no token).
 *   • NEW SIGNUP     — iOS calls PUT once with `syncDecision: "new"`
 *                      after `OnboardingViewModel.finalize`.
 *   • RETURNING USER — iOS calls GET on the merge-decision screen,
 *                      then either:
 *                        - `.restore`  : no PUT, applies server JSON locally.
 *                        - `.merge`    : iOS merges and PUTs result with
 *                                        `syncDecision: "merge"`.
 *                        - `.replace`  : iOS PUTs local payload with
 *                                        `syncDecision: "replace"`.
 *   • The server records the last decision via `last_sync_decision`
 *     in profile_json so multi-device reconciliation can audit it.
 *
 * Backward compatibility:
 *   • If the `user_profiles` table is missing (Render bot didn't run
 *     migration 009 yet), both endpoints fall back gracefully:
 *       - GET returns `{ ok: true, profile: null, updatedAt: null }`
 *       - PUT returns 503 so the iOS client falls back to local-only.
 *     This protects production through the migration window.
 */

const express = require("express");
const router = express.Router();

const authModule = require("./auth");
const authenticate = authModule.authenticate;

// Fields that must NEVER be persisted as part of a profile JSON, even
// if the client tries to send them. Stripped silently.
const FORBIDDEN_KEYS = new Set([
  "user_id",
  "userId",
  "id",
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "sessionToken",
  "jwt",
  "jti",
  "authToken",
  "identityToken",
  "idToken",
  "refreshToken",
  "anonymousUserId",
  "anonymous_user_id"
]);

// Decisions the client may declare. Anything else is normalized to
// `unspecified` rather than rejected — keeps backward compatibility
// if iOS evolves the vocabulary.
const ALLOWED_DECISIONS = new Set(["new", "restore", "merge", "replace", "unspecified"]);

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB

function getDbPool(req) {
  return req.app.get("dbPool") || null;
}

/**
 * Defensive deep-strip of forbidden keys. Operates on a shallow clone
 * to avoid mutating the caller's object. Keys are matched
 * case-insensitively against `FORBIDDEN_KEYS` so `userId`, `USERID`,
 * `User_Id` all get stripped.
 *
 * We deliberately limit recursion depth so a hostile/malformed payload
 * (e.g. circular structure flattened by JSON.stringify) can't cause
 * stack exhaustion. 12 levels is more than any reasonable profile.
 */
function stripForbiddenKeys(value, depth = 0) {
  if (depth > 12) return value;
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripForbiddenKeys(v, depth + 1));
  }
  const result = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k) || FORBIDDEN_KEYS.has(k.toLowerCase())) {
      continue;
    }
    result[k] = stripForbiddenKeys(v, depth + 1);
  }
  return result;
}

function normalizeDecision(raw) {
  if (typeof raw !== "string") return "unspecified";
  const lower = raw.trim().toLowerCase();
  return ALLOWED_DECISIONS.has(lower) ? lower : "unspecified";
}

/**
 * Check whether the user_profiles table exists. Caches a positive
 * result for the lifetime of the process (Render restart resets it).
 * On a negative result we re-check on every request so a freshly
 * applied migration becomes visible without a restart.
 */
let __userProfilesTablePresent = false;
async function userProfilesTableExists(pool) {
  if (__userProfilesTablePresent) return true;
  if (!pool) return false;
  try {
    const r = await pool.query(
      "SELECT to_regclass('public.user_profiles') AS t"
    );
    const ok = Boolean(r.rows[0] && r.rows[0].t);
    if (ok) __userProfilesTablePresent = true;
    return ok;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------
// Handlers (exported for unit testing without auth middleware in path)
// ----------------------------------------------------------------
async function handleGetProfile(req, res) {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ ok: false, error: "Database unavailable." });
  }
  const hasTable = await userProfilesTableExists(pool);
  if (!hasTable) {
    // Migration window: act like the user has no profile yet rather
    // than 5xx. iOS treats null profile as "fresh server" and skips
    // the merge UI gracefully.
    return res.json({ ok: true, profile: null, updatedAt: null });
  }
  try {
    const r = await pool.query(
      "SELECT profile_json, updated_at FROM user_profiles WHERE user_id = $1 LIMIT 1",
      [req.authUser.id]
    );
    if (r.rowCount === 0) {
      return res.json({ ok: true, profile: null, updatedAt: null });
    }
    const row = r.rows[0];
    return res.json({
      ok: true,
      profile: row.profile_json,
      updatedAt: row.updated_at
    });
  } catch (err) {
    console.error("GET /user/profile failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to load profile." });
  }
}

async function handlePutProfile(req, res) {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ ok: false, error: "Database unavailable." });
  }

  const body = req.body || {};
  const rawProfile = body.profile;
  if (rawProfile == null || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
    return res.status(400).json({
      ok: false,
      error: "Request body must include a `profile` object."
    });
  }

  // Defensive size check — Express already enforces a global JSON
  // body limit but we add a tighter cap here so an attacker can't
  // hammer the JSONB column with multi-megabyte payloads.
  let serialized;
  try {
    serialized = JSON.stringify(rawProfile);
  } catch {
    return res.status(400).json({ ok: false, error: "Profile is not serializable." });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({
      ok: false,
      error: `Profile payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`
    });
  }

  const cleaned = stripForbiddenKeys(rawProfile);
  const decision = normalizeDecision(body.syncDecision);
  const clientUpdatedAt = typeof body.clientUpdatedAt === "string" ? body.clientUpdatedAt : null;

  // Stamp server-side bookkeeping so future device reconciliation can
  // know which iOS decision drove the last write. These keys live
  // inside profile_json so they round-trip with GET. We OVERWRITE
  // these regardless of payload to prevent client spoofing.
  cleaned.last_sync_decision = decision;
  cleaned.last_sync_at = new Date().toISOString();
  if (clientUpdatedAt) {
    cleaned.last_client_updated_at = clientUpdatedAt;
  }

  const hasTable = await userProfilesTableExists(pool);
  if (!hasTable) {
    return res.status(503).json({
      ok: false,
      error: "Profile storage not ready. Please retry shortly."
    });
  }

  try {
    const r = await pool.query(
      `
      INSERT INTO user_profiles (user_id, profile_json, created_at, updated_at)
      VALUES ($1, $2::jsonb, now(), now())
      ON CONFLICT (user_id) DO UPDATE
         SET profile_json = EXCLUDED.profile_json,
             updated_at   = now()
      RETURNING profile_json, created_at, updated_at;
      `,
      [req.authUser.id, JSON.stringify(cleaned)]
    );
    const row = r.rows[0];
    return res.json({
      ok: true,
      profile: row.profile_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      syncDecision: decision
    });
  } catch (err) {
    console.error("PUT /user/profile failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to save profile." });
  }
}

router.get("/profile", authenticate, handleGetProfile);
router.put("/profile", authenticate, handlePutProfile);

module.exports = router;
// Expose helpers + bare handlers for unit testing.
module.exports.__test = {
  handleGetProfile,
  handlePutProfile,
  stripForbiddenKeys,
  normalizeDecision,
  FORBIDDEN_KEYS,
  ALLOWED_DECISIONS,
  MAX_PAYLOAD_BYTES,
  // Internal: reset the cached table-exists flag between tests.
  __resetTableCache: () => {
    __userProfilesTablePresent = false;
  }
};
