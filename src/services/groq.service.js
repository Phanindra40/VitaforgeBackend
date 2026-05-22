const axios = require("axios");

const { env } = require("../config/env");
const { logger } = require("../utils/logger");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_TIMEOUT = Number(env.GROQ_TIMEOUT_MS || 10000);
const DEFAULT_MAX_TOKENS = Number(env.GROQ_MAX_TOKENS || 1024);
const MAX_INPUT_LENGTH = Number(env.GROQ_MAX_INPUT_CHARS || 12000);
const MAX_RETRIES = Number(env.GROQ_MAX_RETRIES || 3);

const groqClient = axios.create({
  baseURL: GROQ_URL,
  timeout: DEFAULT_TIMEOUT,
  headers: {
    Authorization: `Bearer ${env.GROQ_API_KEY}`,
    "Content-Type": "application/json",
  },
});

function ensureGroqKey() {
  if (!env.GROQ_API_KEY) {
    const error = new Error("GROQ_API_KEY is missing");
    error.status = 500;
    error.code = "GROQ_API_KEY_MISSING";
    throw error;
  }
}

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    const error = new Error("Prompt must be a non-empty string");
    error.status = 400;
    error.code = "INVALID_PROMPT";
    throw error;
  }
}

function sanitizePrompt(prompt) {
  return prompt.replace(/\0/g, "").trim().slice(0, MAX_INPUT_LENGTH);
}

function extractText(response) {
  const text = response?.data?.choices?.[0]?.message?.content;

  if (!text || typeof text !== "string") {
    const error = new Error("Invalid Groq response format");
    error.status = 502;
    error.code = "INVALID_GROQ_RESPONSE";
    throw error;
  }

  return text.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGroq(prompt) {
  ensureGroqKey();
  validatePrompt(prompt);

  const cleanedPrompt = sanitizePrompt(prompt);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Groq API (Attempt ${attempt})`);

      const response = await groqClient.post("", {
        model: env.GROQ_MODEL,
        temperature: 0.2,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content:
              "You are a professional ATS resume optimization assistant. Return concise, professional, and high-quality outputs.",
          },
          {
            role: "user",
            content: cleanedPrompt,
          },
        ],
      });

      logger.info("Groq response received successfully");

      return extractText(response);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      logger.warn(`Groq API attempt ${attempt} failed`, {
        status: status || error.message,
      });

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

  const status = lastError?.response?.status || 500;
  const message =
    lastError?.response?.data?.error?.message ||
    lastError?.message ||
    "Groq API request failed";

  const normalizedError = new Error(message);
  normalizedError.status = status;
  normalizedError.code = "GROQ_API_ERROR";
  throw normalizedError;
}

async function improveResumeText(text) {
  const prompt = `
Improve the following resume content.

Requirements:
- ATS-friendly
- concise and modern
- strong action verbs
- impact-focused
- professional formatting
- preserve factual accuracy
- optimize bullet points

Return only the improved content.

Resume Content:
${text}
`;

  return callGroq(prompt);
}

async function generateTextFromPrompt(prompt) {
  return callGroq(prompt);
}

async function generateSummaryFromJobDescription(jobDescription) {
  const prompt = `
Write a concise ATS-friendly professional resume summary.

Requirements:
- 4 to 6 lines
- keyword optimized
- professional tone
- measurable impact if possible
- tailored to the job description
- concise and modern

Return only the summary.

Job Description:
${jobDescription}
`;

  return callGroq(prompt);
}

module.exports = {
  callGroq,
  improveResumeText,
  generateTextFromPrompt,
  generateSummaryFromJobDescription,
};
