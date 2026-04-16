const express = require("express");

const upload = require("../utils/gemini.upload");
const controller = require("../controllers/gemini.controller");

const router = express.Router();

router.post("/ats-analyze", controller.atsAnalyze);
router.post(
	"/ocr-extract",
	upload.fields([
		{ name: "file", maxCount: 1 },
		{ name: "document", maxCount: 1 },
		{ name: "resume", maxCount: 1 },
	]),
	controller.ocrExtract
);

module.exports = router;