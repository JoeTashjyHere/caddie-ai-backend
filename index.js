"use strict";

/**
 * Caddie.AI Backend (Deploy-ready)
 * - Works on Render (PORT from env, binds 0.0.0.0)
 * - Health: /health and /api/health
 * - Vision: POST /api/openai/vision (supports base64 JSON OR multipart file upload)
 * - Complete: POST /api/openai/complete
 * - Courses: GET /api/courses (local fallback)
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2
const multer = require("multer");

const app = express();

// CORS
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Content-Type", "Authorization"] }));

// IMPORTANT: iPhone photos can be large (base64 JSON).
// Increase request size to avoid 413 from Express.
// If still too big, reduce JPEG quality client-side OR use multipart upload (supported below).
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));

// Request logging (shows in Render logs)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Multer (memory) for multipart image uploads: field name "image"
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB file
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
app.get("/version", (req, res) => res.json({ version: "2025-12-22-vision-route" }));

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

// Courses endpoint
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
      console.error("External course lookup failed:", err);
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
    console.error("Error in /api/courses:", err);
    return res.json({ source: "error-fallback", courses: localCourses });
  }
});

// Text-only OpenAI endpoint
app.post("/api/openai/complete", async (req, res) => {
  try {
    const { system, user } = req.body || {};

    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

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
    if (data.error) return res.status(500).json({ error: "OpenAI call failed", detail: data.error });

    const content = data?.choices?.[0]?.message?.content ?? "";
    return res.json({ resultJSON: content });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "OpenAI call failed", detail: String(err) });
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
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

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
      return res.status(400).json({ error: "Missing or invalid image. Send base64 in JSON or upload multipart field 'image'." });
    }

    const systemPrompt =
      (ctx && typeof ctx === "object" && (ctx.system || ctx.user)) ||
      "You are a golf course analysis AI. Analyze this photo and return JSON only.";

    const userPrompt =
      (ctx && typeof ctx === "object" && ctx.user) ||
      "Return JSON only with isOnGreen, lie, and confidence fields (0-1).";

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
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
    if (data.error) return res.status(500).json({ error: "OpenAI vision call failed", detail: data.error });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: "Unexpected OpenAI response shape", detail: data });

    return res.json({ resultJSON: content });
  } catch (err) {
    console.error("Vision server error:", err);
    return res.status(500).json({ error: "Vision call failed", detail: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ API running on port ${PORT}`);
});
