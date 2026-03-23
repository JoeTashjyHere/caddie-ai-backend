#!/usr/bin/env node
"use strict";

/**
 * Extract and validate course data from ZIP for production ingestion.
 * Usage: node scripts/extract-course-data.js <path-to-zip>
 *
 * Example: node scripts/extract-course-data.js /mnt/data/coursedb_america.zip
 *
 * Extracts required CSVs to backend/data/ for commit and GitHub raw URL ingestion.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REQUIRED_FILES = ["clubs.csv", "courses.csv", "tees.csv", "coordinates.csv"];

const EXPECTED_HEADERS = {
  "clubs.csv": ["ClubID", "ClubName"],
  "courses.csv": ["CourseID", "ClubID", "CourseName", "NumHoles"],
  "tees.csv": ["CourseID", "TeeID", "TeeName"],
  "coordinates.csv": ["CourseID", "Hole", "Latitude", "Longitude", "POI"]
};

function extractZip(zipPath, outDir) {
  const tmpDir = path.join(outDir, ".extract_tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    execSync(`unzip -o -j "${zipPath}" -d "${tmpDir}"`, { stdio: "pipe" });
    const files = fs.readdirSync(tmpDir);
    const requiredLower = REQUIRED_FILES.map((f) => f.toLowerCase());
    for (const f of files) {
      const base = f.toLowerCase();
      if (requiredLower.includes(base)) {
        const canonical = REQUIRED_FILES[requiredLower.indexOf(base)];
        fs.renameSync(path.join(tmpDir, f), path.join(outDir, canonical));
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  }
}

function validateCsv(filePath, expectedHeaders) {
  const content = fs.readFileSync(filePath, "utf8");
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new Error(`${path.basename(filePath)}: file is empty`);

  const firstLine = content.split("\n")[0];
  const headers = firstLine.split(",").map((h) => h.trim().replace(/^"/, "").replace(/"$/, ""));
  for (const req of expectedHeaders) {
    if (!headers.includes(req)) {
      throw new Error(`${path.basename(filePath)}: missing required header '${req}' (have: ${headers.slice(0, 5).join(", ")}...)`);
    }
  }
  return { rows: content.split("\n").length - 1, headers };
}

async function main() {
  const zipPath = process.argv[2] || process.env.ZIP_PATH || "/mnt/data/coursedb_america.zip";

  if (!fs.existsSync(zipPath)) {
    console.error(`ZIP not found: ${zipPath}`);
    console.error("Usage: node scripts/extract-course-data.js <path-to-zip>");
    process.exit(1);
  }

  const dataDir = path.resolve(__dirname, "../data");
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Extracting ${zipPath} -> ${dataDir}`);

  try {
    extractZip(zipPath, dataDir);
    const extracted = REQUIRED_FILES.filter((f) => fs.existsSync(path.join(dataDir, f))).length;
    if (extracted === 0) {
      throw new Error("No required CSV files found in ZIP (expected clubs.csv, courses.csv, tees.csv, coordinates.csv)");
    }

    console.log(`Extracted ${extracted} files`);
    const results = {};
    for (const f of REQUIRED_FILES) {
      const fp = path.join(dataDir, f);
      if (!fs.existsSync(fp)) {
        throw new Error(`Missing required file: ${f}`);
      }
      results[f] = validateCsv(fp, EXPECTED_HEADERS[f]);
      console.log(`  ✓ ${f}: ${results[f].rows} rows`);
    }

    console.log("\n✅ Validation passed");
    console.log(`\nNext steps:`);
    console.log(`  cd backend && git add data/ && git commit -m "Add production course ingestion data" && git push origin main`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
