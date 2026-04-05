const axios = require("axios");
const { env } = require("../config/env");

const MODEL_URL = "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2";

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    magA += vecA[i] ** 2;
    magB += vecB[i] ** 2;
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function getEmbedding(text) {
  if (!env.HF_API_KEY) {
    throw new Error("HF_API_KEY is missing");
  }

  const response = await axios.post(
    MODEL_URL,
    { inputs: text },
    {
      headers: {
        Authorization: `Bearer ${env.HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  if (!Array.isArray(response.data)) {
    throw new Error("Unexpected embedding response format");
  }

  return response.data;
}

async function semanticMatchScore(resumeText, jobText) {
  const [resumeEmbedding, jobEmbedding] = await Promise.all([getEmbedding(resumeText), getEmbedding(jobText)]);
  const similarity = cosineSimilarity(resumeEmbedding, jobEmbedding);
  const score = Math.round(Math.max(0, Math.min(1, similarity)) * 100);
  return score;
}

module.exports = { getEmbedding, semanticMatchScore, cosineSimilarity };
