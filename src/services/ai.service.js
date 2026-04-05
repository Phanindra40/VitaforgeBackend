const axios = require("axios");
const { env } = require("../config/env");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function ensureGroqKey() {
  if (!env.GROQ_API_KEY) {
    const error = new Error("GROQ_API_KEY is missing");
    error.status = 500;
    error.code = "GROQ_API_KEY_MISSING";
    throw error;
  }
}

function extractText(response) {
  return response?.data?.choices?.[0]?.message?.content?.trim() || "";
}

async function callGroq(prompt) {
  ensureGroqKey();

  try {
    const maxTokens = Number(env.GROQ_MAX_TOKENS || 1024);
    const timeout = Number(env.GROQ_TIMEOUT_MS || 10000);
    console.error("Calling Groq API with model:", env.GROQ_MODEL);

    const response = await axios.post(
      GROQ_URL,
      {
        model: env.GROQ_MODEL,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      },
      {
        timeout,
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.error("Groq response received");
    return extractText(response);
  } catch (error) {
    console.error("Groq API error:", error.response?.status, error.response?.data || error.message);
    console.error("Error message:", error.message);
    throw error;
  }
}

async function improveResumeText(text) {
  const prompt = `Improve the following resume text to be concise, ATS-friendly, and impact-focused. Keep factual accuracy and return improved bullet points where possible:\n\n${text}`;
  return callGroq(prompt);
}

async function generateTextFromPrompt(prompt) {
  return callGroq(prompt);
}

async function generateSummaryFromJobDescription(jobDescription) {
  const prompt = `Write a concise, ATS-friendly professional resume summary (4-6 lines) based on the job description below. Focus on measurable impact, relevant skills, and keywords from the description. Return only the summary text.\n\nJob Description:\n${jobDescription}`;
  return callGroq(prompt);
}

module.exports = {
  improveResumeText,
  generateTextFromPrompt,
  generateSummaryFromJobDescription,
};
