const axios = require("axios");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const { env } = require("../config/env");
const { extractEntities } = require("./nlp.service");
const { extractText } = require("./parser.service");

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function ensureGeminiKey() {
  if (!env.GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is missing");
    error.status = 503;
    error.code = "GEMINI_API_KEY_MISSING";
    throw error;
  }
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function uniqueNormalized(items = []) {
  return [...new Set(items.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))];
}

function buildLocalSummary(text) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);

  if (!words.length) {
    return "";
  }

  const preview = words.slice(0, 40).join(" ");
  return words.length > 40 ? `${preview}...` : preview;
}

function extractJson(text) {
  const cleaned = normalizeText(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const startIndex = cleaned.indexOf("{");
  const endIndex = cleaned.lastIndexOf("}");

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(startIndex, endIndex + 1));
  } catch (_error) {
    return null;
  }
}

function inferMimeType(file) {
  const extension = path.extname(file?.originalname || file?.path || "").toLowerCase();

  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    default:
      return file?.mimetype || "application/octet-stream";
  }
}

async function estimatePageCount(file) {
  const mimeType = inferMimeType(file);

  if (mimeType !== "application/pdf") {
    return 1;
  }

  const buffer = fs.readFileSync(file.path);
  const parsed = await pdfParse(buffer);

  return parsed.numpages || 1;
}

function buildAtsSuggestions(missingSkills, score) {
  const suggestions = [];

  if (missingSkills.length) {
    const missingPreview = missingSkills.slice(0, 3).join(", ");
    suggestions.push(`Add or highlight relevant keywords such as ${missingPreview}.`);
  }

  if (score < 70) {
    suggestions.push("Tailor the summary and experience bullets to mirror the job description more closely.");
  }

  suggestions.push("Add measurable achievements and tools used to strengthen ATS relevance.");

  return suggestions;
}

function analyzeAts(jobDescription, resumeText) {
  const jobEntities = extractEntities(jobDescription);
  const resumeEntities = extractEntities(resumeText);

  const jobSkills = uniqueNormalized(jobEntities.skills);
  const resumeSkills = uniqueNormalized(resumeEntities.skills);

  const matchedKeywords = jobSkills.filter((skill) => resumeSkills.includes(skill));
  const missingKeywords = jobSkills.filter((skill) => !resumeSkills.includes(skill));
  const score = jobSkills.length ? Math.round((matchedKeywords.length / jobSkills.length) * 100) : 0;

  return {
    score,
    matchedKeywords,
    missingKeywords,
    summary: jobSkills.length
      ? `Resume matches ${matchedKeywords.length} of ${jobSkills.length} key skills for this role.`
      : "No clear job-specific skills could be extracted from the job description.",
    suggestions: buildAtsSuggestions(missingKeywords, score),
    skills: {
      matched: matchedKeywords,
      missing: missingKeywords,
    },
  };
}

function buildOcrPrompt({ mode, language }) {
  const instructions = [
    "Extract all readable text from the attached document.",
    language ? `The document language is ${language}.` : "",
    mode === "ocr-summary"
      ? "Return valid JSON with keys text and summary."
      : "Return valid JSON with key text only.",
    "Do not wrap the response in markdown fences or add commentary.",
  ];

  return instructions.filter(Boolean).join(" ");
}

async function callGeminiForOcr(file, { mode = "ocr", language = "en" } = {}) {
  ensureGeminiKey();

  const mimeType = inferMimeType(file);
  const pageCount = await estimatePageCount(file);
  const fileBuffer = fs.readFileSync(file.path);

  let response;
  try {
    response = await axios.post(
      `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: buildOcrPrompt({ mode, language }) },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: fileBuffer.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      },
      {
        timeout: env.GEMINI_TIMEOUT_MS || 15000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    const status = error.response?.status;
    const upstreamMessage =
      error.response?.data?.error?.message ||
      error.response?.data?.message ||
      error.message ||
      "Gemini request failed";

    const wrapped = new Error(`Gemini OCR request failed: ${upstreamMessage}`);
    wrapped.status = status || 502;
    wrapped.code = status === 404 ? "GEMINI_MODEL_NOT_FOUND" : "GEMINI_OCR_UPSTREAM_FAILED";
    throw wrapped;
  }

  const generatedText = normalizeText(
    response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
  );
  const parsed = extractJson(generatedText) || {};
  const text = normalizeText(parsed.text || generatedText);
  const summary = mode === "ocr-summary" ? normalizeText(parsed.summary || buildLocalSummary(text)) : undefined;

  return {
    text,
    ...(summary ? { summary } : {}),
    pages: Number.isFinite(parsed.pages) && parsed.pages > 0 ? parsed.pages : pageCount,
  };
}

async function extractOcrText(file, options = {}) {
  const mimeType = inferMimeType(file);

  if (env.GEMINI_API_KEY) {
    return callGeminiForOcr(file, options);
  }

  if (mimeType !== "application/pdf") {
    const error = new Error("GEMINI_API_KEY is required for OCR extraction of image files");
    error.status = 503;
    error.code = "GEMINI_API_KEY_MISSING";
    throw error;
  }

  const text = normalizeText(await extractText(file.path, file.originalname));

  return {
    text,
    ...(options.mode === "ocr-summary" ? { summary: buildLocalSummary(text) } : {}),
    pages: await estimatePageCount(file),
  };
}

module.exports = {
  analyzeAts,
  extractOcrText,
};