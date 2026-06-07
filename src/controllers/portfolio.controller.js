const crypto = require("crypto");
const { pool } = require("../config/database.postgres");
const { logger } = require("../utils/logger");

async function savePortfolio(req, res, next) {
  try {
    const { templateSlug, portfolioData } = req.body;

    if (!templateSlug || !portfolioData) {
      return res.status(400).json({ error: "Missing templateSlug or portfolioData" });
    }

    // Generate a unique 12-character hex ID (e.g. 5e3f42b9d12a)
    const id = crypto.randomBytes(6).toString("hex");

    const query = "INSERT INTO portfolios (id, template_slug, portfolio_data) VALUES ($1, $2, $3) RETURNING *";
    const values = [id, templateSlug.toLowerCase(), portfolioData];

    await pool.query(query, values);

    logger.info(`Portfolio saved successfully with ID: ${id}`);
    res.status(201).json({ id, templateSlug: templateSlug.toLowerCase() });
  } catch (err) {
    logger.error("Error saving portfolio:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function getPortfolio(req, res, next) {
  try {
    const { id } = req.params;

    const query = "SELECT * FROM portfolios WHERE id = $1";
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Portfolio not found" });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      templateSlug: row.template_slug,
      portfolioData: row.portfolio_data,
    });
  } catch (err) {
    logger.error("Error fetching portfolio:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = {
  savePortfolio,
  getPortfolio,
};
