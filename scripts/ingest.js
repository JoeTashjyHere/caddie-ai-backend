#!/usr/bin/env node
"use strict";

/**
 * Caddie.AI Week 1 CSV Ingestion Pipeline (idempotent)
 *
 * CONFIRMED CSV RELATIONSHIPS:
 * - clubs.csv: ClubID = physical venue
 * - courses.csv: CourseID = course layout; ClubID -> clubs.csv; CourseID -> tees.csv, coordinates.csv
 * - tees.csv: CourseID -> golf_courses (NOT ClubID)
 * - coordinates.csv: CourseID -> golf_courses (NOT ClubID); hole-level POIs per course
 *
 * Order: golf_clubs -> golf_courses -> golf_course_holes -> golf_tees -> golf_tee_hole_lengths -> golf_hole_pois
 * Uses upserts (ON CONFLICT) throughout. Skips if data exists unless force=true.
 *
 * Usage:
 *   node scripts/ingest.js [--dry-run] [--data-dir=/path] [--force]
 *
 * Env: DATA_SOURCE_PATH (URL or local path). Use --data-dir for explicit local path.
 * Programmatic: runIngestion(pool, { dataDir, dryRun, force, closePool })
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { parse: createCsvParseStream } = require("csv-parse");
const { Pool } = require("pg");
const fetch = require("node-fetch");
const { runMigrations } = require("./run-migrations");
const { Readable } = require("stream");

require("dotenv").config();

const PROGRESS_INTERVAL = 5000;
const POI_BATCH_SIZE = 1000;
const POI_PROGRESS_INTERVAL = 10000;

const errorLogPath = path.join(process.cwd(), "ingestion_errors.log");
let errorLog = [];

function logError(rowNum, file, reason, row) {
  const entry = { rowNum, file, reason, row: safeRow(row) };
  errorLog.push(entry);
  console.error(`[ERROR] ${file}:${rowNum} - ${reason}`);
}

function safeRow(row) {
  if (!row || typeof row !== "object") return null;
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && v.length > 200) o[k] = v.slice(0, 200) + "...";
    else o[k] = v;
  }
  return o;
}

function progress(file, current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  process.stdout.write(`\rProcessing ${file}: ${current.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
}

function trim(s) {
  return typeof s === "string" ? s.trim() : s;
}

function validLat(lat) {
  const n = parseFloat(lat);
  return Number.isFinite(n) && n >= -90 && n <= 90;
}

function validLon(lon) {
  const n = parseFloat(lon);
  return Number.isFinite(n) && n >= -180 && n <= 180;
}

function validHoleNum(n) {
  const i = parseInt(n, 10);
  return Number.isInteger(i) && i >= 1 && i <= 18;
}

function validPar(p) {
  const i = parseInt(p, 10);
  return Number.isInteger(i) && i >= 3 && i <= 6;
}

/** True if string is an absolute URL (http/https). */
function isAbsoluteUrl(s) {
  return typeof s === "string" && (s.startsWith("https://") || s.startsWith("http://"));
}

/** Resolve path or URL for a CSV file. Supports both local paths and absolute URLs. */
function resolveCsvPath(fileName, basePath, dataDir) {
  // Explicit --data-dir as local path takes precedence
  if (dataDir && !isAbsoluteUrl(dataDir)) {
    return path.resolve(dataDir, fileName);
  }
  if (isAbsoluteUrl(basePath)) {
    return `${basePath.replace(/\/$/, "")}/${fileName}`;
  }
  return path.resolve(basePath, fileName);
}

function readCsvFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });
}

async function readCsvFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const content = await res.text();
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });
}

async function readCsv(pathOrUrl) {
  if (isAbsoluteUrl(pathOrUrl)) {
    return readCsvFromUrl(pathOrUrl);
  }
  return readCsvFromFile(pathOrUrl);
}

/**
 * Create a readable stream of CSV rows for coordinates.csv.
 * Uses fs.createReadStream for local paths, fetch + stream for URLs.
 * Does NOT load entire file into memory.
 */
