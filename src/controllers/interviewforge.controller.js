const crypto = require("crypto");

const fs = require("fs/promises");
const path = require("path");

const { env } = require("../config/env");
const { extractText } = require("../services/parser.service");
const { extractEntities } = require("../services/nlp.service");
const { generateTextFromPrompt } = require("../services/ai.service");
const { recommendJobsForResume } = require("../services/recommendation.service");
const { saveParsedResume, getResumeById } = require("../repositories/resume.repository");

const parseSessions = new Map();
const questionSessions = new Map();
const mockSessions = new Map();
const jobStore = new Map();
const preferenceStore = new Map();
const conversationStore = new Map();
const bookmarkStore = new Map();

const DEFAULT_PREFERENCES = {
  interviewType: "technical",
  difficulty: "medium",
  maxQuestions: 10,
  premium: false,
  targetRole: "",
  targetCompanies: [],
};

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "INVALID_INPUT";
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  error.code = "NOT_FOUND";
  return error;
}

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").trim();
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => sanitizeText(String(item))).filter(Boolean);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function safeJsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sessionId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizePreferences(input = {}) {
  return {
    interviewType: ["technical", "behavioral", "system-design"].includes(input.interviewType)
      ? input.interviewType
      : DEFAULT_PREFERENCES.interviewType,
    difficulty: ["easy", "medium", "hard"].includes(input.difficulty)
      ? input.difficulty
      : DEFAULT_PREFERENCES.difficulty,
    maxQuestions: clampNumber(input.maxQuestions, 1, 20, DEFAULT_PREFERENCES.maxQuestions),
    premium: Boolean(input.premium),
    targetRole: sanitizeText(input.targetRole),
    targetCompanies: toStringArray(input.targetCompanies).slice(0, 10),
  };
}

function getResumeIdentity(req) {
  return req.auth?.userId || req.auth?.sub || req.auth?.identity || "development";
}

function getAuthScopes(req) {
  return Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
}

function hasScope(req, scope) {
  return getAuthScopes(req).includes(scope);
}

function requirePremiumScope(req) {
  if (!hasScope(req, "premium")) {
    throw forbidden("Premium scope is required");
  }
}

function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  error.code = "FORBIDDEN";
  return error;
}

function buildStorageUrl(req, fileName) {
  const host = req.get("host");
  if (!host) {
    return `/uploads/${encodeURIComponent(fileName)}`;
  }

  return `${req.protocol}://${host}/uploads/${encodeURIComponent(fileName)}`;
}

function buildQuestion(questionText, preference, skill, index) {
  const tags = [
    ...(skill ? [skill.toLowerCase()] : []),
    preference.interviewType,
  ];

  return {
    id: `q${index + 1}`,
    question: questionText,
    rubric: preference.premium
      ? `Look for structure, correctness, tradeoff awareness, and concrete examples. Focus on ${preference.interviewType} depth for the target role.`
      : undefined,
    tags: [...new Set(tags.filter(Boolean))],
    difficulty: preference.difficulty,
  };
}

async function resolveResumeText(resumeId) {
  if (!resumeId) return null;

  const cached = parseSessions.get(resumeId);
  if (cached?.text) {
    return cached.text;
  }

  try {
    const record = await getResumeById(resumeId);
    return record?.rawText || record?.text || "";
  } catch (error) {
    if (error.status === 503) {
      return null;
    }

    throw error;
  }
}

function resolveOwnerId(req) {
  return req.auth?.userId || req.auth?.sub || req.auth?.identity || null;
}

function getSessionById(sessionId) {
  return questionSessions.get(sessionId) || null;
}

function isSessionOwner(req, session) {
  const ownerId = resolveOwnerId(req);
  return !session?.ownerId || !ownerId || session.ownerId === ownerId;
}

