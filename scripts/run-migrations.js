#!/usr/bin/env node
"use strict";

/**
 * Run golf schema migrations.
 * Usage: node scripts/run-migrations.js
 * Requires DATABASE_URL in env.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

require("dotenv").config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = path.join(__dirname, "../migrations");
const migrationFile = path.join(migrationsDir, "001_golf_schema.sql");

if (!fs.existsSync(migrationFile)) {
  console.error("Migration file not found:", migrationFile);
  process.exit(1);
}

const sql = fs.readFileSync(migrationFile, "utf8");

async function run() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });
  try {
    await pool.query(sql);
    console.log("✓ Migration 001_golf_schema.sql applied successfully");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
