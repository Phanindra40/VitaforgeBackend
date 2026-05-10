const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const pdfParse = require("pdf-parse");

const { env } = require("../config/env");

const { extractEntities } = require("./nlp.service");
const { extractText } = require("./parser.service");

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_TIMEOUT = Number(
  env.GEMINI_TIMEOUT_MS || 15000
);

const MAX_OUTPUT_TOKENS = Number(
  env.GEMINI_MAX_OUTPUT_TOKENS || 4096
);

const MAX_RETRIES = Number(
  env.GEMINI_MAX_RETRIES || 3
);

const MAX_INPUT_SIZE_MB = Number(
  env.GEMINI_MAX_FILE_SIZE_MB || 15
);

/* -------------------------------------------------------------------------- */
/*                               AXIOS CLIENT                                 */
/* -------------------------------------------------------------------------- */

const geminiClient = axios.create({
  timeout: DEFAULT_TIMEOUT,

  headers: {
    "Content-Type": "application/json",
  },
});

/* -------------------------------------------------------------------------- */
/*                              VALIDATION                                    */
/* -------------------------------------------------------------------------- */

function ensureGeminiKey() {
  if (!env.GEMINI_API_KEY) {
    const error = new Error(
      "GEMINI_API_KEY is missing"
    );

    error.status = 503;
    error.code = "GEMINI_API_KEY_MISSING";

    throw error;
  }
}

