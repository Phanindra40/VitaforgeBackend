const express = require("express");
const resumeRoutes = require("./resume.routes");
const aiRoutes = require("./groq.routes");
const contactRoutes = require("./contact.routes");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

router.use("/resumes", resumeRoutes);
router.use("/groq", aiRoutes);
router.use("/claude", aiRoutes);
router.use("/gemini", aiRoutes);
router.use("/contact", contactRoutes);

module.exports = router;
