const express = require("express");
const rateLimit = require("express-rate-limit");

const upload = require("../utils/upload");
const controller = require("../controllers/interviewforge.api.controller");

const {
  optionalBearerAuth,
  requireBearerAuth,
} = require("../middlewares/bearer-auth.middleware");

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               Rate Limit Utils                             */
/* -------------------------------------------------------------------------- */

const createRateLimiter = ({ windowMs, limit }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },

    keyGenerator: (req) => {
      // Prefer authenticated user ID (excluding development/anonymous dummy auth)
      if (req.auth?.userId && req.auth?.tokenType !== "development") {
        return `user:${req.auth.userId}`;
      }

      // Fallback to IP
      return `ip:${req.ip}`;
    },

    handler: (_req, res) => {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again later.",
      });
    },
  });

/* -------------------------------------------------------------------------- */
/*                               Rate Limiters                                */
/* -------------------------------------------------------------------------- */

const generateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: (req) =>
    req.auth?.scopes?.includes("premium") ? 100 : 5,
});

const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
});

const evaluateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
});

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resume
 */
router.post(
  "/upload",
  optionalBearerAuth,
  upload.single("file"),
  controller.uploadResume
);

router.post(
  "/parse",
  optionalBearerAuth,
  controller.parseResume
);

/**
 * Question Generation
 */
router.post(
  "/generate",
  optionalBearerAuth,
  generateLimiter,
  controller.generateQuestions
);

router.post(
  "/generate-async",
  optionalBearerAuth,
  generateLimiter,
  controller.generateQuestionsAsync
);

router.get(
  "/jobs/:jobId",
  optionalBearerAuth,
  controller.getJobStatus
);

router.get(
  "/questions/:sessionId",
  optionalBearerAuth,
  controller.getQuestions
);

/**
 * Mock Interviews
 */
router.post(
  "/mock/start",
  optionalBearerAuth,
  controller.startMock
);

router.post(
  "/mock/:mockId/answer",
  optionalBearerAuth,
  controller.answerMock
);

/**
 * Evaluation & AI Chat
 */
router.post(
  "/evaluate",
  optionalBearerAuth,
  evaluateLimiter,
  controller.evaluateSingle
);

router.post(
  "/chat",
  optionalBearerAuth,
  chatLimiter,
  controller.chat
);

/**
 * User Preferences
 */
router.get(
  "/preferences",
  optionalBearerAuth,
  controller.getPreferences
);

router.post(
  "/preferences",
  optionalBearerAuth,
  controller.savePreferences
);

/**
 * Insights
 */
router
  .route("/insights")
  .get(optionalBearerAuth, controller.insights)
  .post(optionalBearerAuth, controller.insights);

/**
 * Bookmarks
 */
router.post(
  "/questions/:sessionId/bookmark",
  requireBearerAuth,
  controller.bookmarkQuestion
);

/**
 * Sessions
 */
router.get(
  "/sessions",
  requireBearerAuth,
  controller.listSessions
);

router.delete(
  "/session/:sessionId",
  requireBearerAuth,
  controller.deleteSession
);

module.exports = router;