const mongoose = require("mongoose");
const { env } = require("./env");
const { logger } = require("../utils/logger");

async function connectDatabase() {
  if (!env.MONGODB_URI) {
    logger.warn("MONGODB_URI not set. Running without database connection.");
    return;
  }

  try {
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    logger.info("MongoDB connected");
  } catch (error) {
    logger.error("MongoDB connection failed", error);
  }
}

module.exports = { connectDatabase };
