// ============================================================
// AI-DrainOS Safe Database Initializer (Docker / production)
// Usage (from server/):
//   node scripts/dbInit.js
//
// Behavior:
//   - Applies the schema ONLY when the database is fresh
//     (no `users` table exists yet).
//   - Inserts seed data ONLY when the `users` table is empty.
//   - NEVER drops or overwrites existing data.
// This makes container restarts safe on a persisted volume.
// ============================================================

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
const seedPath = path.join(__dirname, "..", "..", "database", "seed.sql");

async function run() {
  console.log(`🛢️  Target database: ${pool.options.database}`);

  // 1. Create schema only on a fresh database
  const tableCheck = await pool.query(
    "SELECT to_regclass('public.users') AS table_name"
  );

  if (tableCheck.rows[0].table_name === null) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    await pool.query(schema);
    console.log("✅ Schema created (fresh database)");
  } else {
    console.log("⏭️  Schema already present - skipping schema creation");
  }

  // 1b. Apply idempotent migrations on existing databases.
  // Every migration file uses CREATE ... IF NOT EXISTS so it can
  // never destroy data and container restarts stay safe on a
  // persisted volume.
  const migrationsDir = path.join(__dirname, "..", "..", "database", "migrations");

  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await pool.query(sql);
      console.log(`✅ Migration applied: ${file}`);
    }
  }

  // 2. Seed only when there are no users yet
  const userCount = await pool.query("SELECT COUNT(*) AS count FROM users");

  if (Number(userCount.rows[0].count) === 0) {
    let seed = fs.readFileSync(seedPath, "utf8");

    seed = seed
      .replaceAll("__ADMIN_HASH__", await bcrypt.hash("admin123", 10))
      .replaceAll("__OPERATOR_HASH__", await bcrypt.hash("operator123", 10));

    await pool.query(seed);
    console.log("✅ Seed data inserted");
    console.log("");
    console.log("👤 Admin:    admin@aidrain.com    / admin123");
    console.log("👤 Operator: operator@aidrain.com / operator123");
  } else {
    console.log("⏭️  Users already exist - skipping seed");
  }
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error("❌ Database init failed:", err.message);
    pool.end();
    process.exit(1);
  });