function buildSummary(parsed, resumeText) {
  const skills = parsed.skills || [];
  const experienceSummary = parsed.summary || parsed.experienceSummary || "";

  if (experienceSummary) {
    return experienceSummary;
  }

  if (skills.length) {
    return `Resume highlights ${skills.slice(0, 5).join(", ")} with ${resumeText.split(/\s+/).filter(Boolean).length} words of source text.`;
  }

  return `Resume text provided with ${resumeText.length} characters.`;
}

function buildQuestionText({ interviewType, difficulty, targetRole, skill, company, index }) {
  const rolePart = targetRole ? `for ${targetRole}` : "for the role";
  const companyPart = company ? `at ${company}` : "";
  const base = `${index + 1}. ${interviewType} question ${rolePart} ${companyPart}`.replace(/\s+/g, " ").trim();
  const difficultyNote = difficulty === "hard" ? "dig into tradeoffs and edge cases" : difficulty === "easy" ? "keep the answer focused and clear" : "balance depth and clarity";

  if (skill) {
    return `${base}: explain how you would use ${skill} in a real project and ${difficultyNote}.`;
  }

  if (interviewType === "behavioral") {
    return `${base}: describe a past situation where you had to resolve ambiguity and ${difficultyNote}.`;
  }

  if (interviewType === "system-design") {
    return `${base}: design a production-ready solution and ${difficultyNote}.`;
  }

  return `${base}: walk through your approach and ${difficultyNote}.`;
}

function buildRubric(question, preferences) {
  if (!preferences.premium) return undefined;

  return question.toLowerCase().includes("system")
    ? "Evaluate architecture, scalability, and failure handling."
    : preferences.interviewType === "behavioral"
      ? "Evaluate ownership, communication, and impact."
      : "Evaluate implementation detail, correctness, and reasoning.";
}

function buildQuestions(profile, preferences) {
  const skills = profile.skills || [];
  const companies = preferences.targetCompanies.length ? preferences.targetCompanies : [""];
  const questions = [];

  for (let index = 0; index < preferences.maxQuestions; index++) {
    const skill = skills[index % Math.max(1, skills.length)] || "";
    const company = companies[index % companies.length] || "";
    const question = buildQuestionText({
      interviewType: preferences.interviewType,
      difficulty: preferences.difficulty,
      targetRole: preferences.targetRole,
      skill,
      company,
      index,
    });

    questions.push({
      id: `q${index + 1}`,
      question,
      rubric: buildRubric(question, preferences),
      tags: [
        ...(skill ? [skill.toLowerCase()] : []),
        preferences.interviewType,
      ],
      difficulty: preferences.difficulty,
    });
  }

  return questions;
}

function scoreAnswer(answerText, questionText, resumeText) {
  const answer = sanitizeText(answerText);
  const question = sanitizeText(questionText).toLowerCase();
  const resume = sanitizeText(resumeText).toLowerCase();
  const answerLower = answer.toLowerCase();

  let score = 30;

  if (answer.length > 80) score += 20;
  if (answer.length > 200) score += 10;
  if (/\b(example|for example|specifically|led|built|designed|implemented)\b/i.test(answer)) score += 15;

  const questionKeywords = extractEntities(questionText).skills || [];
  for (const keyword of questionKeywords.slice(0, 5)) {
    if (answerLower.includes(keyword.toLowerCase())) score += 5;
    if (resume.includes(keyword.toLowerCase())) score += 2;
  }

  if (question.includes("behavioral") && /(conflict|team|collaborat|stakeholder|communication)/i.test(answer)) {
    score += 10;
  }

  if (question.includes("system") && /(scale|latency|tradeoff|cache|availability|reliability)/i.test(answer)) {
    score += 10;
  }

  if (answer.length < 20) score -= 15;

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    shortFeedback:
      score >= 80
        ? "Strong answer with clear technical depth."
        : score >= 60
          ? "Solid answer. Add more concrete examples and tradeoffs."
          : "Answer needs more structure, examples, and role-specific detail.",
    strengths:
      score >= 60 ? ["clear intent", "relevant detail"] : ["attempted response"],
    improvements: [
      "add a concrete example",
      "explain the tradeoff or decision",
      "tie the answer back to the target role",
    ],
  };
}

