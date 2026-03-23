#!/usr/bin/env node
"use strict";

/**
 * Validate Week 1 ingestion: run sample queries and report counts.
 * Usage: node scripts/validate-ingestion.js
 * Requires DATABASE_URL in env.
 */

const { Pool } = require("pg");

require("dotenv").config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  try {
    const tables = [
      "golf_clubs",
      "golf_courses",
      "golf_course_holes",
      "golf_tees",
      "golf_tee_hole_lengths",
      "golf_hole_pois",
      "course_place_mappings"
    ];

    console.log("Table row counts:\n");
    for (const table of tables) {
      const res = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
      console.log(`  ${table}: ${res.rows[0].n}`);
    }

    const sampleCourse = await pool.query(`
      SELECT gc.id, gc.course_name, c.name AS club_name, c.city, c.state
      FROM golf_courses gc
      JOIN golf_clubs c ON gc.club_id = c.id
      LIMIT 5
    `);
    console.log("\nSample courses:");
    for (const r of sampleCourse.rows) {
      console.log(`  - ${r.course_name} @ ${r.club_name} (${r.city}, ${r.state})`);
    }

    const withPois = await pool.query(`
      SELECT COUNT(DISTINCT gc.id) AS n
      FROM golf_courses gc
      JOIN golf_hole_pois hp ON hp.course_id = gc.id
      WHERE hp.poi_type = 'Green' AND hp.location_label = 'C'
    `);
    console.log(`\nCourses with green center POIs: ${withPois.rows[0].n}`);

    const withLocation = await pool.query(`
      SELECT COUNT(*) AS n FROM golf_courses WHERE location IS NOT NULL
    `);
    console.log(`Courses with computed location: ${withLocation.rows[0].n}`);

    console.log("\n✓ Validation complete");
  } catch (err) {
    console.error("Validation failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
