"use strict";

/**
 * Auth routes for Caddie.AI
 *
 * Endpoints:
 *   POST   /auth/email/register   { email, password, displayName?, anonymousUserId? }
 *   POST   /auth/email/login      { email, password, anonymousUserId? }
 *   POST   /auth/apple            { identityToken, fullName?, anonymousUserId? }
 *   POST   /auth/google           { idToken, anonymousUserId? }
 *   GET    /auth/me               (Bearer token)
 *   POST   /auth/logout           (Bearer token)
 *   DELETE /auth/account          (Bearer token)
 *
 * Tokens: stateless JWT (HS256) with a `jti`. Sign-out adds the `jti` to
 * `auth_revoked_tokens` so a stolen device that already signed out cannot
 * keep using the token, even though Keychain persists it.
 */

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");
const { jwtVerify, importJWK, decodeProtectedHeader } = require("jose");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || null;
const JWT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
// IMPORTANT: must match the iOS app's PRODUCT_BUNDLE_IDENTIFIER, otherwise
// Apple identity tokens fail audience verification at /auth/apple. The default
// matches the value in the current Caddie.ai.xcodeproj.
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "al.Caddie.Caddie-ai";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_AUDIENCES = (process.env.GOOGLE_CLIENT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let appleJwksCache = { fetchedAt: 0, keys: [] };

function getDbPool(req) {
  return req.app.get("dbPool") || null;
}

function safeTrim(v, max = 240) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function passwordIssue(password) {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 256) return "Password is too long.";
  return null;
}

function bearerToken(req) {
  const h = req.get("Authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

function signSession(userId) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET not configured");
  }
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign({ sub: userId, jti }, JWT_SECRET, {
    expiresIn: JWT_TTL_SECONDS,
    issuer: "caddie.ai"
  });
  return { token, jti };
}

async function tokenIsRevoked(pool, jti) {
  if (!pool || !jti) return false;
  const r = await pool.query(
    "SELECT 1 FROM auth_revoked_tokens WHERE jti = $1 LIMIT 1",
    [jti]
  );
  return r.rowCount > 0;
}

async function authenticate(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Auth not configured (missing JWT_SECRET)." });
  }
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Missing bearer token." });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { issuer: "caddie.ai" });
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable." });
  }
  if (await tokenIsRevoked(pool, payload.jti)) {
    return res.status(401).json({ error: "Token has been revoked." });
  }
  const r = await pool.query(
    "SELECT id, display_name, email, phone, anonymous_user_id, created_at, updated_at, is_deleted FROM users WHERE id = $1 LIMIT 1",
    [payload.sub]
  );
  if (r.rowCount === 0 || r.rows[0].is_deleted) {
    return res.status(401).json({ error: "User no longer exists." });
  }
  req.authUser = r.rows[0];
  req.authJti = payload.jti;
  req.authExp = payload.exp;
  next();
}

function publicUserShape(row, identities = []) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    anonymousUserId: row.anonymous_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providers: identities.map((i) => i.provider)
  };
}

async function loadIdentitiesForUser(pool, userId) {
  const r = await pool.query(
    "SELECT provider, provider_user_id, email FROM user_identities WHERE user_id = $1 ORDER BY created_at ASC",
    [userId]
  );
  return r.rows;
}

async function linkAnonymousIfNew(pool, userId, anonymousUserId) {
  if (!anonymousUserId) return;
  const trimmed = safeTrim(anonymousUserId, 120);
  if (!trimmed) return;
  await pool.query(
    `UPDATE users
        SET anonymous_user_id = COALESCE(anonymous_user_id, $2),
            updated_at = now()
      WHERE id = $1
        AND (anonymous_user_id IS NULL OR anonymous_user_id = '')`,
    [userId, trimmed]
  );
}

