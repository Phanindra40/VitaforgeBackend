const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const { env } = require("../config/env");
const { logger } = require("../utils/logger");

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

function buildSummaryPrompt(text) {
  return [
    "Write a concise summary of the following text.",
    "Return valid JSON with a single key named summary.",
    "Keep the summary clear, factual, and short.",
    "Text:",
    text,
  ].join("\n");
}

function buildInterviewQuestionsPrompt({
  resumeText,
  skills = [],
  targetRole = "",
  targetCompanies = [],
  interviewType = "technical",
  difficulty = "medium",
  maxQuestions = 10,
}) {
  const typeGuidelines = {
    technical: [
      "- Focus on programming languages, core computer science, framework internals, algorithms, databases, API design, security, and coding paradigms.",
      "- Ensure questions test specific technologies mentioned on the candidate's resume/skills (e.g. Java, Python, React, SAP modules like ABAP, etc.).",
      "- Include problem-solving scenarios, practical debugging, or refactoring questions."
    ].join("\n"),
    behavioral: [
      "- Focus on soft skills, leadership, conflict resolution, dealing with ambiguity, tight deadlines, failure, and adapting to change.",
      "- Frame questions to trigger responses structured around the STAR methodology (Situation, Task, Action, Result).",
      "- Examples: 'Describe a time you had to pivot mid-project...', 'Tell me about a time you had a technical disagreement with a teammate...'."
    ].join("\n"),
    "system-design": [
      "- Focus on scalability, high availability, reliability, latency, microservices, load balancers, caching, database replication, rate limiting, and queueing systems.",
      "- Frame questions around designing a full production architecture for realistic applications under high constraint.",
      "- Examples: 'Design a distributed rate limiter...', 'Design a chat system at scale...', 'Design a real-time notification engine...'."
    ].join("\n")
  };

  const difficultyGuidelines = {
    easy: [
      "- Entry-level / Junior developer focus.",
      "- Questions should assess foundational conceptual knowledge, basic syntax, fundamental paradigms, standard design patterns, and simple scenarios.",
      "- Avoid highly complex tradeoff deep dives."
    ].join("\n"),
    medium: [
      "- Mid-level developer focus.",
      "- Questions should evaluate practical implementation choices, optimization strategies, standard concurrency patterns, testing habits, and medium-scale designs.",
      "- Focus on real-world application building and day-to-day coding decisions."
    ].join("\n"),
    hard: [
      "- Senior / Staff Engineer / Architect focus.",
      "- Questions must push on complex engineering tradeoffs, distributed system failures, bottlenecks at scale, database transaction isolation tradeoffs, or highly ambiguous organizational leadership issues."
    ].join("\n")
  };

  const companyNote = targetCompanies.length 
    ? `- Tailor some of the questions to mirror the known interview style, engineering values, scale, or business domain of: ${targetCompanies.join(", ")}.`
    : "";

  return [
    "You are an expert technical interviewer and interview coach.",
    `Generate exactly ${maxQuestions} unique, realistic, and highly practical interview questions for a candidate preparing for the target role: "${targetRole || "Software Engineer"}".`,
    "",
    `Interview Type: ${interviewType.toUpperCase()}`,
    typeGuidelines[interviewType] || typeGuidelines.technical,
    "",
    `Difficulty Level: ${difficulty.toUpperCase()}`,
    difficultyGuidelines[difficulty] || difficultyGuidelines.medium,
    "",
    companyNote,
    "- Customize the questions to reference or assess projects, technologies, and skills mentioned in the candidate's resume where appropriate.",
    "- Ensure each question has a corresponding realistic sample answer, tags (e.g. key technologies or concepts), and assessed capabilities.",
    "",
    "Return ONLY valid JSON in this exact shape:",
    '{"questions":[{"q":"...","difficulty":"...","tags":["..."],"assesses":["..."],"sampleAnswer":"..."}]}',
    "",
    "Rules:",
    "- Write the actual question text only.",
    "- Do not prefix questions with labels like 'technical question for...' or numberings.",
    "- Do not include explanations, markdown, code fences, or extra commentary outside the JSON.",
    "- Ensure all JSON properties and strings are escaped correctly.",
    "",
    "Resume:",
    resumeText || "",
    "Skills:",
    skills.length ? skills.join(", ") : "",
  ].filter(Boolean).join("\n");
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

    const uint8 = new Uint8Array(buffer);
    const parser = new PDFParse(uint8);
    const parsed = await parser.getText();

    return parsed.total || 1;
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

function buildAtsAnalysisPrompt({ jobDescription, resumeText }) {
  return [
    "You are an advanced Applicant Tracking System (ATS) optimization engine and resume consultant.",
    "Analyze the candidate's resume text against the target job description.",
    "Evaluate keyword alignment, skill matches, role suitability, structural gaps, and content quality.",
    "Provide a strict, professional, and actionable evaluation.",
    "Return ONLY valid JSON in this exact shape:",
    "{\n  \"score\": 75,\n  \"confidence\": 85,\n  \"headline\": \"Good potential for Software Developer\",\n  \"summary\": \"Resume matches core skills but lacks keyword density in system design.\",\n  \"targetRole\": \"Software Developer\",\n  \"strengths\": [\"Strong React and Node.js match\", \"Clear professional structure\"],\n  \"gaps\": [\"Missing cloud experience\", \"No mention of testing frameworks\"],\n  \"matchedKeywords\": [\"React\", \"JavaScript\", \"REST APIs\"],\n  \"missingKeywords\": [\"AWS\", \"Docker\", \"Jest\"],\n  \"recommendations\": [\"Highlight cloud projects\", \"Add Docker skill\"],\n  \"actionPlan\": [\"Add 2 bullet points on Docker\", \"Mention AWS experience\"],\n  \"rewrittenSummary\": \"Software Developer experienced in React and Node.js...\",\n  \"rewriteBullets\": [\n    \"Led development of a React dashboard, improving speed by 25%.\",\n    \"Configured CI/CD pipelines to streamline software releases.\"\n  ]\n}",
    "",
    "Rules:",
    "- 'score' must be an integer between 0 and 100, reflecting a realistic match score.",
    "- 'confidence' must be an integer between 0 and 100, representing your confidence in this match based on details and clarity of both texts.",
    "- 'headline' should be a short, encouraging summary of fit.",
    "- 'summary' should be a concise overview of the match (2-3 sentences).",
    "- 'targetRole' is the target job title from the job description.",
    "- 'strengths', 'gaps', 'matchedKeywords', 'missingKeywords', 'recommendations', 'actionPlan', and 'rewriteBullets' must be arrays of clear, concise strings.",
    "- Do not include markdown formatting, code fences, or any extra text outside of the JSON.",
    "",
    "Job Description:",
    jobDescription || "",
    "",
    "Resume Text:",
    resumeText || ""
  ].join("\n");
}

async function analyzeAts(
  jobDescription,
  resumeText
) {
  if (env.GEMINI_API_KEY) {
    try {
      logger.info("Calling Gemini for ATS Resume Analysis");
      const promptText = buildAtsAnalysisPrompt({ jobDescription, resumeText });

      const response = await geminiClient.post(
        `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }
      );

      const generatedText = normalizeText(
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      );

      if (!generatedText) {
        throw new Error("Empty response from Gemini ATS API");
      }

      const parsed = extractJson(generatedText);
      if (parsed && typeof parsed === "object") {
        logger.info("Successfully received and parsed Gemini ATS response");
        return {
          score: typeof parsed.score === "number" ? parsed.score : 0,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
          headline: parsed.headline || "",
          summary: parsed.summary || "",
          targetRole: parsed.targetRole || "",
          strengths: parsed.strengths || [],
          gaps: parsed.gaps || [],
          matchedKeywords: parsed.matchedKeywords || [],
          missingKeywords: parsed.missingKeywords || [],
          recommendations: parsed.recommendations || [],
          actionPlan: parsed.actionPlan || [],
          rewrittenSummary: parsed.rewrittenSummary || "",
          rewriteBullets: parsed.rewriteBullets || [],
          isAi: true
        };
      }
    } catch (error) {
      logger.warn("Gemini ATS Analysis failed, falling back to local NLP analysis", { error: error.message });
    }
  }

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
    confidence: null,
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
    isAi: false
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
      logger.info(`Calling Gemini OCR API (Attempt ${attempt})`);

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

      logger.warn(`Gemini OCR attempt ${attempt} failed`, { status: status || error.message });

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

        logger.info(`Retrying in ${delay}ms...`);

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

async function callGeminiForSummary(text) {
  ensureGeminiKey();

  const promptText = normalizeText(text);

  if (!promptText) {
    const error = new Error("Text is required for summary generation");

    error.status = 400;
    error.code = "INVALID_INPUT";

    throw error;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Gemini summary API (Attempt ${attempt})`);

      const response = await geminiClient.post(
        `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: buildSummaryPrompt(promptText) }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }
      );

      const generatedText = normalizeText(
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      );

      if (!generatedText) {
        throw new Error("Empty Gemini summary response");
      }

      const parsed = extractJson(generatedText) || {};
      const summary = normalizeText(parsed.summary || generatedText || buildLocalSummary(promptText));

      return {
        summary: summary || buildLocalSummary(promptText),
      };
    } catch (error) {
      lastError = error;

      const status = error.response?.status;

      logger.warn(`Gemini summary attempt ${attempt} failed`, { status: status || error.message });

      if (status && status >= 400 && status < 500 && status !== 429) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        const delay = Math.min(attempt * 1000, 5000);

        logger.info(`Retrying in ${delay}ms...`);

        await sleep(delay);
      }
    }
  }

  const status = lastError?.response?.status || 502;
  const message =
    lastError?.response?.data?.error?.message || lastError?.message || "Gemini summary request failed";

  const wrapped = new Error(`Gemini summary failed: ${message}`);

  wrapped.status = status;
  wrapped.code = status === 404 ? "GEMINI_MODEL_NOT_FOUND" : "GEMINI_SUMMARY_UPSTREAM_FAILED";

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

async function summarizeText(text) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    const error = new Error("text is required");

    error.status = 400;
    error.code = "INVALID_INPUT";

    throw error;
  }

  if (env.GEMINI_API_KEY) {
    return callGeminiForSummary(normalizedText);
  }

  return {
    summary: buildLocalSummary(normalizedText),
  };
}

function normalizeInterviewQuestionText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/^(behavioral|technical|hr) question for[^:]*:\s*/i, "")
    .replace(/^question:\s*/i, "")
    .trim();
}

function normalizeInterviewQuestion(item) {
  if (typeof item === "string") {
    return { q: normalizeInterviewQuestionText(item) };
  }

  if (!item || typeof item !== "object") {
    return { q: "" };
  }

  return {
    ...item,
    q: normalizeInterviewQuestionText(item.q || item.question || item.text || item.prompt || ""),
  };
}

async function generateInterviewQuestions(options = {}) {
  ensureGeminiKey();

  const maxQuestions = Number.isFinite(Number(options.maxQuestions))
    ? Math.max(1, Math.min(20, Math.round(Number(options.maxQuestions))))
    : 10;

  const promptText = buildInterviewQuestionsPrompt({
    resumeText: normalizeText(options.resumeText),
    skills: Array.isArray(options.skills) ? options.skills.map((item) => normalizeText(String(item))).filter(Boolean) : [],
    targetRole: normalizeText(options.targetRole),
    targetCompanies: Array.isArray(options.targetCompanies) ? options.targetCompanies.map((item) => normalizeText(String(item))).filter(Boolean) : [],
    interviewType: normalizeText(options.interviewType) || "technical",
    difficulty: normalizeText(options.difficulty) || "medium",
    maxQuestions,
  });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Gemini interview generation API (Attempt ${attempt})`);

      const response = await geminiClient.post(
        `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }
      );

      const generatedText = normalizeText(
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      );

      if (!generatedText) {
        throw new Error("Empty Gemini interview generation response");
      }

      const parsed = extractJson(generatedText) || {};
      const questions = Array.isArray(parsed.questions)
        ? parsed.questions.map(normalizeInterviewQuestion).filter((question) => question.q).slice(0, maxQuestions)
        : [];

      return {
        modelOutput: generatedText,
        parsed: Array.isArray(parsed.questions) ? { ...parsed, questions } : null,
        questions,
      };
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      logger.warn(`Gemini interview generation attempt ${attempt} failed`, { status: status || error.message });

      if (status && status >= 400 && status < 500 && status !== 429) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        const delay = Math.min(attempt * 1000, 5000);
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  const status = lastError?.response?.status || 502;
  const message = lastError?.response?.data?.error?.message || lastError?.message || "Gemini interview generation failed";

  const wrapped = new Error(`Gemini interview generation failed: ${message}`);
  wrapped.status = status;
  wrapped.code = status === 404 ? "GEMINI_MODEL_NOT_FOUND" : "GEMINI_INTERVIEW_UPSTREAM_FAILED";

  throw wrapped;
}

function buildAnswerEvaluationPrompt({
  questionText,
  answerText,
  resumeText = "",
  interviewType = "",
}) {
  return [
    "You are an expert technical interviewer and communication coach.",
    "Evaluate the candidate's answer to the given interview question.",
    "Provide a detailed, precise, and constructive evaluation.",
    "Return ONLY valid JSON in this exact shape:",
    '{"score": 85, "note": "Detailed feedback note analyzing the response...", "strengths": ["Strength 1", "Strength 2"], "improvements": ["Improvement 1", "Improvement 2"]}',
    "",
    "Rules:",
    "- 'score' must be an integer between 0 and 100, representing a realistic assessment of the response's quality.",
    "- Be honest and strict. Poor, empty, irrelevant, or generic answers must get low scores (e.g. 0-40). Excellent answers with specific examples, deep technical knowledge, or structure (STAR method for behavioral) should get high scores (e.g. 80-100).",
    "- 'note' should contain a 3-5 sentence constructive critique explaining the score and how they performed.",
    "- 'strengths' must be an array of 1 to 4 concrete points of what was done well.",
    "- 'improvements' must be an array of 1 to 4 actionable, specific suggestions to improve their answer.",
    "- Do not include markdown formatting, code fences, or any extra text.",
    "",
    `Interview Question: ${questionText}`,
    `Candidate's Answer: ${answerText}`,
    resumeText ? `Candidate's Resume Context: ${resumeText}` : "",
    interviewType ? `Interview Type: ${interviewType}` : "",
  ].filter(Boolean).join("\n");
}

async function evaluateInterviewAnswer(options = {}) {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const promptText = buildAnswerEvaluationPrompt({
    questionText: normalizeText(options.questionText),
    answerText: normalizeText(options.answerText),
    resumeText: normalizeText(options.resumeText),
    interviewType: normalizeText(options.interviewType),
  });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Gemini answer evaluation API (Attempt ${attempt})`);

      const response = await geminiClient.post(
        `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }
      );

      const generatedText = normalizeText(
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      );

      if (!generatedText) {
        throw new Error("Empty Gemini answer evaluation response");
      }

      const parsed = extractJson(generatedText);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Failed to parse Gemini evaluation output as JSON");
      }

      const score = Number.isFinite(Number(parsed.score))
        ? Math.max(0, Math.min(100, Math.round(Number(parsed.score))))
        : 50;

      return {
        score,
        note: normalizeText(parsed.note || parsed.feedback || ""),
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(s => normalizeText(String(s))).filter(Boolean) : [],
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(i => normalizeText(String(i))).filter(Boolean) : [],
      };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      logger.warn(`Gemini answer evaluation attempt ${attempt} failed`, { status: status || error.message });

      if (status && status >= 400 && status < 500 && status !== 429) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        const delay = Math.min(attempt * 1000, 5000);
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  return null;
}