function getSessionSnapshot(sessionIdValue) {
  return questionSessions.get(sessionIdValue) || null;
}

async function resolveGenerationInput(body = {}) {
  const resumeText = sanitizeText(body.resumeText);
  const resumeId = sanitizeText(body.resumeId);
  const skills = Array.isArray(body.skills) ? body.skills.map((skill) => sanitizeText(String(skill))).filter(Boolean) : [];
  const experienceSummary = sanitizeText(body.experienceSummary);
  const targetRole = sanitizeText(body.targetRole);
  const targetCompanies = Array.isArray(body.targetCompanies)
    ? body.targetCompanies.map((company) => sanitizeText(String(company))).filter(Boolean)
    : [];

  let resolvedResumeText = resumeText;
  let resolvedResumeId = resumeId || null;

  if (!resolvedResumeText && resolvedResumeId) {
    resolvedResumeText = await resolveResumeText(resolvedResumeId);

    if (!resolvedResumeText) {
      throw notFound("Resume not found");
    }
  }

  if (!resolvedResumeText && !resolvedResumeId) {
    throw badRequest("resumeText or resumeId is required");
  }

  const inferredSkills = skills.length ? skills : (extractEntities(resolvedResumeText || "").skills || []);
  const preferences = normalizePreferences({
    interviewType: body.interviewType,
    difficulty: body.difficulty,
    maxQuestions: body.maxQuestions,
    premium: body.premium,
    targetRole,
    targetCompanies,
  });

  return {
    resumeId: resolvedResumeId,
    resumeText: resolvedResumeText,
    skills: inferredSkills,
    experienceSummary,
    targetRole,
    targetCompanies,
    preferences,
  };
}

function saveQuestionSession({ ownerId, resumeId, profile, preferences, questions, jobId }) {
  const sessionIdValue = sessionId("sess");
  const session = {
    sessionId: sessionIdValue,
    ownerId,
    resumeId,
    profile,
    preferences,
    questions,
    generatedAt: new Date().toISOString(),
    jobId: jobId || null,
    bookmarks: new Set(),
  };

  questionSessions.set(sessionIdValue, session);
  return session;
}

async function buildGenerationResult(req, body = {}) {
  const input = await resolveGenerationInput(body);

  if (input.preferences.premium) {
    requirePremiumScope(req);
  }

  const profile = {
    resumeText: input.resumeText,
    skills: input.skills,
    experienceSummary: input.experienceSummary,
  };

  const questions = buildQuestions(profile, input.preferences);
  const session = saveQuestionSession({
    ownerId: resolveOwnerId(req),
    resumeId: input.resumeId,
    profile,
    preferences: input.preferences,
    questions,
    jobId: body.jobId,
  });

  return { session, questions };
}

async function createAsyncJob(req, body = {}) {
  const jobId = sessionId("job");
  const job = {
    jobId,
    ownerId: resolveOwnerId(req),
    scopes: getAuthScopes(req),
    status: "pending",
    sessionId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: safeJsonClone(body),
  };

  jobStore.set(jobId, job);
  setImmediate(() => {
    void runAsyncJob(jobId);
  });

  return job;
}

async function runAsyncJob(jobId) {
  const job = jobStore.get(jobId);
  if (!job) return;

  job.status = "running";
  job.updatedAt = new Date().toISOString();

  try {
    const fakeReq = { auth: { userId: job.ownerId, scopes: job.scopes || [] } };
    const result = await buildGenerationResult(fakeReq, {
      ...job.payload,
      jobId,
    });

    job.status = "complete";
    job.sessionId = result.session.sessionId;
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error = {
      code: error.code || "GENERATION_FAILED",
      message: error.message || "Failed to generate questions",
    };
    job.updatedAt = new Date().toISOString();
  }
}

