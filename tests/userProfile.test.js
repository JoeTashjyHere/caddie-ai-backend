"use strict";

/**
 * Tests for the V8.1 user-profile sync routes.
 *
 * Approach: we test the bare handlers (handleGetProfile / handlePutProfile)
 * with a stubbed `pool` and `req`/`res` mocks. This deliberately avoids
 * standing up Postgres or running real JWT auth in CI — the unit under
 * test is the route logic, not the auth middleware (which has its own
 * coverage in /auth/* integration). The `authenticate` middleware
 * always runs in production via the mounted router, and we verify
 * that wiring separately via the production smoke test.
 *
 * Run with: npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const profileRoute = require("../routes/userProfile");
const {
  handleGetProfile,
  handlePutProfile,
  stripForbiddenKeys,
  normalizeDecision,
  FORBIDDEN_KEYS,
  MAX_PAYLOAD_BYTES,
  __resetTableCache
} = profileRoute.__test;

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {}
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  return res;
}

/**
 * Stub pool that simulates the user_profiles row store. Each test
 * starts with a fresh store. Supports the queries the route uses:
 *   - to_regclass check (returns "user_profiles" by default)
 *   - SELECT profile_json, updated_at FROM user_profiles WHERE user_id=$1
 *   - INSERT ... ON CONFLICT ... RETURNING profile_json, created_at, updated_at
 */
