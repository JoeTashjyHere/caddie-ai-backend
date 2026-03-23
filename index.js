"use strict";

require("dotenv").config();

/**
 * Caddie.AI Backend (Deploy-ready)
 * - Works on Render (PORT from env, binds 0.0.0.0)
 * - Health: /health and /api/health
 * - Vision: POST /api/openai/vision (supports base64 JSON OR multipart file upload)
 * - Complete: POST /api/openai/complete
 * - Courses: GET /api/courses (local fallback)
 * - Analytics: POST /api/analytics/events, GET /api/analytics/events/recent
 * - Recommendation analytics: POST /api/analytics/recommendation, POST /api/analytics/feedback,
 *   GET /api/analytics/recommendation/recent, GET /api/analytics/recommendation/summary
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2
const multer = require("multer");
const fs = require("fs");
const path = require("path");
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}

const app = express();

// CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"]
  })
);

// IMPORTANT: iPhone photos can be large (base64 JSON).
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL || null;

// Multer (memory) for multipart image uploads: field name "image"
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB file
});

// ----------------------------
// Analytics + Safe Logging
// ----------------------------
const analyticsDir = path.join(process.cwd(), "logs");
const analyticsFile = path.join(analyticsDir, "analytics.log");
const analyticsMaxBytes = 5 * 1024 * 1024;
const analyticsBuffer = [];
const analyticsBufferMax = 2000;
const recommendationEventsBuffer = [];
const recommendationFeedbackBuffer = [];
const recommendationBufferMax = 4000;
let persistenceUnavailableLogged = false;

let dbPool = null;
if (DATABASE_URL && Pool) {
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });
  app.set("dbPool", dbPool);
} else if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is not set. Recommendation analytics and course intelligence will be unavailable.");
}

function safeTrim(v, maxLen = 120) {
  if (v == null) return null;
  const s = String(v);
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function ensureAnalyticsDir() {
  if (!fs.existsSync(analyticsDir)) {
    fs.mkdirSync(analyticsDir, { recursive: true });
  }
}

function rotateAnalyticsFileIfNeeded() {
  try {
    ensureAnalyticsDir();
    if (!fs.existsSync(analyticsFile)) return;
    const stat = fs.statSync(analyticsFile);
    if (stat.size > analyticsMaxBytes) {
      const rotated = path.join(analyticsDir, `analytics-${Date.now()}.log`);
      fs.renameSync(analyticsFile, rotated);
    }
  } catch (err) {
    console.error("analytics rotate failed:", err.message);
  }
}

function appendAnalyticsEvent(event) {
  analyticsBuffer.unshift(event);
  if (analyticsBuffer.length > analyticsBufferMax) {
    analyticsBuffer.length = analyticsBufferMax;
  }
  try {
    rotateAnalyticsFileIfNeeded();
    fs.appendFileSync(analyticsFile, `${JSON.stringify(event)}\n`, "utf8");
  } catch (err) {
    console.error("analytics write failed:", err.message);
  }
}

function appendRecommendationEventLocal(event) {
  recommendationEventsBuffer.unshift(event);
  if (recommendationEventsBuffer.length > recommendationBufferMax) {
    recommendationEventsBuffer.length = recommendationBufferMax;
  }
  appendAnalyticsEvent({
    id: `rec_evt_${Date.now()}`,
    timestamp: new Date().toISOString(),
    eventType: "recommendation_event_local",
    recommendationType: event.recommendationType,
    recommendationId: event.recommendationId,
    userId: event.userId,
    sessionId: event.sessionId
  });
}

function appendRecommendationFeedbackLocal(feedback) {
  recommendationFeedbackBuffer.unshift(feedback);
  if (recommendationFeedbackBuffer.length > recommendationBufferMax) {
    recommendationFeedbackBuffer.length = recommendationBufferMax;
  }
  appendAnalyticsEvent({
    id: `rec_fb_${Date.now()}`,
    timestamp: new Date().toISOString(),
    eventType: "recommendation_feedback_local",
    recommendationType: feedback.recommendationType,
    recommendationId: feedback.recommendationId,
    userId: feedback.userId,
    sessionId: feedback.sessionId
  });
}

function safeArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [String(v)];
}

function safeJSON(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  return {};
}

function normalizeRecommendationEvent(body) {
  const context = safeJSON(body.context);
  const profile = body.profile == null ? null : safeJSON(body.profile);
  const output = safeJSON(body.output);
  const diagnostics = safeJSON(body.diagnostics);
  return {
    recommendationId: safeTrim(body.recommendationId, 80) || `rec_${Date.now()}`,
    userId: safeTrim(body.userId, 120) || null,
    sessionId: safeTrim(body.sessionId, 120) || null,
    recommendationType: body.recommendationType === "putt" ? "putt" : "shot",
    createdAt: body.createdAt || new Date().toISOString(),
    context: {
      courseName: safeTrim(context.courseName, 120),
      city: safeTrim(context.city, 120),
      state: safeTrim(context.state, 120),
      holeNumber: Number.isFinite(context.holeNumber) ? context.holeNumber : null,
      distanceToTarget: Number.isFinite(context.distanceToTarget) ? context.distanceToTarget : null,
      lie: safeTrim(context.lie, 60),
      shotType: safeTrim(context.shotType, 60),
      hazards: safeArray(context.hazards).map((x) => safeTrim(x, 120)).filter(Boolean)
    },
    profile: profile
      ? {
          golfGoal: safeTrim(profile.golfGoal, 240),
          seriousness: safeTrim(profile.seriousness, 120),
          riskOffTee: safeTrim(profile.riskOffTee, 120),
          riskAroundHazards: safeTrim(profile.riskAroundHazards, 120),
          greenRiskPreference: safeTrim(profile.greenRiskPreference, 120),
          clubs: safeArray(profile.clubs).map((club) => ({
            clubName: safeTrim(club && club.clubName, 40),
            carryYards: Number.isFinite(club && club.carryYards) ? club.carryYards : null,
            shotPreference: safeTrim(club && club.shotPreference, 80),
            confidenceLevel: safeTrim(club && club.confidenceLevel, 80),
            notes: safeTrim(club && club.notes, 300)
          }))
        }
      : null,
    output: {
      aiSelectedClub: safeTrim(output.aiSelectedClub, 40),
      finalRecommendedClub: safeTrim(output.finalRecommendedClub, 40),
      recommendationText: safeTrim(output.recommendationText, 1500) || "",
      normalizationOccurred: Boolean(output.normalizationOccurred),
      normalizationReason: safeTrim(output.normalizationReason, 200),
      fallbackOccurred: Boolean(output.fallbackOccurred),
      fallbackReason: safeTrim(output.fallbackReason, 200),
      topCandidateClubs: safeArray(output.topCandidateClubs).map((x) => safeTrim(x, 40)).filter(Boolean)
    },
    diagnostics: {
      targetDistanceYards: Number.isFinite(diagnostics.targetDistanceYards) ? diagnostics.targetDistanceYards : null,
      playsLikeDistanceYards: Number.isFinite(diagnostics.playsLikeDistanceYards) ? diagnostics.playsLikeDistanceYards : null,
      weatherSourceQuality: safeTrim(diagnostics.weatherSourceQuality, 40),
      elevationSourceQuality: safeTrim(diagnostics.elevationSourceQuality, 40),
      photoIncluded: Boolean(diagnostics.photoIncluded),
      photoReferenced: Boolean(diagnostics.photoReferenced),
      requestDurationMs: Number.isFinite(diagnostics.requestDurationMs) ? diagnostics.requestDurationMs : null
    }
  };
}

function normalizeRecommendationFeedback(body) {
  return {
    feedbackId: safeTrim(body.feedbackId, 80) || `rfb_${Date.now()}`,
    recommendationId: safeTrim(body.recommendationId, 80),
    userId: safeTrim(body.userId, 120) || null,
    sessionId: safeTrim(body.sessionId, 120) || null,
    recommendationType: body.recommendationType === "putt" ? "putt" : "shot",
    helpful: Boolean(body.helpful),
    feedbackReason: safeTrim(body.feedbackReason, 60),
    freeTextNote: safeTrim(body.freeTextNote, 500),
    rating: Number.isFinite(body.rating) ? body.rating : null,
    submittedAt: body.submittedAt || new Date().toISOString()
  };
}

async function ensureRecommendationTables() {
  if (!dbPool) return false;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS recommendation_events (
      recommendation_id TEXT PRIMARY KEY,
      user_id TEXT,
      session_id TEXT,
      recommendation_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      context_json JSONB NOT NULL,
      profile_json JSONB,
      output_json JSONB NOT NULL,
      diagnostics_json JSONB NOT NULL
    );
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      feedback_id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT,
      recommendation_type TEXT NOT NULL,
      helpful BOOLEAN NOT NULL,
      feedback_reason TEXT,
      free_text_note TEXT,
      rating INTEGER,
      submitted_at TIMESTAMPTZ NOT NULL
    );
  `);
  return true;
}

async function persistRecommendationEvent(event) {
  if (!dbPool) return false;
  await ensureRecommendationTables();
  await dbPool.query(
    `
      INSERT INTO recommendation_events (
        recommendation_id, user_id, session_id, recommendation_type, created_at,
        context_json, profile_json, output_json, diagnostics_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (recommendation_id) DO UPDATE SET
        output_json = EXCLUDED.output_json,
        diagnostics_json = EXCLUDED.diagnostics_json;
    `,
    [
      event.recommendationId,
      event.userId,
      event.sessionId,
      event.recommendationType,
      event.createdAt,
      JSON.stringify(event.context),
      event.profile == null ? null : JSON.stringify(event.profile),
      JSON.stringify(event.output),
      JSON.stringify(event.diagnostics)
    ]
  );
  return true;
}

async function persistRecommendationFeedback(feedback) {
  if (!dbPool) return false;
  await ensureRecommendationTables();
  await dbPool.query(
    `
      INSERT INTO recommendation_feedback (
        feedback_id, recommendation_id, user_id, session_id, recommendation_type,
        helpful, feedback_reason, free_text_note, rating, submitted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (feedback_id) DO NOTHING;
    `,
    [
      feedback.feedbackId,
      feedback.recommendationId,
      feedback.userId,
      feedback.sessionId,
      feedback.recommendationType,
      feedback.helpful,
      feedback.feedbackReason,
      feedback.freeTextNote,
      feedback.rating,
      feedback.submittedAt
    ]
  );
  return true;
}

function requestMeta(req) {
  const body = req.body || {};
  return {
    correlationId: req.get("X-Correlation-ID") || body.correlationId || null,
    recommendationType: body.recommendationType || body.type || null,
    userId: body.userId || null,
    courseName: body.courseName || null,
    holeNumber: body.holeNumber || null
  };
}

// Request logging (safe fields only; never logs image base64 or prompts)
app.use((req, res, next) => {
  const start = Date.now();
  const meta = requestMeta(req);
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        msg: "http_request",
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
        correlationId: meta.correlationId,
        recommendationType: meta.recommendationType,
        userId: safeTrim(meta.userId, 64),
        courseName: safeTrim(meta.courseName, 80),
        holeNumber: meta.holeNumber
      })
    );
  });
  next();
});

// Local in-memory courses (starter list)
const localCourses = [
  { id: "pebble", name: "Pebble Beach Golf Links", par: 72, lat: 36.568, lon: -121.95 },
  { id: "augusta", name: "Augusta National Golf Club", par: 72, lat: 33.502, lon: -82.021 },
  { id: "st-andrews", name: "St. Andrews Links", par: 72, lat: 56.34, lon: -2.818 },
  { id: "local-muni", name: "Local Public Course", par: 70, lat: 37.7749, lon: -122.4194 },
  { id: "country-club", name: "Country Club Course", par: 71, lat: 37.7849, lon: -122.4094 },
  { id: "riverside", name: "Riverside Golf Club", par: 72, lat: 37.7649, lon: -122.4294 },
  { id: "mountain-view", name: "Mountain View Golf Course", par: 69, lat: 37.7549, lon: -122.4394 }
];

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/version", (req, res) => res.json({ version: "2026-03-07-recommendation-events-feedback" }));

function toDataUrlFromBase64(base64OrDataUrl) {
  if (!base64OrDataUrl || typeof base64OrDataUrl !== "string") return null;
  if (base64OrDataUrl.startsWith("data:image/")) return base64OrDataUrl;
  return `data:image/jpeg;base64,${base64OrDataUrl}`;
}

function parseMaybeJSON(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Stub for later external course lookup
async function fetchExternalCourses() {
  return [];
}

// ----------------------------
// Analytics endpoints
// ----------------------------
app.post("/api/analytics/events", (req, res) => {
  try {
    const b = req.body || {};
    const event = {
      id: b.id || `evt_${Date.now()}`,
      timestamp: b.timestamp || new Date().toISOString(),
      eventType: b.eventType || "unknown",
      userId: b.userId || null,
      sessionId: b.sessionId || null,
      recommendationType: b.recommendationType || null,
      correlationId: b.correlationId || req.get("X-Correlation-ID") || null,
      courseName: b.courseName || null,
      city: b.city || null,
      state: b.state || null,
      holeNumber: b.holeNumber ?? null,
      distanceToTarget: b.distanceToTarget ?? null,
      lie: b.lie || null,
      shotType: b.shotType || null,
      hazards: b.hazards || null,
      recommendationText: safeTrim(b.recommendationText, 500),
      success: b.success ?? null,
      durationMs: b.durationMs ?? null,
      errorMessage: safeTrim(b.errorMessage, 300),
      feedbackRating: b.feedbackRating || null,
      feedbackComments: safeTrim(b.feedbackComments, 300)
    };
    appendAnalyticsEvent(event);
    return res.json({ ok: true, buffered: analyticsBuffer.length });
  } catch (err) {
    console.error("analytics endpoint failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to record analytics event" });
  }
});

app.get("/api/analytics/events/recent", (req, res) => {
  const rawLimit = parseInt(req.query.limit || "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  return res.json({ ok: true, events: analyticsBuffer.slice(0, limit) });
});

app.post("/api/analytics/recommendation", async (req, res) => {
  try {
    const normalized = normalizeRecommendationEvent(req.body || {});
    if (!normalized.recommendationId || !normalized.output.recommendationText) {
      return res.status(400).json({ ok: false, error: "Missing required recommendation fields" });
    }

    appendRecommendationEventLocal(normalized);
    let persisted = false;
    try {
      persisted = await persistRecommendationEvent(normalized);
    } catch (err) {
      if (!persistenceUnavailableLogged) {
        persistenceUnavailableLogged = true;
        console.warn("Recommendation persistence unavailable:", err.message);
      }
    }

    return res.json({ ok: true, persisted, recommendationId: normalized.recommendationId });
  } catch (err) {
    console.error("recommendation analytics failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to record recommendation analytics" });
  }
});

app.post("/api/analytics/feedback", async (req, res) => {
  try {
    const normalized = normalizeRecommendationFeedback(req.body || {});
    if (!normalized.recommendationId) {
      return res.status(400).json({ ok: false, error: "Missing recommendationId" });
    }

    appendRecommendationFeedbackLocal(normalized);
    let persisted = false;
    try {
      persisted = await persistRecommendationFeedback(normalized);
    } catch (err) {
      if (!persistenceUnavailableLogged) {
        persistenceUnavailableLogged = true;
        console.warn("Recommendation feedback persistence unavailable:", err.message);
      }
    }

    return res.json({ ok: true, persisted, feedbackId: normalized.feedbackId });
  } catch (err) {
    console.error("recommendation feedback failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to record recommendation feedback" });
  }
});

app.get("/api/analytics/recommendation/recent", async (req, res) => {
  const rawLimit = parseInt(req.query.limit || "20", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 20;

  if (dbPool) {
    try {
      const result = await dbPool.query(
        `SELECT recommendation_id, user_id, session_id, recommendation_type, created_at,
                context_json, profile_json, output_json, diagnostics_json
         FROM recommendation_events
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      const events = result.rows.map((row) => ({
        recommendationId: row.recommendation_id,
        userId: row.user_id,
        sessionId: row.session_id,
        recommendationType: row.recommendation_type,
        createdAt: row.created_at,
        context: row.context_json,
        profile: row.profile_json,
        output: row.output_json,
        diagnostics: row.diagnostics_json
      }));
      return res.json({ ok: true, events, source: "database" });
    } catch (err) {
      console.warn("DB query failed for recent, falling back to buffer:", err.message);
    }
  }

  return res.json({
    ok: true,
    events: recommendationEventsBuffer.slice(0, limit),
    source: "memory"
  });
});

app.get("/api/analytics/recommendation/summary", async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  const recommendationType = req.query.recommendationType === "putt" ? "putt" : req.query.recommendationType === "shot" ? "shot" : null;

  const computeSummary = (events) => {
    const total = events.length;
    const shot = events.filter((e) => e.recommendationType === "shot").length;
    const putt = events.filter((e) => e.recommendationType === "putt").length;
    const normalized = events.filter((e) => e.output && e.output.normalizationOccurred).length;
    const fallback = events.filter((e) => e.output && e.output.fallbackOccurred).length;
    const durations = events
      .map((e) => (e.diagnostics && Number.isFinite(e.diagnostics.requestDurationMs) ? e.diagnostics.requestDurationMs : null))
      .filter((d) => d != null);
    const avgRequestDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    return {
      totalRecommendations: total,
      shotRecommendations: shot,
      puttRecommendations: putt,
      normalizationRate: total > 0 ? normalized / total : 0,
      fallbackRate: total > 0 ? fallback / total : 0,
      avgRequestDurationMs
    };
  };

  if (dbPool) {
    try {
      let query = "SELECT recommendation_id, user_id, session_id, recommendation_type, created_at, context_json, output_json, diagnostics_json FROM recommendation_events WHERE 1=1";
      const params = [];
      let idx = 1;
      if (userId) {
        params.push(userId);
        query += ` AND user_id = $${idx++}`;
      }
      if (recommendationType) {
        params.push(recommendationType);
        query += ` AND recommendation_type = $${idx++}`;
      }
      const result = await dbPool.query(query, params);
      const events = result.rows.map((row) => ({
        recommendationId: row.recommendation_id,
        userId: row.user_id,
        sessionId: row.session_id,
        recommendationType: row.recommendation_type,
        createdAt: row.created_at,
        context: row.context_json,
        output: row.output_json,
        diagnostics: row.diagnostics_json
      }));
      return res.json({ ok: true, ...computeSummary(events), source: "database" });
    } catch (err) {
      console.warn("DB query failed for summary, falling back to buffer:", err.message);
    }
  }

  let events = recommendationEventsBuffer;
  if (userId || recommendationType) {
    events = events.filter((e) => {
      if (userId && e.userId !== userId) return false;
      if (recommendationType && e.recommendationType !== recommendationType) return false;
      return true;
    });
  }
  return res.json({ ok: true, ...computeSummary(events), source: "memory" });
});

app.post("/api/feedback/caddie", (req, res) => {
  const body = req.body || {};
  appendAnalyticsEvent({
    id: `legacy_feedback_${Date.now()}`,
    timestamp: new Date().toISOString(),
    eventType: "legacy_feedback_caddie",
    recommendationType: "shot",
    courseName: safeTrim(body.courseId, 120),
    holeNumber: body.hole ?? null,
    recommendationText: safeTrim(body.userFeedback, 300),
    success: true
  });
  return res.json({ ok: true });
});

// Legacy /api/courses list (exact path) - defined before router so it takes precedence
app.get("/api/courses", async (req, res) => {
  try {
    const { lat, lon, query } = req.query;

    if (query) {
      const filtered = localCourses.filter((c) =>
        c.name.toLowerCase().includes(String(query).toLowerCase())
      );
      if (filtered.length > 0) return res.json({ source: "local", courses: filtered });
    }

    try {
      const externalCourses = await fetchExternalCourses(lat, lon, query);
      if (externalCourses.length > 0) return res.json({ source: "external", courses: externalCourses });
    } catch (err) {
      console.error("External course lookup failed:", err.message);
    }

    let coursesToReturn = localCourses;

    if (lat && lon) {
      const userLat = parseFloat(lat);
      const userLon = parseFloat(lon);

      coursesToReturn = localCourses
        .filter((c) => c.lat && c.lon)
        .map((course) => ({
          ...course,
          distance: Math.sqrt(Math.pow(course.lat - userLat, 2) + Math.pow(course.lon - userLon, 2))
        }))
        .sort((a, b) => a.distance - b.distance)
        .map(({ distance, ...course }) => course);
    }

    return res.json({ source: "fallback-local", courses: coursesToReturn });
  } catch (err) {
    console.error("Error in /api/courses:", err.message);
    return res.json({ source: "error-fallback", courses: localCourses });
  }
});

// Week 1 Course routes (Google Places, matching, course intelligence)
const coursesRouter = require("./routes/courses");
app.use("/api/courses", coursesRouter);

// Text-only OpenAI endpoint
app.post("/api/openai/complete", async (req, res) => {
  try {
    const body = req.body || {};
    const correlationId = req.get("X-Correlation-ID") || body.correlationId || null;
    const system = body.system;
    const user = body.user;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY", correlationId });
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system || "You are a helpful assistant." },
          { role: "user", content: user || "" }
        ]
      })
    });

    const data = await r.json();
    if (data.error) {
      return res.status(500).json({
        error: "OpenAI call failed",
        detail: safeTrim(data?.error?.message || data?.error?.type || "provider_error", 200),
        correlationId
      });
    }

    const content = data?.choices?.[0]?.message?.content ?? "";
    return res.json({ resultJSON: content, correlationId });
  } catch (err) {
    const correlationId = req.get("X-Correlation-ID") || req.body?.correlationId || null;
    console.error("Server error:", err.message);
    return res.status(500).json({ error: "OpenAI call failed", detail: "server_error", correlationId });
  }
});

/**
 * Vision endpoint (JSON base64 OR multipart upload)
 *
 * JSON mode:
 *  POST /api/openai/vision
 *  { "context": {...} or "{\"system\":\"...\"}", "image": "<base64>" or "data:image/jpeg;base64,..." }
 *
 * Multipart mode:
 *  POST /api/openai/vision (form-data)
 *  fields:
 *   - context: (optional) JSON string
 *   - image: file
 */
