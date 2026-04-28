#!/usr/bin/env node
"use strict";

/**
 * audit-hazard-coverage.js
 *
 * Live-DB audit of hazard POI coverage across the course database.
 * Single source of truth used by both the CLI and /api/admin/hazard-coverage.
 *
 * Usage:
 *   node scripts/audit-hazard-coverage.js
 *   node scripts/audit-hazard-coverage.js --json
 *   node scripts/audit-hazard-coverage.js --course="Herndon"
 *   node scripts/audit-hazard-coverage.js --course-id=<uuid>
 *   node scripts/audit-hazard-coverage.js --top=50
 *
 * Output:
 *   - summary totals
 *   - top N weakest courses
 *   - top N strongest courses
 *   - per-course breakdown for matching courses (when --course is set)
 *
 * Counts only USABLE hazard POIs:
 *   - valid lat/lon
 *   - not tee / not green
 *   - normalizes to a known hazard category (positive whitelist)
 */

const { Pool } = require("pg");
require("dotenv").config();

const {
  normalizeHazardType,
  coarseCategory,
  computeCoverageScore,
  holeCoverageStatus
} = require("../services/hazardClassifier");

function parseArgs(argv) {
  const args = { json: false, top: 50, course: null, courseId: null };
  for (const a of argv.slice(2)) {
    if (a === "--json") args.json = true;
    else if (a.startsWith("--top=")) args.top = parseInt(a.split("=")[1], 10) || 50;
    else if (a.startsWith("--course=")) args.course = a.split("=")[1];
    else if (a.startsWith("--course-id=")) args.courseId = a.split("=")[1];
  }
  return args;
}

/**
 * Compute hazard coverage for every course in a single pass.
 *
 * Returns:
 *   {
 *     summary: { totalCourses, totalHoles, totalUsableHazards, ... },
 *     courses: [ {courseId, courseName, totalHoles, holesWithHazards, ...
 *                 hazardCoverageScore, coverageStatus, perHole: [...]} ]
 *   }
 *
 * Single SQL query, single pass — designed for production scale.
 */
