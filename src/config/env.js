require("dotenv").config();

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 8000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  MONGODB_URI: process.env.MONGODB_URI || "",
  HF_API_KEY: process.env.HF_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  GROQ_MAX_TOKENS: Number(process.env.GROQ_MAX_TOKENS || 1024),
  GROQ_TIMEOUT_MS: Number(process.env.GROQ_TIMEOUT_MS || 10000),
  TEST_UI_LOGIN_USERNAME: process.env.TEST_UI_LOGIN_USERNAME || "",
  TEST_UI_LOGIN_PASSWORD: process.env.TEST_UI_LOGIN_PASSWORD || "",
};

module.exports = { env };
