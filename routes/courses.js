"use strict";

/**
 * Week 1 Course routes:
 * - Google Places: autocomplete, details, nearby
 * - Course matching: resolve
 * - Course intelligence: GET /:id, /:id/tees, /:id/holes, /:id/holes/:number/layout
 */

const express = require("express");
const router = express.Router();
const googlePlaces = require("../services/googlePlaces");
const courseMatching = require("../services/courseMatching");
const courseIntelligence = require("../services/courseIntelligence");

function getDbPool(req) {
  return req.app.get("dbPool") || null;
}

function safeTrim(v, max = 120) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// --- Google Places ---

router.get("/autocomplete", async (req, res) => {
  try {
    googlePlaces.getApiKey();
  } catch (err) {
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
  try {
    const query = req.query.query || req.query.q;
    const { lat, lon } = req.query;
    const result = await googlePlaces.autocomplete(query, lat, lon);
    return res.json(result);
  } catch (err) {
    console.error("Autocomplete error:", err.message);
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
});

router.get("/details", async (req, res) => {
  try {
    googlePlaces.getApiKey();
  } catch (err) {
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
  try {
    const { placeId, resolve: resolveFlag } = req.query;
    if (!placeId) {
      return res.status(400).json({ error: "placeId is required" });
    }
    const details = await googlePlaces.getPlaceDetails(placeId);
    if (!details) {
      return res.status(404).json({ error: "Place not found" });
    }
    if (resolveFlag === "1" || resolveFlag === "true") {
      const pool = getDbPool(req);
      if (pool) {
        const matchResult = await courseMatching.resolve(pool, placeId, details);
        if (matchResult.courseId) {
          const payload = await courseIntelligence.getFullCoursePayload(pool, matchResult.courseId);
          return res.json({
            place: details,
            course: payload,
            matched: true
          });
        }
        if (matchResult.candidates) {
          return res.json({
            place: details,
            candidates: matchResult.candidates,
            matched: false
          });
        }
      }
    }
    return res.json({ place: details });
  } catch (err) {
    console.error("Details error:", err.message);
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
});

router.get("/nearby", async (req, res) => {
  try {
    googlePlaces.getApiKey();
  } catch (err) {
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
  try {
    const { lat, lon, radius_km } = req.query;
    const result = await googlePlaces.nearbySearch(lat, lon, radius_km);
    return res.json(result);
  } catch (err) {
    console.error("Nearby error:", err.message);
    return res.status(503).json({ error: "Course search temporarily unavailable" });
  }
});

// --- Resolve (Google Place -> Golf Course) ---

router.post("/resolve", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable" });
  }
  try {
    const { placeId, courseId: manualCourseId } = req.body || {};
    if (!placeId) {
      return res.status(400).json({ error: "placeId is required" });
    }
    if (manualCourseId) {
      const result = await courseMatching.confirmMatch(pool, placeId, manualCourseId);
      const payload = await courseIntelligence.getFullCoursePayload(pool, result.courseId);
      return res.json({ ...result, course: payload });
    }
    let details = null;
    try {
      googlePlaces.getApiKey();
      details = await googlePlaces.getPlaceDetails(placeId);
    } catch (e) {
      return res.status(503).json({ error: "Course search temporarily unavailable" });
    }
    const result = await courseMatching.resolve(pool, placeId, details);
    if (result.error) {
      return res.status(404).json({ error: result.error });
    }
    if (result.courseId) {
      const payload = await courseIntelligence.getFullCoursePayload(pool, result.courseId);
      return res.json({ ...result, course: payload });
    }
    if (result.candidates) {
      return res.json(result);
    }
    return res.status(404).json({ error: "No match found" });
  } catch (err) {
    console.error("Resolve error:", err.message);
    return res.status(500).json({ error: "Resolve failed" });
  }
});

// --- Course Intelligence ---

router.get("/:id", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable" });
  }
  try {
    const payload = await courseIntelligence.getFullCoursePayload(pool, req.params.id);
    if (!payload) {
      return res.status(404).json({ error: "Course not found" });
    }
    return res.json(payload);
  } catch (err) {
    console.error("Course fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch course" });
  }
});

router.get("/:id/tees", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable" });
  }
  try {
    const course = await courseIntelligence.getCourseById(pool, req.params.id);
    if (!course) return res.status(404).json({ error: "Course not found" });
    const tees = await courseIntelligence.getTeesByCourseId(pool, course.id);
    const withYards = await Promise.all(
      tees.map(async (t) => {
        const lengths = await courseIntelligence.getTeeLengthsByTeeId(pool, t.id);
        const totalYards = lengths ? Object.values(lengths).reduce((a, b) => a + b, 0) : 0;
        return {
          id: t.id,
          name: t.tee_name,
          color: t.tee_color,
          slope: t.slope,
          courseRating: t.course_rating,
          totalYards
        };
      })
    );
    return res.json({ tees: withYards });
  } catch (err) {
    console.error("Tees fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch tees" });
  }
});

router.get("/:id/holes", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable" });
  }
  try {
    const payload = await courseIntelligence.getFullCoursePayload(pool, req.params.id);
    if (!payload) return res.status(404).json({ error: "Course not found" });
    return res.json({ holes: payload.holes });
  } catch (err) {
    console.error("Holes fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch holes" });
  }
});

router.get("/:id/holes/:number/layout", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    return res.status(503).json({ error: "Database unavailable" });
  }
  try {
    const layout = await courseIntelligence.getHoleLayout(
      pool,
      req.params.id,
      req.params.number
    );
    if (!layout) return res.status(404).json({ error: "Hole layout not found" });
    return res.json(layout);
  } catch (err) {
    console.error("Layout fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch layout" });
  }
});

module.exports = router;
