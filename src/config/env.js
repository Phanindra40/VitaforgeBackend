require("dotenv").config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 5000),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  MONGODB_URI: process.env.MONGODB_URI || "",
  HF_API_KEY: process.env.HF_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  GROQ_MAX_TOKENS: toNumber(process.env.GROQ_MAX_TOKENS, 1024),
  GROQ_TIMEOUT_MS: toNumber(process.env.GROQ_TIMEOUT_MS, 10000),
  TEST_UI_LOGIN_USERNAME:
    process.env.TEST_UI_LOGIN_USERNAME ||
    process.env.TEST_UI_USERNAME ||
    process.env.LOGIN_USERNAME ||
    "",
  TEST_UI_LOGIN_PASSWORD:
    process.env.TEST_UI_LOGIN_PASSWORD ||
    process.env.TEST_UI_PASSWORD ||
    process.env.LOGIN_PASSWORD ||
    "",
  IS_RENDER: Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL),
};

module.exports = { env };