app.post("/api/openai/vision", upload.single("image"), async (req, res) => {
  try {
    const correlationId = req.get("X-Correlation-ID") || req.body?.correlationId || null;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY", correlationId });
    }

    // context can come from JSON body or multipart field
    const contextRaw = (req.body && req.body.context) || (req.body && req.body.system) || null;
    const ctx = parseMaybeJSON(contextRaw);

    let dataUrl = null;

    // If multipart file provided
    if (req.file && req.file.buffer) {
      const mime = req.file.mimetype || "image/jpeg";
      const b64 = req.file.buffer.toString("base64");
      dataUrl = `data:${mime};base64,${b64}`;
    } else {
      // JSON base64 mode
      const imageRaw = req.body && req.body.image;
      dataUrl = toDataUrlFromBase64(imageRaw);
    }

    if (!dataUrl) {
      return res.status(400).json({
        error: "Missing or invalid image. Send base64 in JSON or upload multipart field 'image'.",
        correlationId
      });
    }

    const systemPrompt =
      (ctx && typeof ctx === "object" && ctx.system) ||
      "You are a golf course analysis AI. Analyze this photo and return JSON only.";

    const userPrompt =
      (ctx && typeof ctx === "object" && ctx.user) ||
      "Return JSON only with isOnGreen, lie, and confidence fields (0-1).";
    const userPromptWithImageEvidence = `${userPrompt}\n\nWhen relevant, cite photo-visible evidence (lie, stance constraints, obstacles, landing window) instead of generic assumptions.`;

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPromptWithImageEvidence },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (data.error) {
      return res.status(500).json({
        error: "OpenAI vision call failed",
        detail: safeTrim(data?.error?.message || data?.error?.type || "provider_error", 200),
        correlationId
      });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(500).json({
        error: "Unexpected OpenAI response shape",
        detail: "missing_content",
        correlationId
      });
    }

    return res.json({ resultJSON: content, correlationId });
  } catch (err) {
    const correlationId = req.get("X-Correlation-ID") || req.body?.correlationId || null;
    console.error("Vision server error:", err.message);
    return res.status(500).json({ error: "Vision call failed", detail: "server_error", correlationId });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  ensureAnalyticsDir();
  if (dbPool) {
    try {
      await ensureRecommendationTables();
      console.log("✅ Recommendation tables ready");
    } catch (err) {
      console.warn("⚠️ Could not create recommendation tables:", err.message);
    }
  }
  console.log(`✅ API running on port ${PORT}`);
});
