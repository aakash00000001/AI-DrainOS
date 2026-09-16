// ============================================================
// Test helpers - provisions a dedicated test database
// and returns the express app for supertest
// ============================================================

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");

const TEST_DB = "ai_drainos_test";

const DB_CONFIG = {
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  password: process.env.PGPASSWORD || "admin123",
  port: Number(process.env.PGPORT) || 5432
};

async function ensureTestDatabase() {
  const client = new Client({ ...DB_CONFIG, database: "postgres" });
  await client.connect();

  const exists = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [TEST_DB]
  );

  if (exists.rows.length === 0) {
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  }

  await client.end();
}

async function resetTestDatabase(pool) {
  const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
  const seedPath = path.join(__dirname, "..", "..", "database", "seed.sql");

  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);

  let seed = fs.readFileSync(seedPath, "utf8");
  seed = seed
    .replaceAll("__ADMIN_HASH__", await bcrypt.hash("admin123", 10))
    .replaceAll("__OPERATOR_HASH__", await bcrypt.hash("operator123", 10));

  await pool.query(seed);
}

// Returns { app, pool }
async function setup() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_key";
  process.env.PGDATABASE = TEST_DB;

  await ensureTestDatabase();

  const pool = require("../config/db");
  await resetTestDatabase(pool);

  const app = require("../app");

  return { app, pool };
}

module.exports = { setup, DB_CONFIG, TEST_DB };