async function findOrCreateUserByIdentity(pool, {
  provider,
  providerUserId,
  email,
  displayName,
  anonymousUserId
}) {
  const existingIdentity = await pool.query(
    `SELECT user_id FROM user_identities
      WHERE provider = $1 AND provider_user_id = $2
      LIMIT 1`,
    [provider, providerUserId]
  );

  if (existingIdentity.rowCount > 0) {
    const userId = existingIdentity.rows[0].user_id;
    if (anonymousUserId) {
      await linkAnonymousIfNew(pool, userId, anonymousUserId);
    }
    if (email) {
      await pool.query(
        `UPDATE users
            SET email = COALESCE(email, $2),
                updated_at = now()
          WHERE id = $1`,
        [userId, email.toLowerCase()]
      );
    }
    if (displayName) {
      await pool.query(
        `UPDATE users
            SET display_name = COALESCE(NULLIF(display_name, ''), $2),
                updated_at = now()
          WHERE id = $1`,
        [userId, displayName]
      );
    }
    const userRow = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    return userRow.rows[0];
  }

  // Try to attach the identity to an existing email-matched user
  // (only when the provider also returned the email - avoids silent merges).
  let userRow = null;
  if (email) {
    const emailRow = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND is_deleted = FALSE LIMIT 1",
      [email]
    );
    if (emailRow.rowCount > 0) userRow = emailRow.rows[0];
  }

  if (!userRow) {
    const created = await pool.query(
      `INSERT INTO users (display_name, email, anonymous_user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [displayName || null, email ? email.toLowerCase() : null, safeTrim(anonymousUserId, 120) || null]
    );
    userRow = created.rows[0];
  } else if (anonymousUserId) {
    await linkAnonymousIfNew(pool, userRow.id, anonymousUserId);
  }

  await pool.query(
    `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [userRow.id, provider, providerUserId, email ? email.toLowerCase() : null]
  );

  return userRow;
}

// ----------------------------
// Apple identity-token verification
// ----------------------------
async function fetchAppleJwks() {
  const now = Date.now();
  if (now - appleJwksCache.fetchedAt < 60 * 60 * 1000 && appleJwksCache.keys.length > 0) {
    return appleJwksCache.keys;
  }
  const r = await fetch(APPLE_JWKS_URL);
  if (!r.ok) throw new Error(`Apple JWKS fetch failed (${r.status})`);
  const json = await r.json();
  appleJwksCache = { fetchedAt: now, keys: Array.isArray(json.keys) ? json.keys : [] };
  return appleJwksCache.keys;
}

async function verifyAppleIdentityToken(identityToken, expectedAud) {
  const header = decodeProtectedHeader(identityToken);
  const keys = await fetchAppleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Apple JWKS does not contain matching kid.");
  const key = await importJWK(jwk, "RS256");
  const { payload } = await jwtVerify(identityToken, key, {
    issuer: APPLE_ISSUER,
    audience: expectedAud
  });
  return payload;
}

// ----------------------------
// Google ID-token verification (uses Google's tokeninfo - no extra deps)
// ----------------------------
async function verifyGoogleIdToken(idToken) {
  const r = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw new Error(`Google token verification failed (${r.status})`);
  const data = await r.json();
  if (data.error_description || data.error) {
    throw new Error(data.error_description || "Google token rejected");
  }
  if (data.iss !== "https://accounts.google.com" && data.iss !== "accounts.google.com") {
    throw new Error("Unexpected Google issuer.");
  }
  if (GOOGLE_AUDIENCES.length > 0 && !GOOGLE_AUDIENCES.includes(data.aud)) {
    throw new Error("Google audience does not match configured client IDs.");
  }
  if (Number.isFinite(Number(data.exp))) {
    if (Number(data.exp) * 1000 < Date.now()) {
      throw new Error("Google token expired.");
    }
  }
  return data;
}

// ============================
// Routes
// ============================

/**
 * GET /auth/config-check
 *
 * Read-only health endpoint that reports which auth dependencies are
 * configured. NEVER returns secret values — only booleans and shapes.
 * Safe to expose publicly so the iOS app can warn the user if the backend
 * is misconfigured (e.g. JWT_SECRET not set on Render after a redeploy).
 */
