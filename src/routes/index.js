const express = require("express");
const resumeRoutes = require("./resume.routes");
const aiRoutes = require("./groq.routes");
const geminiRoutes = require("./gemini.routes");
const contactRoutes = require("./contact.routes");
const interviewForgeRoutes = require("./interviewforge.routes");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

router.use("/resumes", resumeRoutes);
// Backwards-compatible alias: some clients (test UI) use singular `/resume`
router.use("/resume", resumeRoutes);
router.use("/groq", aiRoutes);
router.use("/claude", aiRoutes);
router.use("/gemini", geminiRoutes);
router.use("/contact", contactRoutes);
router.use("/interviewforge", interviewForgeRoutes);

module.exports = router;
