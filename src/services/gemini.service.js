const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { getOrSetJson, hashPayload } = require("../config/cache");

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

function isOpenRouterMode() {
  const hasGeminiKey = !!env.GEMINI_API_KEY;
  const isGeminiKeyOpenRouter = hasGeminiKey && env.GEMINI_API_KEY.startsWith("sk-or-");
  
  if (hasGeminiKey && !isGeminiKeyOpenRouter) {
    return false;
  }
  
  return !!(env.OPENROUTER_API_KEY || isGeminiKeyOpenRouter);
}

function ensureFreeOpenRouterModel(modelName, defaultFreeModel = "meta-llama/llama-3.3-70b-instruct:free") {
  if (!modelName) return defaultFreeModel;
  const trimmed = String(modelName).trim();
  if (trimmed === "openrouter/free" || trimmed.endsWith(":free")) {
    return trimmed;
  }
  if (!trimmed.includes(":")) {
    let mapped = trimmed;
    if (trimmed === "gemini-2.5-flash" || trimmed === "gemini-1.5-flash") {
      mapped = `google/${trimmed}`;
    }
    return `${mapped}:free`;
  }
  return defaultFreeModel;
}

function ensureGeminiKey() {
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    const error = new Error(
      "GEMINI_API_KEY or OPENROUTER_API_KEY is missing"
    );

    error.status = 503;
    error.code = "API_KEY_MISSING";

    throw error;
  }
}

async function callOpenRouterWithFallback(promptText, initialModel, apiKey, temperature, maxTokens) {
  const modelsToTry = [initialModel];
  if (env.OPENROUTER_FREE_MODELS) {
    for (const m of env.OPENROUTER_FREE_MODELS) {
      if (!modelsToTry.includes(m)) {
        modelsToTry.push(m);
      }
    }
  }

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      logger.info(`Calling OpenRouter API (Model: ${model})`);
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [{ role: "user", content: promptText }],
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://vitaforge.co.in",
            "X-Title": "VitaForge",
          },
          timeout: DEFAULT_TIMEOUT,
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (content !== undefined && content !== null) {
        logger.info(`Successfully received response from OpenRouter (Model: ${model})`);
        return content;
      }
      throw new Error(`Empty response from OpenRouter API for model ${model}`);
    } catch (error) {
      lastError = error;
      logger.warn(`OpenRouter call failed for model ${model}: ${error.message}`);
    }
  }
  throw lastError || new Error("All OpenRouter models failed");
}

