const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.POSTGRES_USER || process.env.PGUSER || "postgres",
  host: process.env.POSTGRES_HOST || process.env.PGHOST || "localhost",
  database: process.env.POSTGRES_DB || process.env.PGDATABASE || "ai_drainos",
  password: process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "admin123",
  port: Number(process.env.POSTGRES_PORT || process.env.PGPORT) || 5432,
});

pool.query("SELECT 1")
  .then(() => {
    console.log("✅ PostgreSQL Connected Successfully");
  })
  .catch((error) => {
    console.log("❌ PostgreSQL Connection Error:", error.message);
  });

module.exports = pool;
