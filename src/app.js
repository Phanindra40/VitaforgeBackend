const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const { env } = require("./config/env");
const { connectDatabase } = require("./config/database");
const apiRoutes = require("./routes");
const { notFoundHandler, errorHandler } = require("./middlewares/error.middleware");

const app = express();

const AUTH_COOKIE_NAME = "vitaforge_test_ui_auth";
const isProductionLike = env.NODE_ENV === "production" || env.IS_RENDER;

if (isProductionLike) {
  app.set("trust proxy", 1);
}

function buildAuthCookie(value, maxAgeSeconds) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }

  if (isProductionLike) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function parseCookies(req) {
  const rawCookies = req.headers.cookie || "";

  return rawCookies.split(";").reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) return acc;

    const key = decodeURIComponent(trimmed.slice(0, separatorIndex));
    const value = decodeURIComponent(trimmed.slice(separatorIndex + 1));
    acc[key] = value;
    return acc;
  }, {});
}

function isTestUiAuthenticated(req) {
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] === "1";
}

app.use(cors({
  origin: (origin, callback) => {
    if (env.CORS_ORIGIN === "*") {
      return callback(null, true);
    }

    if (!origin) {
      return callback(null, true);
    }

    const isAllowed = Array.isArray(env.CORS_ORIGIN) && env.CORS_ORIGIN.includes(origin);
    return callback(null, isAllowed);
  },
  credentials: true,
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get("/", (req, res) => {
  if (isTestUiAuthenticated(req)) {
    return res.redirect("/test-ui");
  }

  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (isTestUiAuthenticated(req)) {
    return res.redirect("/test-ui");
  }

  return res.sendFile(path.join(process.cwd(), "public", "login.html"));
});

app.post("/login", (req, res) => {
  const configuredUsername = String(env.TEST_UI_LOGIN_USERNAME || "").trim().toLowerCase();
  const configuredPassword = String(env.TEST_UI_LOGIN_PASSWORD || "");

  if (!configuredUsername || !configuredPassword) {
    return res.status(503).json({
      success: false,
      message: "Login is not configured. Set TEST_UI_LOGIN_USERNAME and TEST_UI_LOGIN_PASSWORD.",
    });
  }

  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const isValidLogin =
    username === configuredUsername && password === configuredPassword;

  if (!isValidLogin) {
    return res.status(401).json({
      success: false,
      message: "Invalid username or password",
    });
  }

  res.setHeader("Set-Cookie", buildAuthCookie("1", 60 * 60 * 24 * 7));

  return res.json({
    success: true,
    redirectTo: "/test-ui",
  });
});

app.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", buildAuthCookie("", 0));

  return res.json({ success: true, redirectTo: "/login" });
});

app.use((req, res, next) => {
  if (req.path !== "/test-ui" && req.path !== "/test-ui.html") {
    return next();
  }

  if (isTestUiAuthenticated(req)) {
    return next();
  }

  return res.redirect("/login");
});

app.use(express.static(path.join(process.cwd(), "public")));
app.get("/test-ui", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "test-ui.html"));
});

app.use("/api", apiRoutes);
app.use("/api/v1", apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  await connectDatabase();

  const loginConfigured =
    Boolean(String(env.TEST_UI_LOGIN_USERNAME || "").trim()) &&
    Boolean(String(env.TEST_UI_LOGIN_PASSWORD || ""));

  app.listen(env.PORT, () => {
    console.log(`Server listening on port ${env.PORT}`);
    console.log(`Test UI login configured: ${loginConfigured ? "YES" : "NO"}`);
  });
}

module.exports = { app, startServer };