function validateFile(file) {
  if (!file || !file.path) {
    const error = new Error(
      "Invalid uploaded file"
    );

    error.status = 400;
    error.code = "INVALID_FILE";

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                              TEXT HELPERS                                  */
/* -------------------------------------------------------------------------- */

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function uniqueNormalized(items = []) {
  return [
    ...new Set(
      items
        .map((item) =>
          normalizeText(item).toLowerCase()
        )
        .filter(Boolean)
    ),
  ];
}

function buildLocalSummary(text) {
  const words = normalizeText(text)
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) {
    return "";
  }

  const preview = words
    .slice(0, 40)
    .join(" ");

  return words.length > 40
    ? `${preview}...`
    : preview;
}

/* -------------------------------------------------------------------------- */
/*                            JSON EXTRACTION                                 */
/* -------------------------------------------------------------------------- */

function extractJson(text) {
  const cleaned = normalizeText(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const startIndex = cleaned.indexOf("{");

  const endIndex =
    cleaned.lastIndexOf("}");

  if (
    startIndex < 0 ||
    endIndex < 0 ||
    endIndex <= startIndex
  ) {
    return null;
  }

  try {
    return JSON.parse(
      cleaned.slice(
        startIndex,
        endIndex + 1
      )
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                             MIME TYPE DETECTION                            */
/* -------------------------------------------------------------------------- */

function inferMimeType(file) {
  const extension = path
    .extname(
      file?.originalname ||
        file?.path ||
        ""
    )
    .toLowerCase();

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
      return (
        file?.mimetype ||
        "application/octet-stream"
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                           FILE SIZE VALIDATION                             */
/* -------------------------------------------------------------------------- */

async function validateFileSize(filePath) {
  const stats = await fs.stat(filePath);

  const sizeMB =
    stats.size / (1024 * 1024);

  if (sizeMB > MAX_INPUT_SIZE_MB) {
    const error = new Error(
      `File exceeds ${MAX_INPUT_SIZE_MB}MB limit`
    );

    error.status = 413;
    error.code = "FILE_TOO_LARGE";

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                             PAGE ESTIMATION                                */
/* -------------------------------------------------------------------------- */

async function estimatePageCount(file) {
  const mimeType = inferMimeType(file);

  if (mimeType !== "application/pdf") {
    return 1;
  }

  try {
    const buffer = await fs.readFile(
      file.path
    );

    const parsed =
      await pdfParse(buffer);

    return parsed.numpages || 1;
  } catch {
    return 1;
  }
}

/* -------------------------------------------------------------------------- */
/*                             ATS ANALYSIS                                   */
/* -------------------------------------------------------------------------- */

function buildAtsSuggestions(
  missingSkills,
  score
) {
  const suggestions = [];

  if (missingSkills.length) {
    suggestions.push(
      `Add or highlight keywords such as ${missingSkills
        .slice(0, 3)
        .join(", ")}.`
    );
  }

  if (score < 70) {
    suggestions.push(
      "Tailor the summary and experience sections more closely to the job description."
    );
  }

  suggestions.push(
    "Add measurable achievements and technical tools where possible."
  );

  return suggestions;
}

function analyzeAts(
  jobDescription,
  resumeText
) {
  const jobEntities =
    extractEntities(jobDescription);

  const resumeEntities =
    extractEntities(resumeText);

  const jobSkills =
    uniqueNormalized(
      jobEntities.skills
    );

  const resumeSkills =
    uniqueNormalized(
      resumeEntities.skills
    );

  const matchedKeywords =
    jobSkills.filter((skill) =>
      resumeSkills.includes(skill)
    );

  const missingKeywords =
    jobSkills.filter(
      (skill) =>
        !resumeSkills.includes(skill)
    );

  const score = jobSkills.length
    ? Math.round(
        (matchedKeywords.length /
          jobSkills.length) *
          100
      )
    : 0;

  return {
    score,

    matchedKeywords,

    missingKeywords,

    summary: jobSkills.length
      ? `Resume matches ${matchedKeywords.length} of ${jobSkills.length} important skills.`
      : "No significant skills could be extracted from the job description.",

    suggestions:
      buildAtsSuggestions(
        missingKeywords,
        score
      ),

    skills: {
      matched: matchedKeywords,
      missing: missingKeywords,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                             OCR PROMPT                                     */
/* -------------------------------------------------------------------------- */

function buildOcrPrompt({
  mode,
  language,
}) {
  const instructions = [
    "Extract all readable text from the attached document.",

    language
      ? `Document language: ${language}.`
      : "",

    mode === "ocr-summary"
      ? "Return valid JSON with keys text and summary."
      : "Return valid JSON with key text only.",

    "Do not include markdown formatting or explanations.",
  ];

  return instructions
    .filter(Boolean)
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/*                               RETRY DELAY                                  */
/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/* -------------------------------------------------------------------------- */
/*                            GEMINI OCR CALL                                 */
/* -------------------------------------------------------------------------- */

async function callGeminiForOcr(
  file,
  {
    mode = "ocr",
    language = "en",
  } = {}
) {
  ensureGeminiKey();

  validateFile(file);

  await validateFileSize(file.path);

  const mimeType =
    inferMimeType(file);

  const pageCount =
    await estimatePageCount(file);

  const fileBuffer =
    await fs.readFile(file.path);

  const requestBody = {
    contents: [
      {
        role: "user",

        parts: [
          {
            text: buildOcrPrompt({
              mode,
              language,
            }),
          },

          {
            inline_data: {
              mime_type: mimeType,

              data:
                fileBuffer.toString(
                  "base64"
                ),
            },
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.2,

      maxOutputTokens:
        MAX_OUTPUT_TOKENS,
    },
  };

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `Calling Gemini OCR API (Attempt ${attempt})`
      );

      const response =
        await geminiClient.post(
          `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
            env.GEMINI_API_KEY
          )}`,
          requestBody
        );

      const generatedText =
        normalizeText(
          response.data?.candidates?.[0]
            ?.content?.parts
            ?.map(
              (part) =>
                part.text || ""
            )
            .join("")
        );

      if (!generatedText) {
        throw new Error(
          "Empty Gemini OCR response"
        );
      }

      const parsed =
        extractJson(
          generatedText
        ) || {};

      const text =
        normalizeText(
          parsed.text ||
            generatedText
        );

      const summary =
        mode === "ocr-summary"
          ? normalizeText(
              parsed.summary ||
                buildLocalSummary(
                  text
                )
            )
          : undefined;

      return {
        text,

        ...(summary
          ? { summary }
          : {}),

        pages:
          Number.isFinite(
            parsed.pages
          ) &&
          parsed.pages > 0
            ? parsed.pages
            : pageCount,
      };
    } catch (error) {
      lastError = error;

      const status =
        error.response?.status;

      console.error(
        `Gemini OCR attempt ${attempt} failed:`,
        status || error.message
      );

      /**
       * Avoid retrying most 4xx errors
       */
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 429
      ) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        const delay =
          Math.min(
            attempt * 1000,
            5000
          );

        console.log(
          `Retrying in ${delay}ms...`
        );

        await sleep(delay);
      }
    }
  }

  const status =
    lastError?.response?.status ||
    502;

  const message =
    lastError?.response?.data
      ?.error?.message ||
    lastError?.message ||
    "Gemini OCR request failed";

  const wrapped = new Error(
    `Gemini OCR failed: ${message}`
  );

  wrapped.status = status;

  wrapped.code =
    status === 404
      ? "GEMINI_MODEL_NOT_FOUND"
      : "GEMINI_OCR_UPSTREAM_FAILED";

  throw wrapped;
}

/* -------------------------------------------------------------------------- */
/*                         OCR EXTRACTION ENTRY                               */
/* -------------------------------------------------------------------------- */

async function extractOcrText(
  file,
  options = {}
) {
  validateFile(file);

  const mimeType =
    inferMimeType(file);

  /**
   * Prefer Gemini OCR if key exists
   */
  if (env.GEMINI_API_KEY) {
    return callGeminiForOcr(
      file,
      options
    );
  }

  /**
   * Local fallback only for PDFs
   */
  if (
    mimeType !==
    "application/pdf"
  ) {
    const error = new Error(
      "GEMINI_API_KEY is required for image OCR"
    );

    error.status = 503;

    error.code =
      "GEMINI_API_KEY_MISSING";

    throw error;
  }

  const text = normalizeText(
    await extractText(
      file.path,
      file.originalname
    )
  );

  return {
    text,

    ...(options.mode ===
    "ocr-summary"
      ? {
          summary:
            buildLocalSummary(
              text
            ),
        }
      : {}),

    pages:
      await estimatePageCount(
        file
      ),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  analyzeAts,

  extractOcrText,

  callGeminiForOcr,
};