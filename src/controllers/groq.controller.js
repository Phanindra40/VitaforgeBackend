const {
  generateTextFromPrompt,
  generateSummaryFromJobDescription,
} = require("../services/ai.service");

const { env } = require("../config/env");

const {
  getOrSetJson,
  hashPayload,
} = require("../config/cache");

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const MAX_PROMPT_LENGTH = Number(
  env.MAX_PROMPT_LENGTH || 8000
);

const MAX_JOB_DESCRIPTION_LENGTH = Number(
  env.MAX_JOB_DESCRIPTION_LENGTH ||
    12000
);

/* -------------------------------------------------------------------------- */
/*                             RESPONSE HELPERS                               */
/* -------------------------------------------------------------------------- */

function sendError(
  res,
  status,
  code,
  message
) {
  return res.status(status).json({
    success: false,

    error: {
      code,
      message,
    },
  });
}

function sendSuccess(
  res,
  data = {}
) {
  return res.status(200).json({
    success: true,
    ...data,
  });
}

/* -------------------------------------------------------------------------- */
/*                             INPUT SANITIZATION                             */
/* -------------------------------------------------------------------------- */

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\0/g, "")
    .trim();
}

/* -------------------------------------------------------------------------- */
/*                              VALIDATION                                    */
/* -------------------------------------------------------------------------- */

function validatePrompt(prompt) {
  if (!prompt) {
    return "prompt is required";
  }

  if (
    prompt.length >
    MAX_PROMPT_LENGTH
  ) {
    return `prompt must be at most ${MAX_PROMPT_LENGTH} characters`;
  }

  return null;
}

function validateJobDescription(
  jobDescription
) {
  if (!jobDescription) {
    return "jobDescription is required";
  }

  if (
    jobDescription.length >
    MAX_JOB_DESCRIPTION_LENGTH
  ) {
    return `jobDescription must be at most ${MAX_JOB_DESCRIPTION_LENGTH} characters`;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                               LOG HELPERS                                  */
/* -------------------------------------------------------------------------- */

function truncateLog(
  text,
  limit = 120
) {
  if (!text) {
    return "";
  }

  return text.length > limit
    ? `${text.slice(0, limit)}...`
    : text;
}

/* -------------------------------------------------------------------------- */
/*                            GENERATE TEXT                                   */
/* -------------------------------------------------------------------------- */

async function generate(
  req,
  res
) {
  const prompt =
    sanitizeText(
      req.body?.prompt
    );

  const validationError =
    validatePrompt(prompt);

  if (validationError) {
    return sendError(
      res,
      400,
      "INVALID_INPUT",
      validationError
    );
  }

  try {
    const cacheKey = `ai:groq:generate:${hashPayload(
      {
        prompt,
      }
    )}`;

    const payload =
      await getOrSetJson(
        cacheKey,

        async () => {
          console.log(
            "Generating AI text:",
            truncateLog(prompt)
          );

          const text =
            await generateTextFromPrompt(
              prompt
            );

          console.log(
            "AI generation completed"
          );

          return {
            text,

            cached: false,
          };
        },

        env.CACHE_AI_TTL_SECONDS
      );

    return sendSuccess(res, {
      text: payload.text,

      cached:
        payload.cached ?? true,
    });
  } catch (error) {
    console.error(
      "AI generate error:",
      {
        message:
          error.message,

        code:
          error.code,

        status:
          error.status,
      }
    );

    return sendError(
      res,

      error.status || 500,

      error.code ||
        "AI_GENERATION_FAILED",

      error.message ||
        "Failed to generate text"
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                         SUMMARY FROM JOB DESCRIPTION                       */
/* -------------------------------------------------------------------------- */

async function summaryFromJd(
  req,
  res
) {
  const jobDescription =
    sanitizeText(
      req.body
        ?.jobDescription
    );

  const validationError =
    validateJobDescription(
      jobDescription
    );

  if (validationError) {
    return sendError(
      res,
      400,
      "INVALID_INPUT",
      validationError
    );
  }

  try {
    const cacheKey = `ai:groq:summary-from-jd:${hashPayload(
      {
        jobDescription,
      }
    )}`;

    const payload =
      await getOrSetJson(
        cacheKey,

        async () => {
          console.log(
            "Generating JD summary:",
            {
              length:
                jobDescription.length,
            }
          );

          const text =
            await generateSummaryFromJobDescription(
              jobDescription
            );

          console.log(
            "JD summary generated"
          );

          return {
            text,

            cached: false,
          };
        },

        env.CACHE_AI_TTL_SECONDS
      );

    return sendSuccess(res, {
      text: payload.text,

      cached:
        payload.cached ?? true,
    });
  } catch (error) {
    console.error(
      "AI summaryFromJd error:",
      {
        message:
          error.message,

        code:
          error.code,

        status:
          error.status,
      }
    );

    return sendError(
      res,

      error.status || 500,

      error.code ||
        "AI_GENERATION_FAILED",

      error.message ||
        "Failed to generate summary"
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                  EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  generate,

  summaryFromJd,
};