async function callChatCompletion(promptText, temperature, maxTokens) {
  ensureGeminiKey();

  const hasGeminiKey = !!env.GEMINI_API_KEY;
  const hasOpenRouterKey = !!env.OPENROUTER_API_KEY;


  try {
    if (isOpenRouterMode()) {
      const apiKey = env.OPENROUTER_API_KEY || env.GEMINI_API_KEY;
      const rawModel = env.OPENROUTER_API_KEY ? env.OPENROUTER_MODEL : env.GEMINI_MODEL;
      const model = ensureFreeOpenRouterModel(rawModel, "meta-llama/llama-3.3-70b-instruct:free");

      return await callOpenRouterWithFallback(promptText, model, apiKey, temperature, maxTokens);
    } else {
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
            temperature,
            maxOutputTokens: maxTokens,
          },
        }
      );

      const content = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
      if (content === undefined || content === null) {
        throw new Error("Empty response from Gemini API");
      }
      return content;
    }
  } catch (error) {
    if (!isOpenRouterMode() && hasOpenRouterKey) {
      logger.warn(`Gemini API failed (${error.response?.status || error.message}). Falling back to OpenRouter...`);
      try {
        const apiKey = env.OPENROUTER_API_KEY;
        const initialModel = ensureFreeOpenRouterModel(env.OPENROUTER_MODEL, "openrouter/free");
        return await callOpenRouterWithFallback(promptText, initialModel, apiKey, temperature, maxTokens);
      } catch (orError) {
        logger.error("Fallback to OpenRouter free models failed:", orError.message);
        throw orError;
      }
    }

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
    "- Keep each question text concise and clear (under 2 sentences).",
    "- Keep each sampleAnswer short and extremely concise (under 3 sentences or a brief bulleted list). Do not write long paragraphs.",
    "- Limit the number of tags and assesses items to a maximum of 3 per question.",
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
    "You are an advanced, enterprise-grade Applicant Tracking System (ATS) matching parser and professional resume consultant.",
    "Your task is to analyze the candidate's resume text against the target job description with extreme precision.",
    "",
    "Provide a highly accurate, rigorous, and objective assessment including:",
    "1. Strict scoring based on keyword overlap, skill level match, structural completeness, and action-oriented impact.",
    "2. Granular identification of matched and missing keywords (frameworks, tools, programming languages, methodologies, and concepts). Do not group them into generic categories; extract the exact terms.",
    "3. Concrete strengths and gaps between the candidate's profile and the role requirements.",
    "4. Structural analysis and synonyms mapping using the priority checklist of canonical resume sections:",
    "   - Priority 1: Contact Information / Header (Checks for email, phone number, and links like LinkedIn or GitHub)",
    "   - Priority 2: Profile Summary / Career Objective",
    "   - Priority 3: Work Experience / Professional Experience / Work History",
    "   - Priority 4: Skills / Core Competencies / Technologies",
    "   - Priority 5: Projects / Portfolio",
    "   - Priority 6: Education / Academic Credentials",
    "   - Priority 7: Certifications / Licenses / Certificates",
    "   * Synonyms mapping: You must check the resume for these sections and understand them accordingly even if named differently (e.g., 'Work History' matches 'Work Experience').",
    "5. An actionable, step-by-step checklist ('actionPlan') to bridge the gaps. Provide highly specific, context-aware tasks:",
    "   - First, recommend creating any missing core sections from the priority checklist (especially Experience, Skills, Education) or renaming non-standard, casual headers (e.g., renaming 'My Stuff' or 'Where I worked' to standard canonical names like 'Skills' or 'Work Experience') to improve ATS parser readability.",
    "   - Next, list specific, prioritized keyword suggestions and bullet-refinement tasks.",
    "6. A professionally rewritten summary that maintains honesty while mirroring target job description keywords.",
    "7. At least 2-4 highly tailored, result-oriented rewrite bullets for the experience section. Each bullet must follow the X-Y-Z formula (Accomplished [X], as measured by [Y], by doing [Z]) and weave in the missing keywords naturally.",
    "",
    "Return ONLY valid JSON in this exact shape:",
    "{\n  \"score\": 75,\n  \"confidence\": 85,\n  \"headline\": \"Good potential for Software Developer\",\n  \"summary\": \"Resume matches core skills but lacks keyword density in system design.\",\n  \"targetRole\": \"Software Developer\",\n  \"strengths\": [\"Strong React and Node.js match\", \"Clear professional structure\"],\n  \"gaps\": [\"Missing cloud experience\", \"No mention of testing frameworks\"],\n  \"matchedKeywords\": [\"React\", \"JavaScript\", \"REST APIs\"],\n  \"missingKeywords\": [\"AWS\", \"Docker\", \"Jest\"],\n  \"recommendations\": [\"Highlight cloud projects\", \"Add Docker skill\"],\n  \"actionPlan\": [\"Rename custom heading 'Stuff I Did' to 'Work Experience'\", \"Add 2 bullet points on Docker\", \"Mention AWS experience\"],\n  \"rewrittenSummary\": \"Software Developer experienced in React and Node.js...\",\n  \"rewriteBullets\": [\n    \"Led development of a React dashboard, improving speed by 25%.\",\n    \"Configured CI/CD pipelines to streamline software releases.\"\n  ]\n}",
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

function safeParseInt(val, fallback = null) {
  if (val === null || val === undefined || val === "") return fallback;
  const num = Number(val);
  if (Number.isFinite(num)) return Math.round(num);
  const matched = String(val).match(/-?\d+/);
  if (matched) {
    const parsed = parseInt(matched[0], 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

async function analyzeAts(
  jobDescription,
  resumeText
) {
  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);
  if (hasApiKey) {
    try {
      logger.info("Calling AI for ATS Resume Analysis");
      const promptText = buildAtsAnalysisPrompt({ jobDescription, resumeText });

      const generatedText = normalizeText(
        await callChatCompletion(promptText, 0.1, MAX_OUTPUT_TOKENS)
      );

      if (!generatedText) {
        throw new Error("Empty response from AI ATS API");
      }

      const parsed = extractJson(generatedText);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Failed to parse AI ATS response as JSON");
      }
      logger.info("Successfully received and parsed AI ATS response");
      return {
        score: safeParseInt(parsed.score, 0),
        confidence: safeParseInt(parsed.confidence, null),
        headline: parsed.headline || "",
        summary: parsed.summary || "",
        targetRole: parsed.targetRole || "",
        strengths: parsed.strengths || [],
        gaps: parsed.gaps || [],
        matchedKeywords: parsed.matchedKeywords || [],
        missingKeywords: parsed.missingKeywords || [],
        recommendations: parsed.recommendations || [],
        actionPlan: parsed.actionPlan || [],
        rewrittenSummary: parsed.rewrittenSummary || parsed.rewritten_summary || parsed.tailoredSummary || parsed.tailored_summary || "",
        rewriteBullets: parsed.rewriteBullets || parsed.rewrite_bullets || parsed.bulletRewrites || parsed.bullet_rewrites || parsed.sampleBullets || parsed.sample_bullets || [],
        isAi: true
      };
    } catch (error) {
      logger.warn("AI ATS Analysis failed, falling back to local NLP analysis", { error: error.message });
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

  const base64Data = fileBuffer.toString("base64");
  const isOpenRouter = isOpenRouterMode();
  const apiKey = env.OPENROUTER_API_KEY || env.GEMINI_API_KEY;
  const rawModel = env.OPENROUTER_API_KEY ? env.OPENROUTER_OCR_MODEL : env.GEMINI_MODEL;
  const model = isOpenRouter
    ? ensureFreeOpenRouterModel(rawModel, "nvidia/nemotron-nano-12b-v2-vl:free")
    : env.GEMINI_MODEL;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      let generatedText;
      if (isOpenRouter) {
        logger.info(`Calling OpenRouter OCR API (Attempt ${attempt})`);

        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: buildOcrPrompt({ mode, language }),
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${base64Data}`,
                    },
                  },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
          },
          {
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://vitaforge.co.in",
              "X-Title": "VitaForge",
            },
            timeout: DEFAULT_TIMEOUT,
          }
        );
        generatedText = normalizeText(response.data?.choices?.[0]?.message?.content || "");
      } else {
        logger.info(`Calling Gemini OCR API (Attempt ${attempt})`);

        const response =
          await geminiClient.post(
            `${GEMINI_BASE_URL}/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
              env.GEMINI_API_KEY
            )}`,
            requestBody
          );

        generatedText =
          normalizeText(
            response.data?.candidates?.[0]
              ?.content?.parts
              ?.map(
                (part) =>
                  part.text || ""
              )
              .join("")
          );
      }

      if (!generatedText) {
        throw new Error(
          "Empty OCR response"
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

  if (!isOpenRouter && env.OPENROUTER_API_KEY) {
    logger.warn(`Gemini OCR failed: ${message}. Falling back to OpenRouter OCR...`);
    try {
      let model = ensureFreeOpenRouterModel(env.OPENROUTER_OCR_MODEL, "nvidia/nemotron-nano-12b-v2-vl:free");
      let response;
      try {
        response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: buildOcrPrompt({ mode, language }),
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${base64Data}`,
                    },
                  },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
          },
          {
            headers: {
              "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://vitaforge.co.in",
              "X-Title": "VitaForge",
            },
            timeout: DEFAULT_TIMEOUT,
          }
        );
      } catch (firstOrOcrError) {
        if (model !== "openrouter/free") {
          logger.warn(`OpenRouter OCR with model ${model} failed (${firstOrOcrError.message}). Retrying with openrouter/free...`);
          model = "openrouter/free";
          response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: buildOcrPrompt({ mode, language }),
                    },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${mimeType};base64,${base64Data}`,
                      },
                    },
                  ],
                },
              ],
              temperature: 0.2,
              max_tokens: MAX_OUTPUT_TOKENS,
            },
            {
              headers: {
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://vitaforge.co.in",
                "X-Title": "VitaForge",
              },
              timeout: DEFAULT_TIMEOUT,
            }
          );
        } else {
          throw firstOrOcrError;
        }
      }

      const generatedText = normalizeText(response.data?.choices?.[0]?.message?.content || "");
      if (generatedText) {
        const parsed = extractJson(generatedText) || {};
        const text = normalizeText(parsed.text || generatedText);
        const summary = mode === "ocr-summary"
          ? normalizeText(parsed.summary || buildLocalSummary(text))
          : undefined;

        logger.info(`Successfully received fallback response from OpenRouter OCR (model: ${model})`);
        return {
          text,
          ...(summary ? { summary } : {}),
          pages: Number.isFinite(parsed.pages) && parsed.pages > 0 ? parsed.pages : pageCount,
        };
      }
    } catch (orOcrError) {
      logger.error("Fallback to OpenRouter OCR also failed:", orOcrError.message);
    }
  }

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
      logger.info(`Calling AI summary API (Attempt ${attempt})`);

      const generatedText = normalizeText(
        await callChatCompletion(buildSummaryPrompt(promptText), 0.2, MAX_OUTPUT_TOKENS)
      );

      if (!generatedText) {
        throw new Error("Empty AI summary response");
      }

      const parsed = extractJson(generatedText) || {};
      const summary = normalizeText(parsed.summary || generatedText || buildLocalSummary(promptText));

      return {
        summary: summary || buildLocalSummary(promptText),
      };
    } catch (error) {
      lastError = error;

      const status = error.response?.status;

      logger.warn(`AI summary attempt ${attempt} failed`, { status: status || error.message });

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
    lastError?.response?.data?.error?.message || lastError?.message || "AI summary request failed";

  const wrapped = new Error(`AI summary failed: ${message}`);

  wrapped.status = status;
  wrapped.code = status === 404 ? "AI_MODEL_NOT_FOUND" : "AI_SUMMARY_UPSTREAM_FAILED";

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

  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);
  const isOpenRouter = isOpenRouterMode();

  /**
   * Prefer API OCR if key exists, except for PDFs under OpenRouter mode
   */
  if (hasApiKey) {
    if (isOpenRouter && mimeType === "application/pdf") {
      const text = normalizeText(
        await extractText(
          file.path,
          file.originalname
        )
      );

      return {
        text,
        ...(options.mode === "ocr-summary"
          ? { summary: buildLocalSummary(text) }
          : {}),
        pages: await estimatePageCount(file),
      };
    }

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
      "AI API key is required for image OCR"
    );

    error.status = 503;

    error.code =
      "API_KEY_MISSING";

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

  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);
  if (hasApiKey) {
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

function generateLocalInterviewQuestions({
  skills = [],
  targetRole = "",
  interviewType = "technical",
  difficulty = "medium",
  maxQuestions = 10,
}) {
  const role = targetRole || "Software Developer";
  const selectedSkills = skills.length ? skills : ["JavaScript", "React", "Node.js"];

  const technicalTemplates = [
    (skill) => `Explain your experience with ${skill} and how you've used it in a production project.`,
    (skill) => `What are the core concepts of ${skill}, and what are some common gotchas/pitfalls to avoid?`,
    (skill) => `How would you optimize performance or scale a system built with ${skill}?`,
    (skill) => `Describe a complex problem you solved using ${skill} and how you arrived at the solution.`,
    (skill) => `Explain the difference between ${skill} and a major alternative, detailing the tradeoffs.`,
  ];

  const behavioralTemplates = [
    `Describe a time you had to deal with ambiguity or changing requirements in your role as a ${role}.`,
    `Tell me about a time you had a technical disagreement with a teammate or stakeholder. How did you resolve it?`,
    `Walk me through a project that failed or had major delays. What did you learn and how did you handle it?`,
    `Describe a situation where you had to explain a complex technical concept to a non-technical stakeholder.`,
    `Tell me about a time you had to manage a tight deadline or high-pressure situation.`,
  ];

  const systemDesignTemplates = [
    `Design a distributed rate limiting system that can handle millions of requests per second for a ${role} platform.`,
    `How would you design a real-time notification service (like push, email, SMS) at scale?`,
    `Design a highly available and scalable backend for a collaborative document editor like Google Docs.`,
    `Design a caching layer for a database-heavy application to reduce latency and load.`,
    `How would you design a search and recommendation engine for an e-commerce platform?`,
  ];

  let templates = [];
  if (interviewType === "behavioral") {
    templates = behavioralTemplates;
  } else if (interviewType === "system-design") {
    templates = systemDesignTemplates;
  } else {
    templates = technicalTemplates;
  }

  const questions = [];
  for (let i = 0; i < maxQuestions; i++) {
    const qIndex = i % templates.length;
    let questionText = "";

    if (interviewType === "technical") {
      const skill = selectedSkills[i % selectedSkills.length];
      questionText = templates[qIndex](skill);
    } else {
      questionText = templates[qIndex];
    }

    const itemSkill = interviewType === "technical" ? selectedSkills[i % selectedSkills.length] : "";

    questions.push({
      id: `q${i + 1}`,
      question: questionText,
      q: questionText,
      difficulty,
      tags: itemSkill ? [itemSkill.toLowerCase(), interviewType] : [interviewType],
      assesses: ["Problem Solving", "Technical Communication", interviewType],
      sampleAnswer: `This is a sample answer template for the ${difficulty} ${interviewType} question ${itemSkill ? `about ${itemSkill}` : "on engineering scenarios"}. In your actual response, make sure to use the STAR method (Situation, Task, Action, Result) or discuss tradeoffs.`,
    });
  }

  return questions;
}

