const mongoose = require("mongoose");
const { env } = require("./env");

async function connectDatabase() {
  if (!env.MONGODB_URI) {
    console.warn("MONGODB_URI not set. Running without database connection.");
    return;
  }

  try {
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
  }
}

module.exports = { connectDatabase };