async function generateInterviewCoachChat(messages = [], context = {}) {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const systemInstructions = [
    "You are an expert interview coach helping a candidate prepare for an upcoming interview.",
    "Provide extremely precise, constructive, and actionable advice.",
    "Keep your response to 3-5 sentences maximum. Be professional, encouraging, and clear.",
    context?.preferences?.targetRole ? `The candidate's target role is: ${context.preferences.targetRole}.` : "",
    context?.preferences?.interviewType ? `The interview type is: ${context.preferences.interviewType}.` : "",
    context?.preferences?.difficulty ? `The difficulty level is: ${context.preferences.difficulty}.` : "",
  ].filter(Boolean).join(" ");

  const conversationLog = messages.map(m => `${m.role === "assistant" ? "Coach" : "Candidate"}: ${m.content}`).join("\n");
  
  const promptText = [
    systemInstructions,
    "",
    "Conversation History:",
    conversationLog,
    "",
    "Provide the next response as the Coach:",
  ].join("\n");

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Gemini chat API (Attempt ${attempt})`);

      const response = await geminiClient.post(
        `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 256,
          },
        }
      );

      const reply = normalizeText(
        response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      );

      if (reply) {
        return reply;
      }
    } catch (error) {
      lastError = error;
      logger.warn(`Gemini chat attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < MAX_RETRIES) {
        await sleep(1000);
      }
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                  EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  analyzeAts,

  extractOcrText,

  summarizeText,

  generateInterviewQuestions,

  callGeminiForOcr,

  evaluateInterviewAnswer,

  generateInterviewCoachChat,
};