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

const OPENROUTER_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "google/gemma-3-27b-it:free",
  "openrouter/free"
];

function toFreeOpenRouterModel(value, fallback) {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (OPENROUTER_FREE_MODELS.includes(trimmed)) {
    return trimmed;
  }
  if (trimmed === "openrouter/free" || trimmed.endsWith(":free")) {
    return trimmed;
  }
  if (!trimmed.includes(":")) {
    return `${trimmed}:free`;
  }
  return fallback;
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
  GEMINI_TIMEOUT_MS: toNumber(process.env.GEMINI_TIMEOUT_MS, 60000),
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  OPENROUTER_MODEL: toFreeOpenRouterModel(process.env.OPENROUTER_MODEL, "meta-llama/llama-3.3-70b-instruct:free"),
  OPENROUTER_OCR_MODEL: toFreeOpenRouterModel(process.env.OPENROUTER_OCR_MODEL, "nvidia/nemotron-nano-12b-v2-vl:free"),
  OPENROUTER_FREE_MODELS,
  INTERVIEWFORGE_API_TOKEN: process.env.INTERVIEWFORGE_API_TOKEN || "",
  INTERVIEWFORGE_JWT_SECRET: process.env.INTERVIEWFORGE_JWT_SECRET || "",
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
  PORTFOLIO_DATABASE_URL:
    process.env.PORTFOLIO_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_Px7KadHrh9pE@ep-blue-dust-aqq4q7ny-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
};

module.exports = { env };
