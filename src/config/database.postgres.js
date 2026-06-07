const { Pool } = require("pg");
const { env } = require("./env");
const { logger } = require("../utils/logger");

const pool = new Pool({
  connectionString: env.PORTFOLIO_DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function initPostgres() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id VARCHAR(50) PRIMARY KEY,
        template_slug VARCHAR(50) NOT NULL,
        portfolio_data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info("PostgreSQL database initialized successfully - 'portfolios' table is ready.");
  } catch (err) {
    logger.error("PostgreSQL database initialization failed:", err);
  }
}

module.exports = {
  pool,
  initPostgres,
};