router.get("/config-check", async (req, res) => {
  const pool = getDbPool(req);
  let dbReady = false;
  let authTablesReady = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbReady = true;
    } catch {
      dbReady = false;
    }
    try {
      const r = await pool.query(
        "SELECT to_regclass('public.users') AS users, to_regclass('public.user_identities') AS ident, to_regclass('public.email_credentials') AS creds, to_regclass('public.auth_revoked_tokens') AS revoked"
      );
      const row = r.rows[0] || {};
      authTablesReady = Boolean(row.users && row.ident && row.creds && row.revoked);
    } catch {
      authTablesReady = false;
    }
  }

  // We deliberately do NOT echo any of the secret values back. Bundle ID is
  // not a secret (it ships in every signed iOS app) and is useful for the
  // client to verify before sending Apple identity tokens.
  return res.json({
    ok: true,
    jwtConfigured: Boolean(JWT_SECRET),
    appleBundleConfigured: Boolean(APPLE_BUNDLE_ID),
    appleBundleId: APPLE_BUNDLE_ID,
    googleConfigured: GOOGLE_AUDIENCES.length > 0,
    googleAudienceCount: GOOGLE_AUDIENCES.length,
    dbReady,
    authTablesReady
  });
});

router.post("/email/register", async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Auth not configured (missing JWT_SECRET)." });
  }
  const pool = getDbPool(req);
  if (!pool) return res.status(503).json({ error: "Database unavailable." });

  try {
    const body = req.body || {};
    const email = (safeTrim(body.email, 320) || "").toLowerCase();
    const password = body.password;
    const displayName = safeTrim(body.displayName, 80);
    const anonymousUserId = safeTrim(body.anonymousUserId, 120);

    if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email address." });
    const pwIssue = passwordIssue(password);
    if (pwIssue) return res.status(400).json({ error: pwIssue });

    const existing = await pool.query(
      "SELECT id, is_deleted FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [email]
    );
    if (existing.rowCount > 0 && !existing.rows[0].is_deleted) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userRow = (
      await pool.query(
        `INSERT INTO users (display_name, email, anonymous_user_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [displayName || null, email, anonymousUserId || null]
      )
    ).rows[0];

    await pool.query(
      `INSERT INTO email_credentials (user_id, password_hash)
       VALUES ($1, $2)`,
      [userRow.id, passwordHash]
    );

    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
       VALUES ($1, 'email', $2, $3)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [userRow.id, email, email]
    );

    const { token } = signSession(userRow.id);
    const identities = await loadIdentitiesForUser(pool, userRow.id);
    return res.status(201).json({
      token,
      tokenType: "Bearer",
      expiresIn: JWT_TTL_SECONDS,
      user: publicUserShape(userRow, identities)
    });
  } catch (err) {
    console.error("auth/email/register failed:", err.message);
    return res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/email/login", async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Auth not configured (missing JWT_SECRET)." });
  }
  const pool = getDbPool(req);
  if (!pool) return res.status(503).json({ error: "Database unavailable." });

  try {
    const body = req.body || {};
    const email = (safeTrim(body.email, 320) || "").toLowerCase();
    const password = body.password;
    const anonymousUserId = safeTrim(body.anonymousUserId, 120);

    if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email address." });
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password is required." });
    }

    const userRow = await pool.query(
      `SELECT u.*, c.password_hash
         FROM users u
         JOIN email_credentials c ON c.user_id = u.id
        WHERE LOWER(u.email) = LOWER($1)
          AND u.is_deleted = FALSE
        LIMIT 1`,
      [email]
    );
    if (userRow.rowCount === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const ok = await bcrypt.compare(password, userRow.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    const user = userRow.rows[0];
    if (anonymousUserId) {
      await linkAnonymousIfNew(pool, user.id, anonymousUserId);
    }

    const { token } = signSession(user.id);
    const identities = await loadIdentitiesForUser(pool, user.id);
    return res.json({
      token,
      tokenType: "Bearer",
      expiresIn: JWT_TTL_SECONDS,
      user: publicUserShape(user, identities)
    });
  } catch (err) {
    console.error("auth/email/login failed:", err.message);
    return res.status(500).json({ error: "Login failed." });
  }
});

router.post("/apple", async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Auth not configured (missing JWT_SECRET)." });
  }
  const pool = getDbPool(req);
  if (!pool) return res.status(503).json({ error: "Database unavailable." });

  try {
    const body = req.body || {};
    const identityToken = body.identityToken;
    const fullName = safeTrim(body.fullName, 120);
    const anonymousUserId = safeTrim(body.anonymousUserId, 120);

    if (!identityToken || typeof identityToken !== "string") {
      return res.status(400).json({ error: "identityToken is required." });
    }

    let payload;
    try {
      payload = await verifyAppleIdentityToken(identityToken, APPLE_BUNDLE_ID);
    } catch (err) {
      console.warn("Apple verify failed:", err.message);
      return res.status(401).json({ error: "Apple identity token could not be verified." });
    }

    const providerUserId = payload.sub;
    if (!providerUserId) {
      return res.status(400).json({ error: "Apple token did not include a user identifier." });
    }
    const email = typeof payload.email === "string" ? payload.email : null;

    const userRow = await findOrCreateUserByIdentity(pool, {
      provider: "apple",
      providerUserId,
      email,
      displayName: fullName,
      anonymousUserId
    });

    const { token } = signSession(userRow.id);
    const identities = await loadIdentitiesForUser(pool, userRow.id);
    return res.json({
      token,
      tokenType: "Bearer",
      expiresIn: JWT_TTL_SECONDS,
      user: publicUserShape(userRow, identities)
    });
  } catch (err) {
    console.error("auth/apple failed:", err.message);
    return res.status(500).json({ error: "Apple sign-in failed." });
  }
});

router.post("/google", async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Auth not configured (missing JWT_SECRET)." });
  }
  const pool = getDbPool(req);
  if (!pool) return res.status(503).json({ error: "Database unavailable." });

  try {
    const body = req.body || {};
    const idToken = body.idToken;
    const anonymousUserId = safeTrim(body.anonymousUserId, 120);

    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({ error: "idToken is required." });
    }

    let payload;
    try {
      payload = await verifyGoogleIdToken(idToken);
    } catch (err) {
      console.warn("Google verify failed:", err.message);
      return res.status(401).json({ error: "Google identity token could not be verified." });
    }

    const providerUserId = payload.sub;
    if (!providerUserId) {
      return res.status(400).json({ error: "Google token did not include a user identifier." });
    }
    const email = typeof payload.email === "string" && payload.email_verified !== "false"
      ? payload.email
      : null;
    const displayName = safeTrim(payload.name, 120) ||
      [safeTrim(payload.given_name, 60), safeTrim(payload.family_name, 60)].filter(Boolean).join(" ");

    const userRow = await findOrCreateUserByIdentity(pool, {
      provider: "google",
      providerUserId,
      email,
      displayName,
      anonymousUserId
    });

    const { token } = signSession(userRow.id);
    const identities = await loadIdentitiesForUser(pool, userRow.id);
    return res.json({
      token,
      tokenType: "Bearer",
      expiresIn: JWT_TTL_SECONDS,
      user: publicUserShape(userRow, identities)
    });
  } catch (err) {
    console.error("auth/google failed:", err.message);
    return res.status(500).json({ error: "Google sign-in failed." });
  }
});

router.get("/me", authenticate, async (req, res) => {
  const pool = getDbPool(req);
  const identities = await loadIdentitiesForUser(pool, req.authUser.id);
  return res.json({ user: publicUserShape(req.authUser, identities) });
});

router.post("/logout", authenticate, async (req, res) => {
  const pool = getDbPool(req);
  try {
    await pool.query(
      `INSERT INTO auth_revoked_tokens (jti, user_id, expires_at)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (jti) DO NOTHING`,
      [req.authJti, req.authUser.id, req.authExp]
    );
  } catch (err) {
    console.warn("logout revoke insert failed:", err.message);
  }
  return res.json({ ok: true });
});

router.delete("/account", authenticate, async (req, res) => {
  const pool = getDbPool(req);
  try {
    await pool.query("BEGIN");
    await pool.query(
      `UPDATE users
          SET is_deleted = TRUE,
              deleted_at = now(),
              email = NULL,
              phone = NULL,
              display_name = NULL,
              updated_at = now()
        WHERE id = $1`,
      [req.authUser.id]
    );
    await pool.query("DELETE FROM email_credentials WHERE user_id = $1", [req.authUser.id]);
    await pool.query("DELETE FROM user_identities WHERE user_id = $1", [req.authUser.id]);
    await pool.query(
      `INSERT INTO auth_revoked_tokens (jti, user_id, expires_at)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (jti) DO NOTHING`,
      [req.authJti, req.authUser.id, req.authExp]
    );
    await pool.query("COMMIT");
    return res.json({ ok: true });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("account delete failed:", err.message);
    return res.status(500).json({ error: "Account deletion failed." });
  }
});

module.exports = router;
module.exports.authenticate = authenticate;
