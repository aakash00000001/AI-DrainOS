// ============================================================
// AI-DrainOS Database Setup
// Usage (from server/):
//   npm run db:setup           -> create tables + seed data
//   npm run db:setup:fresh     -> drop + recreate + seed
//   npm run db:setup:schema    -> tables only, no seed
// ============================================================

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
const seedPath = path.join(__dirname, "..", "..", "database", "seed.sql");

async function run() {
  const skipSeed = process.argv.includes("--schema-only");

  console.log(`🛢️  Target database: ${pool.options.database}`);

  // schema.sql always drops + recreates, so it is idempotent
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
  console.log("✅ Schema applied");

  if (skipSeed) {
    console.log("⏭️  Skipping seed data (--schema-only)");
    return;
  }

  let seed = fs.readFileSync(seedPath, "utf8");

  seed = seed
    .replaceAll("__ADMIN_HASH__", await bcrypt.hash("admin123", 10))
    .replaceAll("__OPERATOR_HASH__", await bcrypt.hash("operator123", 10));

  await pool.query(seed);
  console.log("✅ Seed data inserted");
  console.log("");
  console.log("👤 Admin:    admin@aidrain.com    / admin123");
  console.log("👤 Operator: operator@aidrain.com / operator123");
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error("❌ Setup failed:", err.message);
    pool.end();
    process.exit(1);
  });