function makeEvaluation(questionText, answerText, resumeText) {
  const scored = scoreAnswer(answerText, questionText, resumeText);
  return {
    score: scored.score,
    strengths: scored.strengths,
    improvements: scored.improvements,
    note: scored.shortFeedback || scored.note,
  };
}

async function uploadResume(req, res, next) {
  try {
    if (!req.file) {
      throw badRequest("file is required");
    }

    const text = await extractText(req.file.path, req.file.originalname);
    const parsed = extractEntities(text);
    const savedResume = await saveParsedResume({
      userId: getResumeIdentity(req),
      sourceFileName: req.file.originalname,
      rawText: text,
      parsedData: parsed,
    });

    const id = savedResume?._id?.toString() || sessionId("resume");
    parseSessions.set(id, {
      id,
      text,
      parsed,
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });

    res.status(201).json({
      id,
      text,
      pages: Math.max(1, Math.ceil(text.length / 2500)),
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }

    const tempResumeId = sessionId("resume");
    const storageUrl = buildStorageUrl(req, path.basename(req.file.path));

    parseSessions.set(tempResumeId, {
      id: tempResumeId,
      text: rawText,
      parsed,
      ownerId: resolveOwnerId(req),
      storageUrl,
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });

    let resumeId = tempResumeId;

    try {
      const savedResume = await saveParsedResume({
        userId: req.body.userId,
        sourceFileName: req.file.originalname,
        rawText,
        parsedData: parsed,
      });

      if (savedResume?._id) {
        resumeId = String(savedResume._id);
        parseSessions.set(resumeId, {
          ...parseSessions.get(tempResumeId),
          id: resumeId,
        });
        parseSessions.delete(tempResumeId);
      }
    } catch (saveError) {
      if (saveError.status !== 503) {
        throw saveError;
      }
    }

    res.status(200).json({
      resumeId,
      textSnippet: rawText.slice(0, 200),
      storageUrl,
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
      },
      id: parseId,
      text,
      parsed,
  }
    });

    res.status(200).json({
      id: parseId,
      summary,
      skills: parsed.skills || [],
      experienceSummary: parsed.experienceSummary || parsed.summary || "",
    });
  } catch (error) {
    next(error);
  }
}

async function generateQuestions(req, res, next) {
  try {
    const resumeText = sanitizeText(req.body?.resumeText);
    const parsedSkills = toStringArray(req.body?.skills);
    const experienceSummary = sanitizeText(req.body?.experienceSummary);
    const targetRole = sanitizeText(req.body?.targetRole);
    const targetCompanies = toStringArray(req.body?.targetCompanies);
    const preferences = normalizePreferences({
      interviewType: req.body?.interviewType,
      difficulty: req.body?.difficulty,
      maxQuestions: req.body?.maxQuestions,
      premium: req.body?.premium,
      targetRole,
      targetCompanies,
    });

    if (!resumeText && !parsedSkills.length && !experienceSummary) {
      throw badRequest("resumeText, skills, or experienceSummary is required");
    }

    const profile = {
      resumeText,
      skills: parsedSkills.length ? parsedSkills : extractEntities(resumeText).skills || [],
      experienceSummary,
    };

    const questions = buildQuestions(profile, preferences);
    const sessionIdValue = sessionId("session");

    questionSessions.set(sessionIdValue, {
      sessionId: sessionIdValue,
      preferences,
      profile,
      questions,
      generatedAt: new Date().toISOString(),
      bookmarks: new Set(),
    });

    res.status(201).json({
      sessionId: sessionIdValue,
      questions,
      meta: {
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
        const parseId = sessionId("parse");
    next(error);
  }
          parseId,
          summary: buildSummary(parsed, text),
          skills: parsed.skills || [],
          experienceSummary: parsed.experienceSummary || parsed.summary || "",
async function getQuestions(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.params.sessionId);
    const session = getSessionSnapshot(sessionIdValue);

    if (!session) {
      throw notFound("Session not found");
    }

    res.json({
      sessionId: session.sessionId,
      questions: session.questions,
      status: "ready",
    });
  } catch (error) {
    next(error);
  }
}

async function startMock(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.body?.sessionId);
    const userId = sanitizeText(req.body?.userId) || getResumeIdentity(req);
    const preferences = normalizePreferences(req.body?.preferences || req.body || {});

    let sourceSession = sessionIdValue ? getSessionSnapshot(sessionIdValue) : null;

    if (!sourceSession) {
      const questions = buildQuestions({
        resumeText: "",
        skills: [],
        experienceSummary: "",
      }, preferences);

      sourceSession = {
        sessionId: sessionIdValue || sessionId("session"),
        preferences,
        profile: {
          resumeText: "",
          skills: [],
          experienceSummary: "",
        },
        questions,
      };
    }

    const mockId = sessionId("mock");
    mockSessions.set(mockId, {
      mockId,
      userId,
      sessionId: sourceSession.sessionId,
      preferences: sourceSession.preferences || preferences,
      questions: sourceSession.questions || [],
      index: 0,
      answers: [],
      finished: false,
    });

    const mock = mockSessions.get(mockId);

    res.status(201).json({
      mockId,
      currentQuestion: mock.questions[0] || null,
      remaining: Math.max(0, mock.questions.length - 1),
    });
  } catch (error) {
    next(error);
  }
}

