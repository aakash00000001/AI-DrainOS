const { Pool } = require("pg");
const config = require("./env");
const logger = require("./logger");

const pool = new Pool({
  user: config.db.user,
  host: config.db.host,
  database: config.db.database,
  password: config.db.password,
  port: config.db.port,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  max: config.db.max
});

pool.query("SELECT 1")
  .then(() => {
    logger.info("PostgreSQL connected", { database: config.db.database, host: config.db.host });
  })
  .catch((error) => {
    logger.error("PostgreSQL connection error", { message: error.message });
  });

module.exports = pool;