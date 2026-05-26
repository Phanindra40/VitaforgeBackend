const express = require("express");

const upload = require("../utils/gemini.upload");
const controller = require("../controllers/gemini.controller");

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               Helpers                                      */
/* -------------------------------------------------------------------------- */

const sendMethodNotAllowed = (res) => {
  return res.status(405).json({
    success: false,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message:
        "Use POST with multipart/form-data and a file field named file, document, or resume.",
    },
  });
};

/* -------------------------------------------------------------------------- */
/*                               Upload Config                                */
/* -------------------------------------------------------------------------- */

const resumeUploadMiddleware = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "document", maxCount: 1 },
  { name: "resume", maxCount: 1 },
]);

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

/**
 * ATS Resume Analysis
 */
router.post(
  "/ats-analyze",
  controller.atsAnalyze
);

/**
 * OCR Resume Summary
 */
router.post(
  "/ocr-summary",
  controller.ocrSummary
);

/**
 * OCR Resume Extraction
 */
router
  .route("/ocr-extract")
  .post(
    resumeUploadMiddleware,
    controller.ocrExtract
  )
  .all((_req, res) => sendMethodNotAllowed(res));

module.exports = router;