async function answerMock(req, res, next) {
  try {
    const mockId = sanitizeText(req.params.mockId);
    const questionId = sanitizeText(req.body?.questionId);
    const answerText = sanitizeText(req.body?.answerText);
    const elapsedMs = clampNumber(req.body?.elapsedMs, 0, Number.MAX_SAFE_INTEGER, 0);

    const mock = mockSessions.get(mockId);

    if (!mock) {
      throw notFound("Mock session not found");
    }

    const currentQuestion = mock.questions[mock.index];

    if (!currentQuestion) {
      mock.finished = true;
      return res.json({ finished: true });
    }

    if (questionId && currentQuestion.id !== questionId) {
      throw badRequest("questionId does not match the current question");
    }

    const evaluation = scoreAnswer(answerText, currentQuestion.question, mock.profile?.resumeText || "");

    mock.answers.push({
      questionId: currentQuestion.id,
      answerText,
      elapsedMs,
      evaluation,
    });

    mock.index += 1;
    const nextQuestion = mock.questions[mock.index] || null;
    mock.finished = !nextQuestion;

    res.json({
      nextQuestion,
      evaluation: {
        score: evaluation.score,
        shortFeedback: evaluation.shortFeedback,
        rubric: mock.preferences.premium ? currentQuestion.rubric : undefined,
      },
      finished: mock.finished,
    });
  } catch (error) {
    next(error);
  }
}

async function evaluateSingle(req, res, next) {
  try {
    const answerText = sanitizeText(req.body?.answerText);
    const questionText = sanitizeText(req.body?.questionText || req.body?.questionId);
    const resumeText = sanitizeText(req.body?.resumeText);

    if (!answerText) {
      throw badRequest("answerText is required");
    }

    if (!questionText && !resumeText) {
      throw badRequest("questionText, questionId, or resumeText is required");
    }

    const evaluation = scoreAnswer(answerText, questionText || answerText, resumeText);

    res.json({
      score: evaluation.score,
      strengths: evaluation.strengths,
      improvements: evaluation.improvements,
      detailedFeedback: evaluation.shortFeedback,
    });
  } catch (error) {
    next(error);
  }
}

