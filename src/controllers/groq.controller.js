const { generateTextFromPrompt, generateSummaryFromJobDescription } = require("../services/ai.service");

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

async function generate(req, res) {
  const prompt = sanitizeText(req.body?.prompt);

  if (!prompt) {
    return sendInvalidInput(res, "prompt is required");
  }

  if (prompt.length > 8000) {
    return sendInvalidInput(res, "prompt must be at most 8000 characters");
  }

  try {
    console.log("Generating text for prompt:", prompt.substring(0, 100));
    const text = await generateTextFromPrompt(prompt);
    console.log("Generated text:", text.substring(0, 100));
    return res.status(200).json({ text });
  } catch (error) {
    console.error("Groq generate error:", error.message);
    console.error("Error details:", error);
    return res.status(500).json({
      error: {
        code: "AI_GENERATION_FAILED",
        message: error.message || "Failed to generate text",
      },
    });
  }
}

async function summaryFromJd(req, res) {
  const jobDescription = sanitizeText(req.body?.jobDescription);

  if (!jobDescription) {
    return sendInvalidInput(res, "jobDescription is required");
  }

  if (jobDescription.length > 12000) {
    return sendInvalidInput(res, "jobDescription must be at most 12000 characters");
  }

  try {
    console.log("Generating summary from JD, length:", jobDescription.length);
    const text = await generateSummaryFromJobDescription(jobDescription);
    console.log("Generated summary:", text.substring(0, 100));
    return res.status(200).json({ text });
  } catch (error) {
    console.error("Groq summaryFromJd error:", error.message);
    console.error("Error details:", error);
    return res.status(500).json({
      error: {
        code: "AI_GENERATION_FAILED",
        message: error.message || "Failed to generate summary",
      },
    });
  }
}

module.exports = {
  generate,
  summaryFromJd,
};
