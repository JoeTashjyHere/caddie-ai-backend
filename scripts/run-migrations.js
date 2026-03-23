#!/usr/bin/env node
"use strict";

/**
 * Idempotent migration runner.
 * - Tracks applied migrations in schema_migrations table
 * - Skips already-applied migrations
 * - Runs on server startup (via lib/init.js) or standalone: node scripts/run-migrations.js
 *
 * Requires: DATABASE_URL
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

require("dotenv").config();

const DATABASE_URL = process.env.DATABASE_URL;
const migrationsDir = path.join(__dirname, "../migrations");

function getMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Run all pending migrations. Idempotent.
 * @param {import("pg").Pool} pool - Database pool
 * @returns {{ applied: string[], skipped: string[] }}
 */
async function runMigrations(pool) {
  const files = getMigrationFiles();
  const result = { applied: [], skipped: [], errors: [] };

  // Ensure schema_migrations exists (000 creates it; run 000 first if missing)
  const bootstrapSql = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  await pool.query(bootstrapSql);

  for (const file of files) {
    const name = file;
    const filePath = path.join(migrationsDir, file);

    if (!fs.existsSync(filePath)) {
      result.errors.push({ file: name, error: "File not found" });
      continue;
    }

    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [name]
    );

    if (applied.rows.length > 0) {
      result.skipped.push(name);
      continue;
    }

    const sql = fs.readFileSync(filePath, "utf8");
    try {
      await pool.query(sql);
      await pool.query(
        "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [name]
      );
      result.applied.push(name);
    } catch (err) {
      result.errors.push({ file: name, error: err.message });
      throw new Error(`Migration ${name} failed: ${err.message}`);
    }
  }

  return result;
}

async function main() {
  if (!DATABASE_URL) {
    console.error("[migrate] DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  try {
    const result = await runMigrations(pool);
    if (result.applied.length > 0) {
      console.log(`[migrate] Applied: ${result.applied.join(", ")}`);
    }
    if (result.skipped.length > 0) {
      console.log(`[migrate] Skipped (already applied): ${result.skipped.join(", ")}`);
    }
    if (result.errors.length > 0) {
      console.error("[migrate] Errors:", result.errors);
      process.exit(1);
    }
  } catch (err) {
    console.error("[migrate] Failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Standalone: node run-migrations.js
if (require.main === module) {
  main();
}

module.exports = { runMigrations };