async function buildCoverageReport(pool, opts = {}) {
  const includePerHole = opts.includePerHole !== false;

  const sql = `
    SELECT c.id           AS course_uuid,
           c.course_id    AS course_id,
           c.course_name,
           c.num_holes,
           h.hole_number,
           h.par,
           p.id::text     AS poi_id,
           TRIM(p.poi_type)      AS poi_type,
           p.location_label,
           p.fairway_side,
           p.lat,
           p.lon
    FROM golf_courses c
    JOIN golf_course_holes h ON h.course_id = c.id
    LEFT JOIN golf_hole_pois p
      ON p.course_id = c.id
     AND p.hole_number = h.hole_number
     AND LOWER(TRIM(p.poi_type)) NOT IN ('green', 'tee', 'tee front', 'tee back')
    ORDER BY c.course_name, h.hole_number
  `;
  const res = await pool.query(sql);

  // courseUuid → { meta, perHoleMap }
  const courseMap = new Map();
  const normalizedTypeCounts = {};
  let totalUsableHazards = 0;
  let totalPoisSeen = 0;
  let totalPoisWithCoords = 0;

  for (const row of res.rows) {
    const courseKey = row.course_uuid;
    if (!courseMap.has(courseKey)) {
      courseMap.set(courseKey, {
        courseUuid: row.course_uuid,
        courseId: row.course_id,
        courseName: row.course_name || "(unknown)",
        numHoles: Number(row.num_holes) || 18,
        perHole: new Map()
      });
    }
    const course = courseMap.get(courseKey);
    if (!course.perHole.has(row.hole_number)) {
      course.perHole.set(row.hole_number, {
        holeNumber: Number(row.hole_number),
        par: Number(row.par) || null,
        hazardCount: 0,
        hasBunker: false,
        hasWater: false,
        hasTrees: false,
        hasOB: false,
        normalizedTypes: new Set()
      });
    }
    if (!row.poi_id) continue; // hole exists but no hazard POI on it (LEFT JOIN miss)

    totalPoisSeen++;
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    totalPoisWithCoords++;

    const normalizedType = normalizeHazardType(row.poi_type, row.location_label, row.fairway_side);
    if (!normalizedType) continue;

    const hole = course.perHole.get(row.hole_number);
    hole.hazardCount += 1;
    hole.normalizedTypes.add(normalizedType);
    const coarse = coarseCategory(normalizedType);
    if (coarse === "bunker") hole.hasBunker = true;
    if (coarse === "water") hole.hasWater = true;
    if (coarse === "trees") hole.hasTrees = true;
    if (coarse === "out_of_bounds") hole.hasOB = true;

    normalizedTypeCounts[normalizedType] = (normalizedTypeCounts[normalizedType] || 0) + 1;
    totalUsableHazards += 1;
  }

  // Roll up per-course aggregates
  const courses = [];
  let totalHoles = 0;
  let coursesWithNoHazards = 0;

  for (const c of courseMap.values()) {
    const perHole = Array.from(c.perHole.values()).sort((a, b) => a.holeNumber - b.holeNumber);
    const totalHolesC = perHole.length;
    let holesWithHazards = 0;
    let holesWithBunkers = 0;
    let holesWithWater = 0;
    let holesWithTrees = 0;
    let holesWithOB = 0;
    let totalHazards = 0;
    let totalCoordPois = 0;

    for (const h of perHole) {
      if (h.hazardCount > 0) holesWithHazards++;
      if (h.hasBunker) holesWithBunkers++;
      if (h.hasWater) holesWithWater++;
      if (h.hasTrees) holesWithTrees++;
      if (h.hasOB) holesWithOB++;
      totalHazards += h.hazardCount;
      totalCoordPois += h.hazardCount; // already filtered to valid coords
    }

    const { score, status } = computeCoverageScore({
      totalHoles: totalHolesC,
      holesWithHazards,
      holesWithBunkers,
      holesWithWater,
      totalPois: totalHazards,
      poisWithCoords: totalCoordPois
    });

    if (holesWithHazards === 0) coursesWithNoHazards++;
    totalHoles += totalHolesC;

    const courseRecord = {
      courseId: c.courseUuid,
      courseExternalId: c.courseId,
      courseName: c.courseName,
      totalHoles: totalHolesC,
      holesWithHazards,
      holesWithBunkers,
      holesWithWater,
      holesWithTrees,
      holesWithOB,
      totalHazards,
      avgHazardsPerHole: totalHolesC > 0 ? Math.round((totalHazards / totalHolesC) * 10) / 10 : 0,
      hazardCoveragePct: totalHolesC > 0 ? Math.round((holesWithHazards / totalHolesC) * 100) : 0,
      hazardCoverageScore: score,
      coverageStatus: status
    };
    if (includePerHole) {
      courseRecord.holes = perHole.map((h) => ({
        holeNumber: h.holeNumber,
        par: h.par,
        hazardCount: h.hazardCount,
        normalizedTypes: Array.from(h.normalizedTypes).sort(),
        hasWater: h.hasWater,
        hasBunker: h.hasBunker,
        hasTrees: h.hasTrees,
        hasOB: h.hasOB,
        coverageStatus: holeCoverageStatus(h)
      }));
    }
    courses.push(courseRecord);
  }

  const totalCourses = courses.length;
  const avgCoveragePct = totalCourses > 0
    ? Math.round(courses.reduce((a, c) => a + c.hazardCoveragePct, 0) / totalCourses)
    : 0;
  const avgCoverageScore = totalCourses > 0
    ? Math.round(courses.reduce((a, c) => a + c.hazardCoverageScore, 0) / totalCourses)
    : 0;
  const coursesWithLowCoverage = courses.filter((c) => c.hazardCoverageScore < 20).length;

  return {
    summary: {
      totalCourses,
      totalHoles,
      totalUsableHazards,
      totalPoisSeen,
      totalPoisWithCoords,
      avgCoveragePct,
      avgCoverageScore,
      coursesWithNoHazards,
      coursesWithLowCoverage,
      normalizedTypeCounts
    },
    courses
  };
}

function rankWeakest(courses, limit) {
  return [...courses]
    .sort((a, b) => a.hazardCoverageScore - b.hazardCoverageScore || a.courseName.localeCompare(b.courseName))
    .slice(0, limit)
    .map(stripHoles);
}

function rankStrongest(courses, limit) {
  return [...courses]
    .sort((a, b) => b.hazardCoverageScore - a.hazardCoverageScore || a.courseName.localeCompare(b.courseName))
    .slice(0, limit)
    .map(stripHoles);
}

function stripHoles(c) {
  const { holes, ...rest } = c;
  return rest;
}