async function createCoordinatesStream(pathOrUrl) {
  const parser = createCsvParseStream({
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });

  if (isAbsoluteUrl(pathOrUrl)) {
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${pathOrUrl}: ${res.status}`);
    const bodyStream = res.body && typeof res.body.pipe === "function"
      ? res.body
      : Readable.fromWeb(res.body);
    bodyStream.pipe(parser);
  } else {
    const fileStream = fs.createReadStream(pathOrUrl);
    fileStream.on("error", (err) => parser.destroy(err));
    fileStream.pipe(parser);
  }
  return parser;
}

/**
 * Run ingestion. Idempotent (upserts). Skips if data exists unless force=true.
 * @param {import("pg").Pool} pool
 * @param {object} options
 * @param {string} [options.dataDir] - Local path to CSV dir (when DATA_SOURCE_TYPE=local)
 * @param {string} [options.dataSourceType] - local | url
 * @param {string} [options.dataSourcePath] - Path or base URL
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.force] - Run even if data exists
 * @param {boolean} [options.closePool=true] - Close pool when done (false when called from init)
 * @returns {Promise<object>}
 */
async function runIngestion(pool, options = {}) {
  const dataDir = options.dataDir ?? null;
  const dataSourcePath =
    options.dataSourcePath ?? process.env.DATA_SOURCE_PATH ?? path.resolve(__dirname, "../data");
  const DRY_RUN = options.dryRun ?? false;
  const force = options.force ?? false;
  const closePool = options.closePool !== false;

  const clubsPath = resolveCsvPath("clubs.csv", dataSourcePath, dataDir);
  const coursesPath = resolveCsvPath("courses.csv", dataSourcePath, dataDir);
  const teesPath = resolveCsvPath("tees.csv", dataSourcePath, dataDir);
  const coordsPath = resolveCsvPath("coordinates.csv", dataSourcePath, dataDir);

  if (!isAbsoluteUrl(clubsPath)) {
    for (const p of [clubsPath, coursesPath, teesPath, coordsPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`Missing file: ${p}`);
      }
    }
  }

  if (!pool && !DRY_RUN) {
    throw new Error("Pool is required for ingestion. Use --dry-run to validate without DB.");
  }

  let courseCount = 0;
  let poiCount = 0;
  if (pool && !DRY_RUN) {
    try {
      const [coursesRes, poisRes] = await Promise.all([
        pool.query("SELECT COUNT(*)::int AS n FROM golf_courses"),
        pool.query("SELECT COUNT(*)::int AS n FROM golf_hole_pois")
      ]);
      courseCount = coursesRes.rows[0]?.n ?? 0;
      poiCount = poisRes.rows[0]?.n ?? 0;
      // Only skip when BOTH courses and POIs exist. If pois = 0, we MUST run POI ingestion.
      if (courseCount > 0 && poiCount > 0 && !force) {
        return { skipped: true, reason: "data_exists", courseCount, poiCount };
      }
      if (courseCount > 0 && poiCount === 0) {
        console.log("[ingest] Skipping courses but continuing POI ingestion (pois = 0)");
      }
    } catch {
      /* tables may not exist yet */
    }
  }

  if (DRY_RUN) {
    console.log("[DRY RUN] Validating CSVs and reporting counts. No database writes.\n");
  }

  const stats = {
    clubs: { insert: 0, update: 0, skip: 0 },
    courses: { insert: 0, update: 0, skip: 0 },
    holes: { insert: 0, update: 0, skip: 0 },
    tees: { insert: 0, update: 0, skip: 0 },
    teeLengths: { insert: 0, update: 0, skip: 0 },
    pois: { insert: 0, update: 0, skip: 0 }
  };

  const idMaps = {
    clubIdToUuid: {},
    courseIdToUuid: {},
    courseIdToNumHoles: {},
    teesIdToUuid: {}
  };

  const skipPriorPhases = courseCount > 0 && !DRY_RUN;
  if (skipPriorPhases) {
    console.log("[ingest] Courses exist. Loading idMaps from DB for POI phase (POIs will NOT be skipped)...");
    const rows = await pool.query("SELECT course_id, id, num_holes FROM golf_courses");
    for (const r of rows.rows) {
      idMaps.courseIdToUuid[r.course_id] = r.id;
      idMaps.courseIdToNumHoles[r.course_id] = r.num_holes === 9 ? 9 : 18;
    }
    console.log(`[ingest] Loaded ${Object.keys(idMaps.courseIdToUuid).length} courses. Skipping clubs/courses/holes/tees.\n`);
  }

  try {
    // --- 1. golf_clubs (skip if courses exist) ---
    if (skipPriorPhases) {
      console.log("✓ clubs: skipped (data exists)");
      console.log("✓ courses: skipped (data exists)");
      console.log("✓ holes: skipped (data exists)");
      console.log("✓ tees: skipped (data exists)");
    } else {
    const clubs = await readCsv(clubsPath);
    const totalClubs = clubs.length;
    for (let i = 0; i < clubs.length; i++) {
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === 0) progress("clubs.csv", i + 1, totalClubs);
      const r = clubs[i];
      const clubId = trim(r.ClubID);
      if (!clubId) {
        logError(i + 2, "clubs.csv", "missing ClubID", r);
        stats.clubs.skip++;
        continue;
      }
      const name = trim(r.ClubName) || "Unknown";
      const lat = parseFloat(r.Latitude);
      const lon = parseFloat(r.Longitude);
      const hasValidCoords = validLat(lat) && validLon(lon);
      const latVal = hasValidCoords ? lat : null;
      const lonVal = hasValidCoords ? lon : null;

      if (DRY_RUN) {
        idMaps.clubIdToUuid[clubId] = `dry-${clubId}`;
        stats.clubs.insert++;
        continue;
      }

      const locationExpr = hasValidCoords
        ? "ST_SetSRID(ST_MakePoint($10::float8, $9::float8), 4326)::geography"
        : "NULL::geography";
      await pool.query(
        `INSERT INTO golf_clubs (club_id, name, address, city, postal_code, state, country, website, lat, lon, location, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${locationExpr}, now())
         ON CONFLICT (club_id) DO UPDATE SET
           name = EXCLUDED.name, address = EXCLUDED.address, city = EXCLUDED.city,
           postal_code = EXCLUDED.postal_code, state = EXCLUDED.state, country = EXCLUDED.country,
           website = EXCLUDED.website, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
           location = EXCLUDED.location, updated_at = now()`,
        [
          clubId,
          name,
          trim(r.Address) || null,
          trim(r.City) || null,
          trim(r.PostalCode) || null,
          trim(r.State) || null,
          trim(r.Country) || "USA",
          trim(r.Website) || null,
          latVal,
          lonVal
        ]
      );
      const uuidRes = await pool.query("SELECT id FROM golf_clubs WHERE club_id = $1", [clubId]);
      idMaps.clubIdToUuid[clubId] = uuidRes.rows[0].id;
      stats.clubs.insert++;
    }
    if (!DRY_RUN) progress("clubs.csv", totalClubs, totalClubs);
    console.log(`\n✓ clubs: ${stats.clubs.insert} processed`);

    // --- 2. golf_courses ---
    const courses = await readCsv(coursesPath);
    const totalCourses = courses.length;
    for (let i = 0; i < courses.length; i++) {
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === 0) progress("courses.csv", i + 1, totalCourses);
      const r = courses[i];
      const courseId = trim(r.CourseID);
      const clubId = trim(r.ClubID);
      if (!courseId || !clubId) {
        logError(i + 2, "courses.csv", "missing CourseID or ClubID", r);
        stats.courses.skip++;
        continue;
      }
      const clubUuid = idMaps.clubIdToUuid[clubId];
      if (!clubUuid) {
        logError(i + 2, "courses.csv", `club not found: ${clubId}`, r);
        stats.courses.skip++;
        continue;
      }
      const courseName = trim(r.CourseName) || "Unknown";
      const numHoles = parseInt(r.NumHoles, 10);
      const numHolesVal = numHoles === 9 ? 9 : 18;
      const ts = parseInt(r.TimestampUpdated, 10) || null;

      if (DRY_RUN) {
        idMaps.courseIdToUuid[courseId] = `dry-${courseId}`;
        idMaps.courseIdToNumHoles[courseId] = numHolesVal;
        stats.courses.insert++;
        continue;
      }

      await pool.query(
        `INSERT INTO golf_courses (course_id, long_course_id, club_id, course_name, num_holes, updated_source_timestamp, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (course_id) DO UPDATE SET
           long_course_id = EXCLUDED.long_course_id, club_id = EXCLUDED.club_id,
           course_name = EXCLUDED.course_name, num_holes = EXCLUDED.num_holes,
           updated_source_timestamp = EXCLUDED.updated_source_timestamp, updated_at = now()`,
        [courseId, trim(r.LongCourseID) || null, clubUuid, courseName, numHolesVal, ts]
      );
      const uuidRes = await pool.query("SELECT id FROM golf_courses WHERE course_id = $1", [courseId]);
      idMaps.courseIdToUuid[courseId] = uuidRes.rows[0].id;
      idMaps.courseIdToNumHoles[courseId] = numHolesVal;
      stats.courses.insert++;
    }
    if (!DRY_RUN) progress("courses.csv", totalCourses, totalCourses);
    console.log(`\n✓ courses: ${stats.courses.insert} processed`);

    // --- 3. golf_course_holes (from courses.csv Par1..Par18, Hcp1..Hcp18) ---
    let holesInserted = 0;
    for (let i = 0; i < courses.length; i++) {
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === 0) progress("courses.csv (holes)", i + 1, totalCourses);
      const r = courses[i];
      const courseId = trim(r.CourseID);
      const courseUuid = idMaps.courseIdToUuid[courseId];
      if (!courseUuid) continue;

      const numHoles = parseInt(r.NumHoles, 10);
      const holeCount = numHoles === 9 ? 9 : 18;
      for (let h = 1; h <= holeCount; h++) {
        const parKey = `Par${h}`;
        const hcpKey = `Hcp${h}`;
        const matchKey = `MatchIndex${h}`;
        const splitKey = `SplitIndex${h}`;
        const par = parseInt(r[parKey], 10);
        const parVal = validPar(par) ? par : 4;
        const hcp = parseInt(r[hcpKey], 10);
        const hcpVal = Number.isInteger(hcp) && hcp >= 1 && hcp <= 18 ? hcp : null;
        const matchIdx = parseInt(r[matchKey], 10) || null;
        const splitIdx = parseInt(r[splitKey], 10) || null;

        if (DRY_RUN) {
          holesInserted++;
          continue;
        }

        await pool.query(
          `INSERT INTO golf_course_holes (course_id, hole_number, par, handicap, match_index, split_index, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (course_id, hole_number) DO UPDATE SET
           par = EXCLUDED.par, handicap = EXCLUDED.handicap,
           match_index = EXCLUDED.match_index, split_index = EXCLUDED.split_index, updated_at = now()`,
          [courseUuid, h, parVal, hcpVal, matchIdx, splitIdx]
        );
        holesInserted++;
      }
    }
    stats.holes.insert = holesInserted;
    if (!DRY_RUN) progress("courses.csv (holes)", totalCourses, totalCourses);
    console.log(`\n✓ holes: ${stats.holes.insert} processed`);

    // --- 4. golf_tees ---
    const tees = await readCsv(teesPath);
    const totalTees = tees.length;
    for (let i = 0; i < tees.length; i++) {
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === 0) progress("tees.csv", i + 1, totalTees);
      const r = tees[i];
      const teesId = `${trim(r.CourseID)}-${trim(r.TeeID)}`;
      const courseId = trim(r.CourseID);
      const courseUuid = idMaps.courseIdToUuid[courseId];
      if (!courseUuid) {
        logError(i + 2, "tees.csv", `course not found: ${courseId}`, r);
        stats.tees.skip++;
        continue;
      }
      const teeName = trim(r.TeeName) || "Unknown";
      const measureUnit = (trim(r.MeasureUnit) || "y").toLowerCase() === "m" ? "m" : "y";

      if (DRY_RUN) {
        idMaps.teesIdToUuid[teesId] = `dry-${teesId}`;
        stats.tees.insert++;
        const holeCountDry = idMaps.courseIdToNumHoles[courseId] || 18;
        for (let h = 1; h <= holeCountDry; h++) stats.teeLengths.insert++;
        continue;
      }

      await pool.query(
        `INSERT INTO golf_tees (tees_id, course_id, tee_name, tee_color, slope, slope_front, slope_back,
           course_rating, course_rating_front, course_rating_back,
           women_slope, women_slope_front, women_slope_back,
           women_course_rating, women_course_rating_front, women_course_rating_back,
           measurement_unit, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
         ON CONFLICT (tees_id) DO UPDATE SET
           course_id = EXCLUDED.course_id, tee_name = EXCLUDED.tee_name, tee_color = EXCLUDED.tee_color,
           slope = EXCLUDED.slope, slope_front = EXCLUDED.slope_front, slope_back = EXCLUDED.slope_back,
           course_rating = EXCLUDED.course_rating, course_rating_front = EXCLUDED.course_rating_front,
           course_rating_back = EXCLUDED.course_rating_back,
           women_slope = EXCLUDED.women_slope, women_slope_front = EXCLUDED.women_slope_front,
           women_slope_back = EXCLUDED.women_slope_back,
           women_course_rating = EXCLUDED.women_course_rating,
           women_course_rating_front = EXCLUDED.women_course_rating_front,
           women_course_rating_back = EXCLUDED.women_course_rating_back,
           measurement_unit = EXCLUDED.measurement_unit, updated_at = now()`,
        [
          teesId,
          courseUuid,
          teeName,
          trim(r.TeeColor) || null,
          parseInt(r.Slope, 10) || null,
          parseInt(r.SlopeFront9, 10) || null,
          parseInt(r.SlopeBack9, 10) || null,
          parseFloat(r.CR) || null,
          parseFloat(r.CRFront9) || null,
          parseFloat(r.CRBack9) || null,
          parseInt(r.SlopeWomen, 10) || null,
          parseInt(r.SlopeWomenFront9, 10) || null,
          parseInt(r.SlopeWomenBack, 10) || null,
          parseFloat(r.CRWomen) || null,
          parseFloat(r.CRWomenFront9) || null,
          parseFloat(r.CRWomenBack9) || null,
          measureUnit
        ]
      );
      const teeUuidRes = await pool.query("SELECT id FROM golf_tees WHERE tees_id = $1", [teesId]);
      const teeUuid = teeUuidRes.rows[0].id;
      idMaps.teesIdToUuid[teesId] = teeUuid;
      stats.tees.insert++;

      // --- 5. golf_tee_hole_lengths (Length1..Length18) ---
      const holeCount = idMaps.courseIdToNumHoles[courseId] || 18;
      for (let h = 1; h <= holeCount; h++) {
        const lenKey = `Length${h}`;
        let len = parseInt(r[lenKey], 10);
        if (!Number.isFinite(len) || len < 0) len = 0;
        if (measureUnit === "m") len = Math.round(len * 1.09361);
        if (DRY_RUN) {
          stats.teeLengths.insert++;
          continue;
        }
        await pool.query(
          `INSERT INTO golf_tee_hole_lengths (tees_id, hole_number, length, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tees_id, hole_number) DO UPDATE SET length = EXCLUDED.length`,
          [teeUuid, h, len]
        );
        stats.teeLengths.insert++;
      }
    }
    if (!DRY_RUN) progress("tees.csv", totalTees, totalTees);
    console.log(`\n✓ tees: ${stats.tees.insert}, tee_hole_lengths: ${stats.teeLengths.insert}`);
    }

    // --- 6. golf_hole_pois (coordinates.csv) ---
    // Streaming: no full-file load. Batch inserts (1000 rows). Progress every 10k.
    const coordsSource = isAbsoluteUrl(coordsPath) ? "URL" : "local file";
    console.log(`\nStarting POI ingestion from coordinates.csv (source: ${coordsSource})`);
    console.log(`[POI] Resolved path: ${coordsPath}`);
    if (!isAbsoluteUrl(coordsPath) && !fs.existsSync(coordsPath)) {
      throw new Error(`coordinates.csv not found at: ${coordsPath}`);
    }
    const parser = await createCoordinatesStream(coordsPath);
    let rowNum = 1;
    let batch = [];
    const POI_INSERT = `INSERT INTO golf_hole_pois (course_id, hole_number, poi_type, location_label, fairway_side, lat, lon, location, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography, now())
         ON CONFLICT (course_id, hole_number, lat, lon) DO UPDATE SET
           poi_type = EXCLUDED.poi_type, location_label = EXCLUDED.location_label,
           fairway_side = EXCLUDED.fairway_side, location = EXCLUDED.location, updated_at = now()`;

    const flushBatch = async (toInsert) => {
      if (toInsert.length === 0) return;
      if (DRY_RUN) {
        stats.pois.insert += toInsert.length;
        return;
      }
      const client = await pool.connect();
      try {
        for (const row of toInsert) {
          try {
            await client.query(POI_INSERT, row);
            stats.pois.insert++;
          } catch (e) {
            logError(rowNum, "coordinates.csv", e.message, row);
            stats.pois.skip++;
          }
        }
      } finally {
        client.release();
      }
    };

    let firstRowLogged = false;
    let courseNotFoundSkips = 0;
    for await (const r of parser) {
      rowNum++;
      if (!firstRowLogged && r && typeof r === "object") {
        const keys = Object.keys(r).sort();
        console.log(`[POI] First row headers: ${keys.join(", ")}`);
        firstRowLogged = true;
      }
      const courseId = trim(r.CourseID);
      const courseUuid = idMaps.courseIdToUuid[courseId];
      if (!courseUuid) {
        courseNotFoundSkips++;
        stats.pois.skip++;
        if (courseNotFoundSkips <= 3) {
          console.log(`[POI] Row ${rowNum}: course not found for CourseID=${courseId || "(empty)"}`);
        }
        continue;
      }
      const holeNum = parseInt(r.Hole, 10);
      if (!validHoleNum(holeNum)) {
        logError(rowNum, "coordinates.csv", "invalid hole number", r);
        stats.pois.skip++;
        continue;
      }
      const lat = parseFloat(r.Latitude);
      const lon = parseFloat(r.Longitude);
      if (!validLat(lat) || !validLon(lon)) {
        logError(rowNum, "coordinates.csv", "invalid lat/lon", r);
        stats.pois.skip++;
        continue;
      }
      const poiType = trim(r.POI) || "Unknown";
      const locationLabel = trim(r.Location) || null;
      const fairwaySide = trim(r.SideOfFairway) || null;

      batch.push([courseUuid, holeNum, poiType, locationLabel, fairwaySide, lat, lon]);
      if (batch.length >= POI_BATCH_SIZE) {
        await flushBatch(batch);
        batch = [];
      }
      if (rowNum % POI_PROGRESS_INTERVAL === 0) {
        console.log(`[POI] Processed ${rowNum.toLocaleString()} rows, inserted ${stats.pois.insert.toLocaleString()} POIs`);
      }
    }
    await flushBatch(batch);
    console.log(`\n[POI] Ingestion complete. Inserted ${stats.pois.insert.toLocaleString()} POIs (processed ${rowNum.toLocaleString()} rows)`);
    if (courseNotFoundSkips > 0) {
      console.log(`[POI] Warning: ${courseNotFoundSkips.toLocaleString()} rows skipped (CourseID not in golf_courses)`);
    }

    // --- 7. Precompute course center from green POIs ---
    if (!DRY_RUN && pool) {
      console.log("\nPrecomputing course centers from green POIs...");
      const centerRes = await pool.query(`
        WITH green_centers AS (
          SELECT course_id, AVG(lat) AS avg_lat, AVG(lon) AS avg_lon
          FROM golf_hole_pois
          WHERE LOWER(poi_type) = 'green' AND location_label = 'C'
          GROUP BY course_id
        )
        UPDATE golf_courses gc
        SET lat = gc2.avg_lat, lon = gc2.avg_lon,
            location = ST_SetSRID(ST_MakePoint(gc2.avg_lon, gc2.avg_lat), 4326)::geography,
            updated_at = now()
        FROM green_centers gc2
        WHERE gc.id = gc2.course_id
      `);
      const fallbackRes = await pool.query(`
        UPDATE golf_courses gc
        SET lat = c.lat, lon = c.lon,
            location = CASE WHEN c.lat IS NOT NULL AND c.lon IS NOT NULL
              THEN ST_SetSRID(ST_MakePoint(c.lon, c.lat), 4326)::geography ELSE NULL END,
            updated_at = now()
        FROM golf_clubs c
        WHERE gc.club_id = c.id AND gc.lat IS NULL
      `);
      console.log("✓ Course centers updated (green centroid or club fallback)");
    } else if (DRY_RUN) {
      console.log("\n[DRY RUN] Would precompute course centers from green POIs");
    }
  } finally {
    if (closePool && pool) await pool.end();
  }

  // --- Summary ---
  console.log("\n" + "=".repeat(50));
  if (DRY_RUN) {
    console.log("[DRY RUN] Would insert/update:");
    console.log(`  clubs: ${stats.clubs.insert}`);
    console.log(`  courses: ${stats.courses.insert}`);
    console.log(`  holes: ${stats.holes.insert}`);
    console.log(`  tees: ${stats.tees.insert}`);
    console.log(`  tee_hole_lengths: ${stats.teeLengths.insert}`);
    console.log(`  pois: ${stats.pois.insert}`);
    console.log(`  skipped: ${stats.clubs.skip + stats.courses.skip + stats.pois.skip}`);
    console.log("[DRY RUN] No database changes made.");
  } else {
    console.log("Ingestion complete:");
    console.log(`  clubs: ${stats.clubs.insert}`);
    console.log(`  courses: ${stats.courses.insert}`);
    console.log(`  holes: ${stats.holes.insert}`);
    console.log(`  tees: ${stats.tees.insert}`);
    console.log(`  tee_hole_lengths: ${stats.teeLengths.insert}`);
    console.log(`  pois: ${stats.pois.insert}`);
  }
  if (errorLog.length > 0) {
    fs.writeFileSync(errorLogPath, errorLog.map((e) => JSON.stringify(e)).join("\n"), "utf8");
    console.log(`\nErrors logged to ${errorLogPath} (${errorLog.length} entries)`);
  }

  return stats;
}

// CLI entry point
async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
  const force = process.argv.includes("--force");
  const dataDir = process.argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1];

  require("dotenv").config();
  const DATABASE_URL = process.env.DATABASE_URL;

  let pool = null;
  if (!dryRun && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  } else if (!dryRun) {
    console.error("DATABASE_URL is required. Use --dry-run to validate without DB.");
    process.exit(1);
  }

  try {
    // 1. Run migrations (ensures tables exist)
    if (pool) {
      console.log("[ingest] Running migrations...");
      const migrations = await runMigrations(pool);
      if (migrations.applied?.length > 0) {
        console.log(`[ingest] Applied: ${migrations.applied.join(", ")}`);
      }
      if (migrations.skipped?.length > 0) {
        console.log(`[ingest] Skipped (already applied): ${migrations.skipped.length}`);
      }
      console.log("[ingest] Migrations complete.\n");
    }

    // 2. Run ingestion pipeline
    const result = await runIngestion(pool, {
      dataDir,
      dryRun,
      force,
      closePool: true
    });
    if (result?.skipped) {
      console.log(`[ingest] Skipped: ${result.reason} (${result.courseCount} courses)`);
    }
  } catch (err) {
    console.error("Ingestion failed:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runIngestion };