async function chat(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.body?.sessionId);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const context = req.body?.context || {};

    if (!messages.length) {
      throw badRequest("messages is required");
    }

    const lastMessage = [...messages].reverse().find((message) => sanitizeText(message?.content));
    const userMessage = sanitizeText(lastMessage?.content);

    const fallbackReply = userMessage
      ? `Focus on one clear example, explain the outcome, and connect it to ${sanitizeText(context?.preferences?.targetRole) || "the target role"}.`
      : "Share a specific question or answer so I can help improve it.";

    let reply = fallbackReply;

    if (env.GROQ_API_KEY) {
      try {
        reply = await generateTextFromPrompt(
          `You are an interview coach. Respond in 3-5 concise sentences. Context: ${JSON.stringify(context)}. Conversation: ${JSON.stringify(messages)}`
        );
      } catch (_error) {
        reply = fallbackReply;
      }
    }

    const conversationId = sessionIdValue || sessionId("conversation");
    conversationStore.set(conversationId, {
      conversationId,
      messages,
      context,
      reply,
      updatedAt: new Date().toISOString(),
    });

    res.json({
      reply,
      conversationId,
      usage: env.GROQ_API_KEY
        ? {
            tokens: Math.max(1, Math.ceil((userMessage.length + reply.length) / 4)),
          }
        : undefined,
    });
  } catch (error) {
    next(error);
  }
}

async function getPreferences(req, res, next) {
  try {
    const key = getResumeIdentity(req);
    const preferences = preferenceStore.get(key) || DEFAULT_PREFERENCES;
    res.json(preferences);
  } catch (error) {
    next(error);
  }
}

async function savePreferences(req, res, next) {
  try {
    const key = getResumeIdentity(req);
    const preferences = normalizePreferences(req.body || {});
    preferenceStore.set(key, preferences);
    res.json(preferences);
  } catch (error) {
    next(error);
  }
}

async function insights(req, res, next) {
  try {
    const resumeText = sanitizeText(req.body?.resumeText || "");
    const resumeId = sanitizeText(req.query?.resumeId || req.body?.resumeId || "");

    let resolvedText = resumeText;

    if (!resolvedText && resumeId) {
      const cached = parseSessions.get(resumeId);
      if (cached?.text) {
        const result = await buildGenerationResult(req, req.body || {});
    const questionId = sanitizeText(req.body?.questionId);
    const session = getSessionSnapshot(sessionIdValue);
          sessionId: result.session.sessionId,
          questions: result.questions,
      throw notFound("Session not found");
            generatedAt: result.session.generatedAt,

    if (!questionId) {
      throw badRequest("questionId is required");
    }

    if (!bookmarkStore.has(sessionIdValue)) {

    async function generateQuestionsAsync(req, res, next) {
      try {
        await resolveGenerationInput(req.body || {});
        if (normalizePreferences(req.body || {}).premium) {
          requirePremiumScope(req);
        }

        const job = await createAsyncJob(req, req.body || {});

        res.status(202).json({
          jobId: job.jobId,
          sessionId: null,
          status: job.status,
        });
      } catch (error) {
        next(error);
      }
    }

    async function getJobStatus(req, res, next) {
      try {
        const jobId = sanitizeText(req.params.jobId);
        const job = jobStore.get(jobId);

        if (!job) {
          throw notFound("Job not found");
        }

        if (job.ownerId && resolveOwnerId(req) && job.ownerId !== resolveOwnerId(req)) {
          throw forbidden("You do not own this job");
        }

        res.json({
          jobId: job.jobId,
          status: job.status,
          sessionId: job.sessionId,
          error: job.error || undefined,
        });
      } catch (error) {
        next(error);
      }
    }
      bookmarkStore.set(sessionIdValue, new Set());
    }

      const session = getSessionById(sessionIdValue);
    bookmarks.add(questionId);
    session.bookmarks = bookmarks;

    res.json({ ok: true });

      if (!isSessionOwner(req, session)) {
        throw forbidden("You do not own this session");
      }
  } catch (error) {
    next(error);
  }
}
        meta: {
          generatedAt: session.generatedAt,
        },
module.exports = {
  uploadResume,
  parseResume,
  generateQuestions,
  getQuestions,
  startMock,
  answerMock,
  evaluateSingle,
  chat,
  getPreferences,
  savePreferences,
  insights,
  bookmarkQuestion,
};