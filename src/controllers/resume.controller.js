const { extractText } = require("../services/parser.service");
const { extractEntities } = require("../services/nlp.service");
const { matchResumeToJob: computeMatchScore } = require("../services/matching.service");
const { calculateATSScore } = require("../services/ats.service");
const { semanticMatchScore } = require("../services/embedding.service");
const { improveResumeText } = require("../services/ai.service");
const { recommendJobsForResume } = require("../services/recommendation.service");
const {
  saveParsedResume,
  createResume,
  listResumes,
  getResumeById,
  updateResumeById,
  replaceResumeById,
  deleteResumeById,
  duplicateResumeById,
} = require("../repositories/resume.repository");

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeResumePayload(body = {}) {
  return {
    userId: body.userId || undefined,
    sourceFileName: body.sourceFileName || body.fileName || "resume.txt",
    rawText: body.rawText || body.text || "Imported via API",
    parsedData: parseMaybeJson(body.parsedData, {}),
    embeddings: Array.isArray(body.embeddings) ? body.embeddings : parseMaybeJson(body.embeddings, []),
    title: body.title,
    role: body.role,
    summary: body.summary,
    skills: parseMaybeJson(body.skills, body.skills || []),
    experience: parseMaybeJson(body.experience, body.experience || []),
    education: parseMaybeJson(body.education, body.education || []),
    contact: parseMaybeJson(body.contact, body.contact || {}),
  };
}

async function uploadResume(req, res, next) {
  try {
    if (!req.file) throw badRequest("Resume file is required");

    const rawText = await extractText(req.file.path, req.file.originalname);
    const parsed = extractEntities(rawText);

    const savedResume = await saveParsedResume({
      userId: req.body.userId,
      sourceFileName: req.file.originalname,
      rawText,
      parsedData: parsed,
    });

    res.status(201).json({
      message: "Resume uploaded and parsed",
      resumeId: savedResume?._id || null,
      rawText,
      parsed,
    });
  } catch (error) {
    next(error);
  }
}

async function getAllResumes(req, res, next) {
  try {
    const resumes = await listResumes();
    return res.status(200).json({ resumes, count: resumes.length });
  } catch (error) {
    next(error);
  }
}

async function getResume(req, res, next) {
  try {
    const resume = await getResumeById(req.params.id);
    if (!resume) throw notFound("Resume not found");
    return res.status(200).json({ resume });
  } catch (error) {
    next(error);
  }
}

async function createNewResume(req, res, next) {
  try {
    const payload = normalizeResumePayload(req.body || {});
    const created = await createResume(payload);
    return res.status(201).json({ resume: created });
  } catch (error) {
    next(error);
  }
}

async function patchResume(req, res, next) {
  try {
    const updated = await updateResumeById(req.params.id, normalizeResumePayload(req.body || {}));
    if (!updated) throw notFound("Resume not found");
    return res.status(200).json({ resume: updated });
  } catch (error) {
    next(error);
  }
}

async function putResume(req, res, next) {
  try {
    const updated = await replaceResumeById(req.params.id, normalizeResumePayload(req.body || {}));
    if (!updated) throw notFound("Resume not found");
    return res.status(200).json({ resume: updated });
  } catch (error) {
    next(error);
  }
}

async function removeResume(req, res, next) {
  try {
    const deleted = await deleteResumeById(req.params.id);
    if (!deleted) throw notFound("Resume not found");
    return res.status(200).json({ deleted: true, resume: deleted });
  } catch (error) {
    next(error);
  }
}

async function duplicateResume(req, res, next) {
  try {
    const duplicated = await duplicateResumeById(req.params.id);
    if (!duplicated) throw notFound("Resume not found");
    return res.status(201).json({ resume: duplicated });
  } catch (error) {
    next(error);
  }
}

async function matchResumeToJob(req, res, next) {
  try {
    const { resumeText, jobText } = req.body;
    if (!resumeText || !jobText) throw badRequest("resumeText and jobText are required");

    const tfidfScore = computeMatchScore(resumeText, jobText);
    res.json({ tfidfScore });
  } catch (error) {
    next(error);
  }
}

async function calculateAtsScore(req, res, next) {
  try {
    const { parsedData, resumeText, jobText } = req.body;
    if (!jobText) throw badRequest("jobText is required");

    const parsed = parsedData || (resumeText ? extractEntities(resumeText) : null);
    if (!parsed) throw badRequest("Provide parsedData or resumeText");

    const ats = calculateATSScore(parsed, jobText);
    res.json(ats);
  } catch (error) {
    next(error);
  }
}

async function semanticMatch(req, res, next) {
  try {
    const { resumeText, jobText } = req.body;
    if (!resumeText || !jobText) throw badRequest("resumeText and jobText are required");

    const semanticScore = await semanticMatchScore(resumeText, jobText);
    res.json({ semanticScore });
  } catch (error) {
    next(error);
  }
}

async function improveResume(req, res, next) {
  try {
    const { text } = req.body;
    if (!text) throw badRequest("text is required");

    const improved = await improveResumeText(text);
    res.json({ improved });
  } catch (error) {
    next(error);
  }
}

async function recommendJobs(req, res, next) {
  try {
    const { resumeText, limit = 5 } = req.body;
    if (!resumeText) throw badRequest("resumeText is required");

    const recommendations = await recommendJobsForResume(resumeText, Number(limit));
    res.json({ recommendations });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAllResumes,
  getResume,
  createNewResume,
  patchResume,
  putResume,
  removeResume,
  duplicateResume,
  uploadResume,
  matchResumeToJob,
  calculateAtsScore,
  semanticMatch,
  improveResume,
  recommendJobs,
};