function makeStubPool({ tableExists = true } = {}) {
  const store = new Map(); // user_id -> { profile_json, created_at, updated_at }
  let queries = 0;

  const pool = {
    queries() {
      return queries;
    },
    store() {
      return store;
    },
    async query(sql, params = []) {
      queries += 1;
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT to_regclass")) {
        return { rows: [{ t: tableExists ? "user_profiles" : null }] };
      }
      if (trimmed.startsWith("SELECT profile_json, updated_at")) {
        const userId = params[0];
        const row = store.get(userId);
        if (!row) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [row] };
      }
      if (trimmed.startsWith("INSERT INTO user_profiles")) {
        const userId = params[0];
        const json = JSON.parse(params[1]);
        const existing = store.get(userId);
        const now = new Date();
        const row = {
          profile_json: json,
          created_at: existing ? existing.created_at : now,
          updated_at: now
        };
        store.set(userId, row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected SQL: ${trimmed.slice(0, 60)}`);
    }
  };
  return pool;
}

function makeReq({ userId = "user-1", body = {}, pool }) {
  return {
    body,
    authUser: { id: userId },
    app: { get: (key) => (key === "dbPool" ? pool : null) }
  };
}

// Reset the cached table-exists flag before each test so we exercise
// the migration-window code path correctly.
test.beforeEach(() => {
  __resetTableCache();
});

// ----------------------------------------------------------------
// Pure helper tests
// ----------------------------------------------------------------

test("stripForbiddenKeys removes user_id, id, password, token at any depth", () => {
  const input = {
    firstName: "Joe",
    user_id: "should-strip",
    userId: "should-strip",
    id: "should-strip",
    passwordHash: "$$$",
    password: "hunter2",
    sessionToken: "ey...",
    nested: {
      ok: 1,
      anonymousUserId: "should-strip",
      deeper: { jti: "should-strip", keep: true }
    },
    clubs: [
      { name: "Driver", carryYards: 240, token: "should-strip" }
    ]
  };
  const out = stripForbiddenKeys(input);
  assert.equal(out.firstName, "Joe");
  assert.equal(out.user_id, undefined);
  assert.equal(out.userId, undefined);
  assert.equal(out.id, undefined);
  assert.equal(out.passwordHash, undefined);
  assert.equal(out.password, undefined);
  assert.equal(out.sessionToken, undefined);
  assert.equal(out.nested.anonymousUserId, undefined);
  assert.equal(out.nested.ok, 1);
  assert.equal(out.nested.deeper.jti, undefined);
  assert.equal(out.nested.deeper.keep, true);
  assert.equal(out.clubs[0].name, "Driver");
  assert.equal(out.clubs[0].token, undefined);
});

test("FORBIDDEN_KEYS covers every documented sensitive field", () => {
  // Sanity check so a future refactor that drops one of these surfaces
  // immediately in CI rather than as a silent production leak.
  for (const key of [
    "user_id", "userId", "id", "password", "passwordHash",
    "password_hash", "token", "sessionToken", "jwt", "jti",
    "authToken", "identityToken", "idToken", "refreshToken",
    "anonymousUserId", "anonymous_user_id"
  ]) {
    assert.ok(FORBIDDEN_KEYS.has(key), `FORBIDDEN_KEYS missing ${key}`);
  }
});

test("normalizeDecision returns canonical values + 'unspecified' fallback", () => {
  assert.equal(normalizeDecision("new"), "new");
  assert.equal(normalizeDecision("Restore"), "restore");
  assert.equal(normalizeDecision(" MERGE "), "merge");
  assert.equal(normalizeDecision("replace"), "replace");
  assert.equal(normalizeDecision("garbage"), "unspecified");
  assert.equal(normalizeDecision(null), "unspecified");
  assert.equal(normalizeDecision(42), "unspecified");
});

// ----------------------------------------------------------------
// GET handler tests
// ----------------------------------------------------------------

test("GET returns 503 when no DB pool is configured", async () => {
  const req = { authUser: { id: "u1" }, app: { get: () => null } };
  const res = makeRes();
  await handleGetProfile(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
});

test("GET returns ok+null when user has no profile yet (no 404)", async () => {
  const pool = makeStubPool();
  const req = makeReq({ pool });
  const res = makeRes();
  await handleGetProfile(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.profile, null);
  assert.equal(res.body.updatedAt, null);
});

test("GET falls back to {profile:null} during migration window (table missing)", async () => {
  const pool = makeStubPool({ tableExists: false });
  const req = makeReq({ pool });
  const res = makeRes();
  await handleGetProfile(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.profile, null);
});

test("GET returns the user's own profile after a PUT", async () => {
  const pool = makeStubPool();
  const putReq = makeReq({
    pool,
    body: { profile: { firstName: "Joe", handedness: "Right" } }
  });
  await handlePutProfile(putReq, makeRes());

  const getRes = makeRes();
  await handleGetProfile(makeReq({ pool }), getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.profile.firstName, "Joe");
  assert.equal(getRes.body.profile.handedness, "Right");
});

// ----------------------------------------------------------------
// PUT handler tests
// ----------------------------------------------------------------

test("PUT rejects missing profile field (400)", async () => {
  const pool = makeStubPool();
  const req = makeReq({ pool, body: { syncDecision: "new" } });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test("PUT rejects array profile field (400)", async () => {
  const pool = makeStubPool();
  const req = makeReq({ pool, body: { profile: ["not", "an", "object"] } });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test("PUT rejects payload exceeding 256 KB (413)", async () => {
  const pool = makeStubPool();
  const huge = "x".repeat(MAX_PAYLOAD_BYTES + 1024);
  const req = makeReq({ pool, body: { profile: { blob: huge } } });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.ok, false);
});

test("PUT returns 503 when user_profiles table is missing (migration window)", async () => {
  const pool = makeStubPool({ tableExists: false });
  const req = makeReq({ pool, body: { profile: { firstName: "Joe" } } });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 503);
});

test("PUT creates new profile and returns saved row + decision", async () => {
  const pool = makeStubPool();
  const req = makeReq({
    pool,
    body: {
      profile: { firstName: "Joe", handedness: "Left", age: 33 },
      syncDecision: "new",
      clientUpdatedAt: "2026-05-12T10:00:00Z"
    }
  });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.profile.firstName, "Joe");
  assert.equal(res.body.profile.handedness, "Left");
  assert.equal(res.body.profile.age, 33);
  assert.equal(res.body.syncDecision, "new");
  assert.equal(res.body.profile.last_sync_decision, "new");
  assert.equal(res.body.profile.last_client_updated_at, "2026-05-12T10:00:00Z");
  assert.ok(res.body.profile.last_sync_at);
});

test("PUT updates an existing profile (upsert) and returns latest", async () => {
  const pool = makeStubPool();
  await handlePutProfile(
    makeReq({ pool, body: { profile: { firstName: "Joe", age: 30 } } }),
    makeRes()
  );
  const res = makeRes();
  await handlePutProfile(
    makeReq({ pool, body: { profile: { firstName: "Joe", age: 31, handedness: "Right" } } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile.age, 31);
  assert.equal(res.body.profile.handedness, "Right");
  assert.equal(pool.store().size, 1, "should remain a single row");
});

test("PUT strips forbidden keys (user_id, password, tokens) before write", async () => {
  const pool = makeStubPool();
  const req = makeReq({
    pool,
    body: {
      profile: {
        firstName: "Joe",
        user_id: "ATTACK-SOMEONE-ELSE",
        userId: "ATTACK-SOMEONE-ELSE",
        passwordHash: "$$$",
        password: "hunter2",
        nested: { jti: "should-strip", keep: "yes" }
      }
    }
  });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile.user_id, undefined);
  assert.equal(res.body.profile.userId, undefined);
  assert.equal(res.body.profile.passwordHash, undefined);
  assert.equal(res.body.profile.password, undefined);
  assert.equal(res.body.profile.nested.jti, undefined);
  assert.equal(res.body.profile.nested.keep, "yes");
});

test("PUT cannot affect another user's profile (user_id comes from JWT, not body)", async () => {
  const pool = makeStubPool();

  // User A creates a profile
  await handlePutProfile(
    makeReq({
      userId: "user-A",
      pool,
      body: { profile: { firstName: "Alice", handicap: 8 } }
    }),
    makeRes()
  );

  // User B sends a payload that TRIES to claim user_id=user-A
  await handlePutProfile(
    makeReq({
      userId: "user-B",
      pool,
      body: {
        profile: {
          firstName: "Bob",
          user_id: "user-A",       // ← attacker attempt
          userId: "user-A",
          handicap: 99
        }
      }
    }),
    makeRes()
  );

  // User A should still see Alice's data
  const aRes = makeRes();
  await handleGetProfile(makeReq({ userId: "user-A", pool }), aRes);
  assert.equal(aRes.body.profile.firstName, "Alice");
  assert.equal(aRes.body.profile.handicap, 8);

  // User B should see Bob's data
  const bRes = makeRes();
  await handleGetProfile(makeReq({ userId: "user-B", pool }), bRes);
  assert.equal(bRes.body.profile.firstName, "Bob");
  assert.equal(bRes.body.profile.handicap, 99);

  // Two distinct rows must exist
  assert.equal(pool.store().size, 2);
});

test("PUT normalizes unknown syncDecision values to 'unspecified'", async () => {
  const pool = makeStubPool();
  const req = makeReq({
    pool,
    body: {
      profile: { firstName: "Joe" },
      syncDecision: "random-future-value"
    }
  });
  const res = makeRes();
  await handlePutProfile(req, res);
  assert.equal(res.body.syncDecision, "unspecified");
  assert.equal(res.body.profile.last_sync_decision, "unspecified");
});

test("PUT roundtrips: GET after PUT returns identical (non-server-stamped) fields", async () => {
  const pool = makeStubPool();
  const inputProfile = {
    firstName: "Joe",
    email: "joe@example.com",
    age: 33,
    handedness: "Left",
    skillLevel: "Intermediate",
    playStyle: "Balanced",
    manualHandicap: 12.5,
    distanceUnit: "yards",
    temperatureUnit: "fahrenheit",
    clubDistances: [
      { name: "Driver", carryYards: 245 },
      { name: "7i", carryYards: 155 }
    ],
    tendencies: { missesLeftPct: 28 }
  };
  await handlePutProfile(
    makeReq({ pool, body: { profile: inputProfile, syncDecision: "replace" } }),
    makeRes()
  );
  const res = makeRes();
  await handleGetProfile(makeReq({ pool }), res);
  for (const k of Object.keys(inputProfile)) {
    assert.deepEqual(res.body.profile[k], inputProfile[k], `mismatch on ${k}`);
  }
  assert.equal(res.body.profile.last_sync_decision, "replace");
  assert.ok(res.body.profile.last_sync_at);
});
