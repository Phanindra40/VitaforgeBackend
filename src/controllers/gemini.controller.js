const fs = require("fs/promises");

const { env } = require("../config/env");
const { getOrSetJson, hashPayload } = require("../config/cache");
const { analyzeAts, extractOcrText } = require("../services/gemini.service");

function sendInvalidInput(res, message) {
  return res.status(400).json({
    error: {
      code: "INVALID_INPUT",
      message,
    },
  });
}

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getUploadedFile(req) {
  if (req.file) {
    return req.file;
  }

  const byField = req.files || {};
  return (
    byField.file?.[0] ||
    byField.document?.[0] ||
    byField.resume?.[0] ||
    null
  );
}

async function atsAnalyze(req, res) {
  const jobDescription = sanitizeText(req.body?.jobDescription);
  const resumeText = sanitizeText(req.body?.resumeText);

  if (!jobDescription) {
    return sendInvalidInput(res, "jobDescription is required");
  }

  if (!resumeText) {
    return sendInvalidInput(res, "resumeText is required");
  }

  if (jobDescription.length > 12000) {
    return sendInvalidInput(res, "jobDescription must be at most 12000 characters");
  }

  if (resumeText.length > 20000) {
    return sendInvalidInput(res, "resumeText must be at most 20000 characters");
  }

  try {
    const cacheKey = `ai:gemini:ats-analyze:${hashPayload({ jobDescription, resumeText })}`;
    const analysis = await getOrSetJson(
      cacheKey,
      async () => analyzeAts(jobDescription, resumeText),
      env.CACHE_AI_TTL_SECONDS
    );

    return res.status(200).json(analysis);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: {
        code: error.code || "ATS_ANALYSIS_FAILED",
        message: error.message || "Failed to analyze ATS fit",
      },
    });
  }
}

async function ocrExtract(req, res) {
  const mode = sanitizeText(req.body?.mode) || "ocr";
  const language = sanitizeText(req.body?.language) || "en";
  const uploadedFile = getUploadedFile(req);

  if (mode !== "ocr" && mode !== "ocr-summary") {
    return sendInvalidInput(res, "mode must be either 'ocr' or 'ocr-summary'");
  }

  if (!uploadedFile) {
    return sendInvalidInput(res, "A file is required in one of these fields: file, document, resume");
  }

  try {
    const result = await extractOcrText(uploadedFile, { mode, language });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: {
        code: error.code || "OCR_EXTRACTION_FAILED",
        message: error.message || "Failed to extract text from document",
      },
    });
  } finally {
    if (uploadedFile?.path) {
      await fs.unlink(uploadedFile.path).catch(() => {});
    }
  }
}

module.exports = {
  atsAnalyze,
  ocrExtract,
};