async function generateInterviewQuestions(options = {}) {
  const maxQuestions = Number.isFinite(Number(options.maxQuestions))
    ? Math.max(1, Math.min(20, Math.round(Number(options.maxQuestions))))
    : 10;

  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);

  if (!hasApiKey) {
    logger.info("AI API key missing, using local fallback question generation");
    const questions = generateLocalInterviewQuestions({
      skills: Array.isArray(options.skills) ? options.skills.map((item) => normalizeText(String(item))).filter(Boolean) : [],
      targetRole: normalizeText(options.targetRole),
      interviewType: normalizeText(options.interviewType) || "technical",
      difficulty: normalizeText(options.difficulty) || "medium",
      maxQuestions,
    });
    return {
      modelOutput: "Local fallback question generation (API key missing)",
      parsed: { questions },
      questions,
    };
  }

  const promptText = buildInterviewQuestionsPrompt({
    resumeText: normalizeText(options.resumeText),
    skills: Array.isArray(options.skills) ? options.skills.map((item) => normalizeText(String(item))).filter(Boolean) : [],
    targetRole: normalizeText(options.targetRole),
    targetCompanies: Array.isArray(options.targetCompanies) ? options.targetCompanies.map((item) => normalizeText(String(item))).filter(Boolean) : [],
    interviewType: normalizeText(options.interviewType) || "technical",
    difficulty: normalizeText(options.difficulty) || "medium",
    maxQuestions,
  });

  const cacheKey = `ai:gemini:questions:${hashPayload({
    resumeText: options.resumeText,
    skills: options.skills,
    targetRole: options.targetRole,
    targetCompanies: options.targetCompanies,
    interviewType: options.interviewType,
    difficulty: options.difficulty,
    maxQuestions,
  })}`;

  try {
    return await getOrSetJson(
      cacheKey,
      async () => {
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            logger.info(`Calling AI interview generation API (Attempt ${attempt})`);

            const generatedText = normalizeText(
              await callChatCompletion(promptText, 0.2, MAX_OUTPUT_TOKENS)
            );

            if (!generatedText) {
              throw new Error("Empty AI interview generation response");
            }

            const parsed = extractJson(generatedText);
            if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
              throw new Error("Failed to parse AI response or questions array is empty/missing");
            }

            const questions = parsed.questions
              .map(normalizeInterviewQuestion)
              .filter((question) => question.q)
              .slice(0, maxQuestions);

            if (questions.length === 0) {
              throw new Error("No valid questions could be extracted from AI response");
            }

            return {
              modelOutput: generatedText,
              parsed: { ...parsed, questions },
              questions,
            };
          } catch (error) {
            lastError = error;

            const status = error.response?.status;
            logger.warn(`AI interview generation attempt ${attempt} failed`, { status: status || error.message });

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

        throw lastError || new Error("AI interview generation failed");
      },
      env.CACHE_AI_TTL_SECONDS
    );
  } catch (error) {
    logger.warn("AI interview generation failed completely, falling back to local questions", {
      error: error?.message,
    });

    const fallbackQuestions = generateLocalInterviewQuestions({
      skills: Array.isArray(options.skills) ? options.skills.map((item) => normalizeText(String(item))).filter(Boolean) : [],
      targetRole: normalizeText(options.targetRole),
      interviewType: normalizeText(options.interviewType) || "technical",
      difficulty: normalizeText(options.difficulty) || "medium",
      maxQuestions,
    });

    return {
      modelOutput: "Local fallback question generation (AI call failed)",
      parsed: { questions: fallbackQuestions },
      questions: fallbackQuestions,
    };
  }
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
  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);
  if (!hasApiKey) {
    return null;
  }

  const promptText = buildAnswerEvaluationPrompt({
    questionText: normalizeText(options.questionText),
    answerText: normalizeText(options.answerText),
    resumeText: normalizeText(options.resumeText),
    interviewType: normalizeText(options.interviewType),
  });

  const cacheKey = `ai:gemini:evaluate:${hashPayload({
    questionText: options.questionText,
    answerText: options.answerText,
    resumeText: options.resumeText,
    interviewType: options.interviewType,
  })}`;

  try {
    return await getOrSetJson(
      cacheKey,
      async () => {
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            logger.info(`Calling AI answer evaluation API (Attempt ${attempt})`);

            const generatedText = normalizeText(
              await callChatCompletion(promptText, 0.1, MAX_OUTPUT_TOKENS)
            );

            if (!generatedText) {
              throw new Error("Empty AI answer evaluation response");
            }

            const parsed = extractJson(generatedText);
            if (!parsed || typeof parsed !== "object") {
              throw new Error("Failed to parse AI evaluation output as JSON");
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
            logger.warn(`AI answer evaluation attempt ${attempt} failed`, { status: status || error.message });

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

        throw lastError || new Error("AI answer evaluation failed");
      },
      env.CACHE_AI_TTL_SECONDS
    );
  } catch (error) {
    logger.error("AI answer evaluation failed completely:", error.message);
    return null;
  }
}

async function generateInterviewCoachChat(messages = [], context = {}) {
  const hasApiKey = !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY);
  if (!hasApiKey) {
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
      logger.info(`Calling AI chat API (Attempt ${attempt})`);

      const reply = normalizeText(
        await callChatCompletion(promptText, 0.7, 256)
      );

      if (reply) {
        return reply;
      }
    } catch (error) {
      lastError = error;
      logger.warn(`AI chat attempt ${attempt} failed: ${error.message}`);
      
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