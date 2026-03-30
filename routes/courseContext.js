"use strict";

/**
 * GET /api/course-context/:courseId
 * Single round-engine payload: course, holes (with green_center), tees. No POI bulk.
 */

const express = require("express");
const router = express.Router();
const courseIntelligence = require("../services/courseIntelligence");

function getDbPool(req) {
  return req.app.get("dbPool") || null;
}

router.get("/:courseId", async (req, res) => {
  const pool = getDbPool(req);
  if (!pool) {
    console.error("[COURSE_CONTEXT] Database pool unavailable");
    return res.status(503).json({ error: "Database unavailable" });
  }
  const requestedId = req.params.courseId;
  console.log(`[COURSE_CONTEXT] requested courseId: ${requestedId}`);
  try {
    const payload = await courseIntelligence.getRoundCourseContext(pool, requestedId);
    if (!payload) {
      console.warn(`[COURSE_CONTEXT] No course found for courseId: ${requestedId}`);
      return res.status(404).json({ error: "Course not found" });
    }
    console.log(`[COURSE_CONTEXT] resolved courseId: ${payload.course.id} name: ${payload.course.name} holes: ${payload.holes.length} tees: ${payload.tees.length}`);
    return res.json(payload);
  } catch (err) {
    console.error(`[COURSE_CONTEXT] error for courseId ${requestedId}: ${err.message}`);
    return res.status(500).json({ error: "Failed to load course context" });
  }
});

module.exports = router;
