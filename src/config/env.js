require("dotenv").config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCorsOrigin(value) {
  if (!value || value.trim() === "*") {
    return "*";
  }

  const origins = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return origins.length ? origins : "*";
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 5000),
  CORS_ORIGIN: parseCorsOrigin(process.env.CORS_ORIGIN || "*"),
  CACHE_ENABLED: toBoolean(process.env.CACHE_ENABLED, true),
  CACHE_DEFAULT_TTL_SECONDS: toNumber(process.env.CACHE_DEFAULT_TTL_SECONDS, 300),
  CACHE_AI_TTL_SECONDS: toNumber(process.env.CACHE_AI_TTL_SECONDS, 900),
  CACHE_RESUME_TTL_SECONDS: toNumber(process.env.CACHE_RESUME_TTL_SECONDS, 120),
  REDIS_URL: process.env.REDIS_URL || "",
  REDIS_PREFIX: process.env.REDIS_PREFIX || "vitaforge",
  REDIS_CONNECT_TIMEOUT_MS: toNumber(process.env.REDIS_CONNECT_TIMEOUT_MS, 5000),
  MONGODB_URI: process.env.MONGODB_URI || "",
  HF_API_KEY: process.env.HF_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  GROQ_MAX_TOKENS: toNumber(process.env.GROQ_MAX_TOKENS, 1024),
  GROQ_TIMEOUT_MS: toNumber(process.env.GROQ_TIMEOUT_MS, 10000),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  GEMINI_TIMEOUT_MS: toNumber(process.env.GEMINI_TIMEOUT_MS, 15000),
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
