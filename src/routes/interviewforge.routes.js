const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const upload = require("../utils/upload");
const controller = require("../controllers/interviewforge.api.controller");
const { optionalBearerAuth, requireBearerAuth } = require("../middlewares/bearer-auth.middleware");

const router = express.Router();

const keyGenerator = (req) => {
	if (req.auth?.userId) return req.auth.userId;
	return ipKeyGenerator(req.ip);
};

const generateLimiter = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: (req) => (req.auth?.scopes?.includes("premium") ? 100 : 5),
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator,
});

const chatLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 60,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator,
});

const evaluateLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 60,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator,
});

router.post("/upload", optionalBearerAuth, upload.single("file"), controller.uploadResume);
router.post("/parse", optionalBearerAuth, controller.parseResume);
router.post("/generate", optionalBearerAuth, generateLimiter, controller.generateQuestions);
router.post("/generate-async", optionalBearerAuth, generateLimiter, controller.generateQuestionsAsync);
router.get("/jobs/:jobId", requireBearerAuth, controller.getJobStatus);
router.get("/questions/:sessionId", requireBearerAuth, controller.getQuestions);
router.post("/mock/start", requireBearerAuth, controller.startMock);
router.post("/mock/:mockId/answer", requireBearerAuth, controller.answerMock);
router.post("/evaluate", requireBearerAuth, evaluateLimiter, controller.evaluateSingle);
router.post("/chat", requireBearerAuth, chatLimiter, controller.chat);
router.get("/preferences", requireBearerAuth, controller.getPreferences);
router.post("/preferences", requireBearerAuth, controller.savePreferences);
router.get("/insights", optionalBearerAuth, controller.insights);
router.post("/insights", optionalBearerAuth, controller.insights);
router.post("/questions/:sessionId/bookmark", requireBearerAuth, controller.bookmarkQuestion);
router.get("/sessions", requireBearerAuth, controller.listSessions);
router.delete("/session/:sessionId", requireBearerAuth, controller.deleteSession);

module.exports = router;