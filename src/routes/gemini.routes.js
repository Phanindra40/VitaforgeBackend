const express = require("express");

const upload = require("../utils/gemini.upload");
const controller = require("../controllers/gemini.controller");

const router = express.Router();

function sendMethodNotAllowed(res) {
	return res.status(405).json({
		error: {
			code: "METHOD_NOT_ALLOWED",
			message: "Use POST with multipart/form-data and a file field named file, document, or resume.",
		},
	});
}

router.post("/ats-analyze", controller.atsAnalyze);
router.post("/ocr-summary", controller.ocrSummary);
router.post(
	"/ocr-extract",
	upload.fields([
		{ name: "file", maxCount: 1 },
		{ name: "document", maxCount: 1 },
		{ name: "resume", maxCount: 1 },
	]),
	controller.ocrExtract
);

router.all("/ocr-extract", (_req, res) => sendMethodNotAllowed(res));

module.exports = router;