function printSummary(report) {
  const s = report.summary;
  console.log("\n=== HAZARD COVERAGE AUDIT ===");
  console.log(`Total courses:              ${s.totalCourses.toLocaleString()}`);
  console.log(`Total holes:                ${s.totalHoles.toLocaleString()}`);
  console.log(`Total POIs scanned:         ${s.totalPoisSeen.toLocaleString()}`);
  console.log(`POIs with valid coords:     ${s.totalPoisWithCoords.toLocaleString()}`);
  console.log(`Usable hazards (whitelist): ${s.totalUsableHazards.toLocaleString()}`);
  console.log(`Avg coverage %:             ${s.avgCoveragePct}%`);
  console.log(`Avg coverage score:         ${s.avgCoverageScore}/100`);
  console.log(`Courses with NO hazards:    ${s.coursesWithNoHazards.toLocaleString()}`);
  console.log(`Courses with LOW coverage:  ${s.coursesWithLowCoverage.toLocaleString()} (score < 20)`);
  console.log(`\nNormalized type breakdown:`);
  const entries = Object.entries(s.normalizedTypeCounts).sort((a, b) => b[1] - a[1]);
  for (const [t, n] of entries) {
    console.log(`  ${t.padEnd(20)} ${n.toLocaleString()}`);
  }
}

function printRanked(title, list) {
  console.log(`\n--- ${title} ---`);
  console.log("score  status     coverage  holes  bunkers  water  trees  OB   course");
  for (const c of list) {
    console.log(
      `${String(c.hazardCoverageScore).padStart(3)}    ${c.coverageStatus.padEnd(9)} `
      + `${String(c.hazardCoveragePct + "%").padStart(5)}     `
      + `${String(c.totalHoles).padStart(4)}   `
      + `${String(c.holesWithBunkers).padStart(5)}    `
      + `${String(c.holesWithWater).padStart(3)}    `
      + `${String(c.holesWithTrees).padStart(3)}    `
      + `${String(c.holesWithOB).padStart(2)}   `
      + `${c.courseName}`
    );
  }
}

function printPerCourse(course) {
  console.log(`\n=== ${course.courseName} (${course.courseId}) ===`);
  console.log(`Total holes: ${course.totalHoles}`);
  console.log(`Coverage: ${course.hazardCoverageScore}/100 (${course.coverageStatus})`);
  console.log(`Total hazards: ${course.totalHazards} | Avg/hole: ${course.avgHazardsPerHole}`);
  console.log(`Holes with: bunkers=${course.holesWithBunkers}  water=${course.holesWithWater}  trees=${course.holesWithTrees}  OB=${course.holesWithOB}`);
  if (course.holes) {
    console.log(`\nhole  par  hazards  status     types`);
    for (const h of course.holes) {
      console.log(
        ` ${String(h.holeNumber).padStart(2)}   ${String(h.par || "?").padStart(2)}    `
        + `${String(h.hazardCount).padStart(3)}     `
        + `${h.coverageStatus.padEnd(10)} `
        + `${h.normalizedTypes.join(", ") || "-"}`
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  try {
    const report = await buildCoverageReport(pool, { includePerHole: true });

    if (args.json) {
      const out = {
        summary: report.summary,
        weakestCourses: rankWeakest(report.courses, args.top),
        strongestCourses: rankStrongest(report.courses, args.top)
      };
      if (args.course || args.courseId) {
        const term = (args.course || "").toLowerCase();
        out.matched = report.courses.filter((c) => {
          if (args.courseId && c.courseId === args.courseId) return true;
          if (term && c.courseName.toLowerCase().includes(term)) return true;
          return false;
        });
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    printSummary(report);
    printRanked(`TOP ${args.top} WEAKEST COURSES`, rankWeakest(report.courses, args.top));
    printRanked(`TOP ${args.top} STRONGEST COURSES`, rankStrongest(report.courses, args.top));

    if (args.course || args.courseId) {
      const term = (args.course || "").toLowerCase();
      const matches = report.courses.filter((c) => {
        if (args.courseId && c.courseId === args.courseId) return true;
        if (term && c.courseName.toLowerCase().includes(term)) return true;
        return false;
      });
      if (matches.length === 0) {
        console.log(`\nNo courses matched: course='${args.course || ""}' courseId='${args.courseId || ""}'`);
      } else {
        for (const m of matches) printPerCourse(m);
      }
    }
  } catch (err) {
    console.error("Audit failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildCoverageReport, rankWeakest, rankStrongest };
