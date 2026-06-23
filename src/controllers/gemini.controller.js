const fs = require("fs/promises");

const { env } = require("../config/env");
const { getOrSetJson, hashPayload } = require("../config/cache");
const { analyzeAts, extractOcrText, summarizeText } = require("../services/gemini.service");

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

function parseMaybeJson(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function normalizeList(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = sanitizeText(String(value || ""));

    if (!text) {
      continue;
    }

    const key = text.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(text);

    if (Number.isFinite(limit) && result.length >= limit) {
      break;
    }
  }

  return result;
}

function normalizePercent(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric <= 1) {
    return numeric * 100;
  }

  return numeric;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function averageNumbers(values) {
  const numericValues = values.filter((value) => Number.isFinite(value));

  if (!numericValues.length) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function joinReadable(values) {
  if (!values.length) {
    return "";
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function formatPercent(value) {
  const rounded = Math.round(value);
  return `${rounded}%`;
}

function formatCountLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toSentenceCase(value) {
  const text = sanitizeText(value);

  if (!text) {
    return "";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildAtsResponse(jobDescription, resumeText, analysisContext, rawAnalysis) {
  const context = analysisContext && typeof analysisContext === "object" ? analysisContext : {};

  const matchedKeywords = normalizeList(
    context.matchedKeywords?.length ? context.matchedKeywords : rawAnalysis.matchedKeywords,
    6
  );
  const missingKeywords = normalizeList(
    context.missingKeywords?.length ? context.missingKeywords : rawAnalysis.missingKeywords,
    6
  );
  const matchedSkills = normalizeList(context.matchedSkills, 6);
  const missingSkills = normalizeList(context.missingSkills, 6);
  const topKeywords = normalizeList(context.topKeywords, 4);
  const jdSkills = normalizeList(context.jdSkills, 4);
  const resumeSkills = normalizeList(context.resumeSkills, 4);
  const missingContactFields = normalizeList(context.missingContactFields, 4);
  const quickRecommendations = Array.isArray(context.quickRecommendations)
    ? context.quickRecommendations
        .map((item) => {
          if (!item || typeof item !== "object") {
            return sanitizeText(String(item || ""));
          }

          const label = sanitizeText(item.label || item.title || "");
          const detail = sanitizeText(item.detail || item.description || "");

          if (label && detail) {
            return `${label}: ${detail}`;
          }

          return label || detail;
        })
        .filter(Boolean)
    : [];

  const targetRole = sanitizeText(context.roleHint) || rawAnalysis.targetRole || "the target role";

  const coverageValues = [
    normalizePercent(context.keywordCoverage),
    normalizePercent(context.skillCoverage),
    normalizePercent(context.sectionCoverage),
  ].filter(Number.isFinite);

  const averageCoverage = averageNumbers(coverageValues);

  let score = Number.isFinite(rawAnalysis.score) ? rawAnalysis.score : 0;

  if (Number.isFinite(averageCoverage)) {
    score = Math.round(score * 0.4 + averageCoverage * 0.6);
  }

  score = clampNumber(score, 0, 100);

  const confidenceBase = [
    score * 0.55,
    Number.isFinite(averageCoverage) ? averageCoverage * 0.25 : 0,
    context.contactPresent ? 5 : 0,
    Number.isFinite(Number(context.resumeWordCount)) && Number(context.resumeWordCount) >= 400 ? 4 : 0,
    Number.isFinite(Number(context.actionVerbCount)) && Number(context.actionVerbCount) >= 8 ? 3 : 0,
    Number.isFinite(Number(context.metricCount)) && Number(context.metricCount) >= 3 ? 3 : 0,
    Number.isFinite(Number(context.bulletCount)) && Number(context.bulletCount) >= 8 ? 2 : 0,
    !missingKeywords.length ? 4 : 0,
    !missingSkills.length ? 2 : 0,
  ].reduce((sum, value) => sum + value, 0);

  const confidence = rawAnalysis.isAi
    ? clampNumber(
        rawAnalysis.confidence !== null && rawAnalysis.confidence !== undefined
          ? rawAnalysis.confidence
          : Math.round(confidenceBase),
        0,
        100
      )
    : null;

  if (rawAnalysis.isAi) {
    return {
      analysis: {
        headline: rawAnalysis.headline || (score >= 75 ? `Good potential for ${targetRole}` : `Needs refinement for ${targetRole}`),
        summary: rawAnalysis.summary || (score >= 75 ? `Resume aligns well with ${targetRole} requirements.` : `Resume requires optimization for ${targetRole}.`),
        score: score,
        confidence: confidence,
        targetRole: targetRole,
        strengths: rawAnalysis.strengths?.length ? rawAnalysis.strengths : ["Sufficient keyword presence"],
        gaps: rawAnalysis.gaps?.length ? rawAnalysis.gaps : ["None detected"],
        matchedKeywords: rawAnalysis.matchedKeywords,
        missingKeywords: rawAnalysis.missingKeywords,
        recommendations: rawAnalysis.recommendations?.length ? rawAnalysis.recommendations : ["Continue optimization"],
        actionPlan: rawAnalysis.actionPlan?.length ? rawAnalysis.actionPlan : ["Refine key resume bullets"],
        rewrittenSummary: rawAnalysis.rewrittenSummary,
        rewriteBullets: rawAnalysis.rewriteBullets,
      },
    };
  }

  const strengths = [];

  if (matchedKeywords.length) {
    strengths.push(`Strong keyword alignment around ${joinReadable(matchedKeywords.slice(0, 3))}`);
  }

  if (matchedSkills.length) {
    strengths.push(`Matched skills include ${joinReadable(matchedSkills.slice(0, 3))}`);
  }

  if (Number.isFinite(Number(context.metricCount)) && Number(context.metricCount) > 0) {
    strengths.push(`Contains ${formatCountLabel(Number(context.metricCount), "quantified signal", "quantified signals")}`);
  }

  if (context.contactPresent) {
    strengths.push("Contact details are present");
  }

  if (Number.isFinite(Number(context.sectionCoverage)) && Number(context.sectionCoverage) >= 0.75) {
    strengths.push("Resume structure covers the core sections");
  }

  if (!strengths.length) {
    strengths.push(rawAnalysis.summary || "Resume has enough signal for a first-pass ATS review");
  }

  const gaps = [];

  if (missingKeywords.length) {
    gaps.push(`Missing keywords such as ${joinReadable(missingKeywords.slice(0, 3))}`);
  }

  if (missingSkills.length) {
    gaps.push(`Skills to add or clarify: ${joinReadable(missingSkills.slice(0, 3))}`);
  }

  if (missingContactFields.length) {
    gaps.push(`Contact fields missing: ${joinReadable(missingContactFields)}`);
  }

  if (Number.isFinite(Number(context.sectionCoverage)) && Number(context.sectionCoverage) < 0.75) {
    gaps.push("Section coverage should be expanded for a stronger ATS match");
  }

  if (Number.isFinite(Number(context.bulletCount)) && Number(context.bulletCount) < 8) {
    gaps.push("Add more achievement bullets with measurable outcomes");
  }

  if (!gaps.length) {
    gaps.push("No major keyword or structural gaps detected from the supplied context");
  }

  const recommendations = [
    ...quickRecommendations,
    ...(rawAnalysis.suggestions || []),
  ].filter(Boolean);

  if (!recommendations.length) {
    recommendations.push("Tailor the resume more closely to the target role and job description");
  }

  const actionPlan = [];

  const standardLabels = {
    summary: "Summary",
    experience: "Experience",
    skills: "Skills",
    education: "Education",
    projects: "Projects",
    certifications: "Certifications"
  };

  const signals = Array.isArray(context.sectionSignals) ? context.sectionSignals : [];

  // Check for missing priority sections
  const requiredPriorityKeys = ["experience", "skills", "education"];
  requiredPriorityKeys.forEach((key) => {
    const sec = signals.find((s) => s.key === key);
    if (!sec || !sec.present) {
      const label = standardLabels[key] || key;
      actionPlan.push(`Create a dedicated standard '${label}' section to ensure ATS scanners can find your background`);
    }
  });

  // Check for present sections with non-standard names
  signals.forEach((sec) => {
    if (sec.present && sec.isStandard === false && sec.matchedLine) {
      const label = standardLabels[sec.key] || sec.key;
      actionPlan.push(`Rename section '${sec.matchedLine}' to standard '${label}' heading to optimize parser readability`);
    }
  });

  if (Number.isFinite(Number(context.sectionCoverage)) && Number(context.sectionCoverage) < 0.75 && actionPlan.length === 0) {
    actionPlan.push("Reorder and expand the resume sections so the core experience and skills are immediately visible");
  }

  if (missingKeywords.length || missingSkills.length) {
    const missingTerms = joinReadable([].concat(missingKeywords.slice(0, 3), missingSkills.slice(0, 2)).filter(Boolean));

    actionPlan.push(
      missingTerms
        ? `Mirror ${missingTerms} naturally in summary, skills, and experience`
        : "Mirror the highest priority JD terms naturally in summary, skills, and experience"
    );
  }

  actionPlan.push(`Add 2 quantified bullets that reinforce ${targetRole}`);

  if (missingContactFields.length) {
    actionPlan.push(`Add the missing contact fields: ${joinReadable(missingContactFields)}`);
  }

  if (Number.isFinite(Number(context.metricCount)) && Number(context.metricCount) < 3) {
    actionPlan.push("Increase measurable impact by adding more metrics to recent bullets");
  }

  const rewrittenSummary = toSentenceCase(
    `${targetRole} with ${joinReadable(matchedKeywords.slice(0, 3)) || "solid project experience"} and measurable impact, while building stronger coverage in ${joinReadable(missingKeywords.slice(0, 3)) || "the remaining JD priorities"}.`
  );

  const primaryMatched = matchedKeywords[0] || matchedSkills[0] || topKeywords[0] || jdSkills[0] || "core resume work";
  const secondaryMatched = matchedKeywords[1] || matchedSkills[1] || resumeSkills[0] || "cross-functional delivery";
  const primaryMissing = missingKeywords[0] || missingSkills[0] || topKeywords[0] || "key job requirements";

  const rewriteBullets = [
    `${toSentenceCase(`built ${primaryMatched} solutions that delivered measurable impact for the ${targetRole} scope`)}`,
    `${toSentenceCase(`improved execution by pairing ${secondaryMatched} with quantified outcomes and ${primaryMissing} coverage`)}`,
  ];

  const summary =
    score >= 75
      ? `Resume aligns well with ${targetRole} requirements, with strong signal in ${joinReadable(matchedKeywords.slice(0, 3)) || "the supplied context"}.`
      : `Resume aligns with core ${targetRole} requirements but still needs stronger coverage in ${joinReadable(missingKeywords.slice(0, 3)) || "the remaining keywords"}.`;

  return {
    analysis: {
      headline:
        score >= 75
          ? `Good potential for ${targetRole}`
          : score >= 60
            ? `Promising fit for ${targetRole}`
            : `Needs refinement for ${targetRole}`,
      summary,
      score,
      confidence,
      targetRole,
      strengths,
      gaps,
      matchedKeywords,
      missingKeywords,
      recommendations,
      actionPlan,
      rewrittenSummary,
      rewriteBullets,
    },
  };
}

function normalizeUploadedFile(file, body) {
  if (!file) {
    return null;
  }

  const fileName = sanitizeText(body?.fileName || body?.filename || "");
  const mimeType = sanitizeText(body?.mimeType || body?.mimetype || "");

  return {
    ...file,
    ...(fileName ? { originalname: fileName } : {}),
    ...(mimeType ? { mimetype: mimeType } : {}),
  };
}

function getSummaryText(body) {
  return sanitizeText(body?.text || body?.input || body?.content || "");
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
  const analysisContext = parseMaybeJson(req.body?.analysisContext);
  const responseFormat = sanitizeText(req.body?.responseFormat);
  const requestType = sanitizeText(req.body?.requestType);

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
    const cacheKey = `ai:gemini:ats-analyze:${hashPayload({
      jobDescription,
      resumeText,
      analysisContext,
      responseFormat,
      requestType,
    })}`;
    const analysis = await getOrSetJson(
      cacheKey,
      async () => {
        const rawAnalysis = await analyzeAts(jobDescription, resumeText);
        return buildAtsResponse(jobDescription, resumeText, analysisContext, rawAnalysis);
      },
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

async function ocrSummary(req, res) {
  const text = getSummaryText(req.body);

  if (!text) {
    return sendInvalidInput(res, "text is required");
  }

  if (text.length > 20000) {
    return sendInvalidInput(res, "text must be at most 20000 characters");
  }

  try {
    const cacheKey = `ai:gemini:ocr-summary:${hashPayload({ text })}`;
    const result = await getOrSetJson(
      cacheKey,
      async () => summarizeText(text),
      env.CACHE_AI_TTL_SECONDS
    );

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: {
        code: error.code || "SUMMARY_GENERATION_FAILED",
        message: error.message || "Failed to summarize text",
      },
    });
  }
}

async function ocrExtract(req, res) {
  const mode = sanitizeText(req.body?.mode) || "ocr";
  const language = sanitizeText(req.body?.language) || "en";
  const uploadedFile = normalizeUploadedFile(getUploadedFile(req), req.body);

  if (mode !== "ocr" && mode !== "ocr-summary") {
    return sendInvalidInput(res, "mode must be either 'ocr' or 'ocr-summary'");
  }

  if (!uploadedFile) {
    return sendInvalidInput(res, "A file is required in one of these fields: file, document, resume");
  }

  try {
    const result = await extractOcrText(uploadedFile, { mode, language });
    return res.status(200).json({ text: sanitizeText(result?.text) });
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
  ocrSummary,
};