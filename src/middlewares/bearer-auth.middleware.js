const crypto = require("crypto");

const { env } = require("../config/env");

function unauthorized(message, details) {
  const error = new Error(message);
  error.status = 401;
  error.code = "UNAUTHORIZED";
  if (details) error.details = details;
  return error;
}

function extractBearerToken(req) {
  const authorization = String(req.headers.authorization || "").trim();
  if (!authorization.startsWith("Bearer ")) return "";
  return authorization.slice(7).trim();
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function parseScopes(scopeClaim) {
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function verifyJwtHs256(token, secret) {
  const parts = String(token).split(".");

  if (parts.length !== 3) {
    throw unauthorized("Invalid bearer token format");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));

  if (header.alg !== "HS256") {
    throw unauthorized("Unsupported JWT algorithm", { alg: header.alg });
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");

  if (expectedSignature !== signaturePart) {
    throw unauthorized("Invalid bearer token signature");
  }

  return JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
}

function attachDevelopmentAuth(req) {
  req.auth = {
    userId: "development",
    sub: "development",
    scopes: [],
    premium: false,
    tokenType: "development",
  };
}

function buildAuthFromToken(token) {
  const jwtSecret = String(env.INTERVIEWFORGE_JWT_SECRET || "").trim();
  const legacyToken = String(env.INTERVIEWFORGE_API_TOKEN || "").trim();

  if (jwtSecret && token.includes(".")) {
    const claims = verifyJwtHs256(token, jwtSecret);
    const scopes = parseScopes(claims.scope || claims.scp || claims.scopes);

    return {
      userId: claims.sub || null,
      sub: claims.sub || null,
      scopes,
      premium: scopes.includes("premium"),
      claims,
      tokenType: "jwt",
    };
  }

  if (legacyToken) {
    if (token !== legacyToken) {
      throw unauthorized("Invalid bearer token");
    }

    return {
      userId: "development",
      sub: "development",
      scopes: [],
      premium: false,
      tokenType: "legacy",
    };
  }

  return {
    userId: "development",
    sub: "development",
    scopes: [],
    premium: false,
    tokenType: "development",
  };
}

function optionalBearerAuth(req, _res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    attachDevelopmentAuth(req);
    return next();
  }

  try {
    req.auth = buildAuthFromToken(token);
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireBearerAuth(req, _res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    const jwtSecret = String(env.INTERVIEWFORGE_JWT_SECRET || "").trim();
    const legacyToken = String(env.INTERVIEWFORGE_API_TOKEN || "").trim();

    if (!jwtSecret && !legacyToken) {
      attachDevelopmentAuth(req);
      return next();
    }

    return next(unauthorized("Bearer token is required"));
  }

  try {
    req.auth = buildAuthFromToken(token);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { optionalBearerAuth, requireBearerAuth };