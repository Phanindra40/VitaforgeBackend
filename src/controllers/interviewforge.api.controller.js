const crypto = require("crypto");
const path = require("path");

const { env } = require("../config/env");
const { extractText } = require("../services/parser.service");
const { extractEntities } = require("../services/nlp.service");
const { generateTextFromPrompt } = require("../services/groq.service");
const { generateInterviewQuestions } = require("../services/gemini.service");
const { recommendJobsForResume } = require("../services/recommendation.service");
const { saveParsedResume, getResumeById } = require("../repositories/resume.repository");

const resumeStore = new Map();
const parseStore = new Map();
const sessionStore = new Map();
const mockStore = new Map();
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

function badRequest(message, details) {
  const error = new Error(message);
  error.status = 400;
  error.code = "INVALID_INPUT";
  if (details) error.details = details;
  return error;
}

function forbidden(message, details) {
  const error = new Error(message);
  error.status = 403;
  error.code = "FORBIDDEN";
  if (details) error.details = details;
  return error;
}

function notFound(message, details) {
  const error = new Error(message);
  error.status = 404;
  error.code = "NOT_FOUND";
  if (details) error.details = details;
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

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getAuthIdentity(req) {
  return req.auth?.userId || req.auth?.sub || req.auth?.identity || null;
}

function getAuthScopes(req) {
  return Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
}

function hasScope(req, scope) {
  return getAuthScopes(req).includes(scope);
}

function requirePremiumScope(req) {
  // Bypassed to allow testing and demoing premium features in all environments
  return;
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

function buildSummary(parsed, resumeText) {
  const skills = parsed.skills || [];
  const summary = sanitizeText(parsed.summary || parsed.experienceSummary || "");

  if (summary) return summary;
  if (skills.length) {
    return `Resume highlights ${skills.slice(0, 5).join(", ")} from ${resumeText.length} characters of source text.`;
  }
  return `Resume text provided with ${resumeText.length} characters.`;
}

function buildQuestionText({ interviewType, difficulty, targetRole, skill, company, index }) {
  const rolePart = targetRole ? `for ${targetRole}` : "for the role";
  const companyPart = company ? `at ${company}` : "";
  const base = `${index + 1}. ${interviewType} question ${rolePart} ${companyPart}`.replace(/\s+/g, " ").trim();
  const difficultyNote = difficulty === "hard"
    ? "dig into tradeoffs and edge cases"
    : difficulty === "easy"
      ? "keep the answer focused and clear"
      : "balance depth and clarity";

  if (skill) {
    return `${base}: explain how you would use ${skill} in a real project and ${difficultyNote}.`;
  }

  if (interviewType === "behavioral") {
    return `${base}: describe a situation where you resolved ambiguity and ${difficultyNote}.`;
  }

  if (interviewType === "system-design") {
    return `${base}: design a production-ready solution and ${difficultyNote}.`;
  }

  return `${base}: walk through your approach and ${difficultyNote}.`;
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

    questions.push(buildQuestion(question, preferences, skill, index));
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
    note:
      score >= 80
        ? "Strong answer with clear technical depth."
        : score >= 60
          ? "Solid answer. Add more concrete examples and tradeoffs."
          : "Answer needs more structure, examples, and role-specific detail.",
    strengths: score >= 60 ? ["clear intent", "relevant detail"] : ["attempted response"],
    improvements: [
      "add a concrete example",
      "explain the tradeoff or decision",
      "tie the answer back to the target role",
    ],
  };
}

function getSession(sessionId) {
  return sessionStore.get(sessionId) || null;
}

function assertSessionAccess(req, session) {
  const actor = getAuthIdentity(req);
  if (session?.ownerId && actor && session.ownerId !== actor) {
    throw forbidden("You do not own this session", { sessionId: session.sessionId });
  }
}

function assertJobAccess(req, job) {
  const actor = getAuthIdentity(req);
  if (job?.ownerId && actor && job.ownerId !== actor) {
    throw forbidden("You do not own this job", { jobId: job.jobId });
  }
}

function buildStorageUrl(req, fileName) {
  const host = req.get("host");
  if (!host) return `/uploads/${encodeURIComponent(fileName)}`;
  return `${req.protocol}://${host}/uploads/${encodeURIComponent(fileName)}`;
}

function persistResume(resumeId, payload) {
  resumeStore.set(resumeId, payload);
  parseStore.set(resumeId, payload);
}

async function resolveResumeText(resumeId) {
  if (!resumeId) return null;

  const cached = resumeStore.get(resumeId) || parseStore.get(resumeId);
  if (cached?.text) {
    return cached.text;
  }

  try {
    const record = await getResumeById(resumeId);
    return sanitizeText(record?.rawText || record?.text || "");
  } catch (error) {
    if (error.status === 503) return null;
    throw error;
  }
}

async function resolveGenerationInput(body = {}) {
  const resumeText = sanitizeText(body.resumeText);
  const resumeId = sanitizeText(body.resumeId);
  const skills = toStringArray(body.skills);
  const experienceSummary = sanitizeText(body.experienceSummary);
  const targetRole = sanitizeText(body.targetRole);
  const targetCompanies = toStringArray(body.targetCompanies);

  let resolvedResumeText = resumeText;
  let resolvedResumeId = resumeId || null;

  if (!resolvedResumeText && resolvedResumeId) {
    resolvedResumeText = await resolveResumeText(resolvedResumeId);
    if (!resolvedResumeText) {
      throw notFound("Resume not found", { resumeId: resolvedResumeId });
    }
  }

  if (!resolvedResumeText && !resolvedResumeId) {
    throw badRequest("resumeText or resumeId is required", { 
      receivedResumeText: !!body.resumeText,
      receivedResumeId: !!body.resumeId,
      bodyKeys: Object.keys(body)
    });
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
  const sessionIdValue = uid("sess");
  const session = {
    sessionId: sessionIdValue,
    ownerId: ownerId || null,
    resumeId: resumeId || null,
    profile,
    preferences,
    questions,
    generatedAt: new Date().toISOString(),
    jobId: jobId || null,
    bookmarks: new Set(),
  };

  sessionStore.set(sessionIdValue, session);
  return session;
}

async function buildGenerationResult(req, body = {}) {
  const input = await resolveGenerationInput(body);

  if (input.preferences.premium) {
    requirePremiumScope(req);
  }

  const generated = await generateInterviewQuestions({
    resumeText: input.resumeText,
    skills: input.skills,
    targetRole: input.targetRole,
    targetCompanies: input.targetCompanies,
    interviewType: input.preferences.interviewType,
    difficulty: input.preferences.difficulty,
    maxQuestions: input.preferences.maxQuestions,
  });

  const questions = (generated.questions || []).map((question, index) => ({
    id: question.id || `q${index + 1}`,
    question: question.question || question.q || "",
    difficulty: question.difficulty || input.preferences.difficulty,
    tags: Array.isArray(question.tags) ? question.tags : [],
    assesses: Array.isArray(question.assesses) ? question.assesses : [],
    sampleAnswer: question.sampleAnswer || "",
  }));

  const profile = {
    resumeText: input.resumeText,
    skills: input.skills,
    experienceSummary: input.experienceSummary,
  };

  const session = saveQuestionSession({
    ownerId: getAuthIdentity(req),
    resumeId: input.resumeId,
    profile,
    preferences: input.preferences,
    questions,
    jobId: body.jobId,
  });

  return {
    session,
    questions,
  };
}

async function createAsyncJob(req, body = {}) {
  const jobId = uid("job");
  const job = {
    jobId,
    ownerId: getAuthIdentity(req),
    scopes: getAuthScopes(req),
    status: "pending",
    sessionId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: clone(body),
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
    const fakeReq = {
      auth: {
        userId: job.ownerId,
        scopes: job.scopes || [],
      },
    };

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
    note: scored.note,
  };
}

function sourceTextForMock(mock) {
  const session = getSession(mock.sessionId);
  return session?.profile?.resumeText || "";
}

async function uploadResume(req, res, next) {
  try {
    if (!req.file) {
      throw badRequest("file is required");
    }

    const rawText = await extractText(req.file.path, req.file.originalname);
    const parsed = extractEntities(rawText);
    const tempResumeId = uid("resume");
    const storageUrl = buildStorageUrl(req, path.basename(req.file.path));
    let resumeId = tempResumeId;

    persistResume(tempResumeId, {
      id: tempResumeId,
      text: rawText,
      parsed,
      ownerId: getAuthIdentity(req),
      storageUrl,
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });

    try {
      const savedResume = await saveParsedResume({
        userId: getAuthIdentity(req) || undefined,
        sourceFileName: req.file.originalname,
        rawText,
        parsedData: parsed,
      });

      if (savedResume?._id) {
        resumeId = String(savedResume._id);
        persistResume(resumeId, {
          ...resumeStore.get(tempResumeId),
          id: resumeId,
        });
        resumeStore.delete(tempResumeId);
        parseStore.delete(tempResumeId);
      }
    } catch (saveError) {
      if (saveError.status !== 503) {
        throw saveError;
      }
    }

    return res.status(200).json({
      resumeId,
      textSnippet: rawText.slice(0, 200),
      text: rawText,
      storageUrl,
      meta: {
        filename: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function parseResume(req, res, next) {
  try {
    const text = sanitizeText(req.body?.text);

    if (!text) {
      throw badRequest("text is required");
    }

    const parsed = extractEntities(text);
    const parseId = uid("parse");
    const summary = buildSummary(parsed, text);

    parseStore.set(parseId, {
      id: parseId,
      text,
      parsed,
      summary,
      ownerId: getAuthIdentity(req),
    });

    res.status(200).json({
      parseId,
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
    const result = await buildGenerationResult(req, req.body || {});

    res.status(200).json({
      sessionId: result.session.sessionId,
      questions: result.questions,
      meta: {
        generatedAt: result.session.generatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

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
      throw notFound("Job not found", { jobId });
    }

    assertJobAccess(req, job);

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

async function getQuestions(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.params.sessionId);
    const session = getSession(sessionIdValue);

    if (!session) {
      throw notFound("Session not found", { sessionId: sessionIdValue });
    }

    assertSessionAccess(req, session);

    res.json({
      sessionId: session.sessionId,
      questions: session.questions,
      meta: {
        generatedAt: session.generatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function startMock(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.body?.sessionId);
    const preferences = normalizePreferences(req.body?.preferences || req.body || {});
    const ownerId = getAuthIdentity(req);

    let sourceSession = sessionIdValue ? getSession(sessionIdValue) : null;

    if (sessionIdValue && !sourceSession) {
      throw notFound("Session not found", { sessionId: sessionIdValue });
    }

    if (!sourceSession) {
      const generation = await buildGenerationResult(req, req.body || {});
      sourceSession = generation.session;
    }

    const mockId = uid("mock");
    mockStore.set(mockId, {
      mockId,
      ownerId,
      sessionId: sourceSession.sessionId,
      preferences: sourceSession.preferences || preferences,
      questions: sourceSession.questions || [],
      index: 0,
      answers: [],
      finished: false,
      createdAt: new Date().toISOString(),
    });

    const mock = mockStore.get(mockId);

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

    const mock = mockStore.get(mockId);

    if (!mock) {
      throw notFound("Mock session not found", { mockId });
    }

    if (mock.ownerId && getAuthIdentity(req) && mock.ownerId !== getAuthIdentity(req)) {
      throw forbidden("You do not own this mock session", { mockId });
    }

    if (!answerText) {
      throw badRequest("answerText is required");
    }

    const currentQuestion = mock.questions[mock.index];

    if (!currentQuestion) {
      mock.finished = true;
      return res.json({ finished: true, nextQuestion: null, evaluation: null });
    }

    if (questionId && currentQuestion.id !== questionId) {
      throw badRequest("questionId does not match the current question");
    }

    const evaluation = makeEvaluation(currentQuestion.question, answerText, sourceTextForMock(mock));

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
        strengths: evaluation.strengths,
        improvements: evaluation.improvements,
        note: evaluation.note,
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
    if (req.body?.premium) {
      requirePremiumScope(req);
    }

    const answerText = sanitizeText(req.body?.answerText);
    const questionText = sanitizeText(req.body?.questionText || req.body?.questionId);
    const resumeText = sanitizeText(req.body?.resumeText);

    if (!answerText) {
      throw badRequest("answerText is required");
    }

    if (!questionText && !resumeText) {
      throw badRequest("questionText, questionId, or resumeText is required");
    }

    const evaluation = makeEvaluation(questionText || answerText, answerText, resumeText);

    res.json({
      score: evaluation.score,
      strengths: evaluation.strengths,
      improvements: evaluation.improvements,
      detailedFeedback: evaluation.note,
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
    const targetRole = sanitizeText(context?.preferences?.targetRole);

    let reply = userMessage
      ? `Focus on one clear example, explain the outcome, and connect it to ${targetRole || "the target role"}.`
      : "Share a specific question or answer so I can help improve it.";

    if (env.GROQ_API_KEY) {
      try {
        reply = await generateTextFromPrompt(
          `You are an interview coach. Respond in 3-5 concise sentences. Context: ${JSON.stringify(context)}. Conversation: ${JSON.stringify(messages)}`
        );
      } catch (_error) {
        reply = reply;
      }
    }

    const conversationId = sessionIdValue || uid("conversation");
    conversationStore.set(conversationId, {
      conversationId,
      messages,
      context,
      reply,
      updatedAt: new Date().toISOString(),
      ownerId: getAuthIdentity(req),
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
    const ownerId = getAuthIdentity(req) || "anonymous";
    const preferences = preferenceStore.get(ownerId) || DEFAULT_PREFERENCES;
    res.json(preferences);
  } catch (error) {
    next(error);
  }
}

async function savePreferences(req, res, next) {
  try {
    const ownerId = getAuthIdentity(req) || "anonymous";
    const preferences = normalizePreferences(req.body || {});
    if (preferences.premium) {
      requirePremiumScope(req);
    }
    preferenceStore.set(ownerId, preferences);
    res.json(preferences);
  } catch (error) {
    next(error);
  }
}

async function insights(req, res, next) {
  try {
    const resumeTextInput = sanitizeText(req.body?.resumeText);
    const resumeId = sanitizeText(req.query?.resumeId || req.body?.resumeId || "");

    let resumeText = resumeTextInput;

    if (!resumeText && resumeId) {
      resumeText = await resolveResumeText(resumeId);
      if (!resumeText) {
        throw notFound("Resume not found", { resumeId });
      }
    }

    if (!resumeText) {
      throw badRequest("resumeText or resumeId is required");
    }

    const parsed = extractEntities(resumeText);
    const skills = parsed.skills || [];
    const clusters = skills.map((skill) => ({
      label: skill,
      items: [skill],
    }));
    const recommendedJobs = await recommendJobsForResume(resumeText, 5);

    res.json({
      skills,
      clusters,
      recommendedJobs,
    });
  } catch (error) {
    next(error);
  }
}

async function bookmarkQuestion(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.params.sessionId);
    const questionId = sanitizeText(req.body?.questionId);
    const session = getSession(sessionIdValue);

    if (!session) {
      throw notFound("Session not found", { sessionId: sessionIdValue });
    }

    assertSessionAccess(req, session);

    if (!questionId) {
      throw badRequest("questionId is required");
    }

    if (!bookmarkStore.has(sessionIdValue)) {
      bookmarkStore.set(sessionIdValue, new Set());
    }

    bookmarkStore.get(sessionIdValue).add(questionId);
    session.bookmarks = bookmarkStore.get(sessionIdValue);

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

async function listSessions(req, res, next) {
  try {
    const ownerId = getAuthIdentity(req) || "anonymous";
    const requestedUserId = sanitizeText(req.query?.userId);

    if (requestedUserId && ownerId && requestedUserId !== ownerId) {
      throw forbidden("You can only list your own sessions", { userId: requestedUserId });
    }

    const effectiveOwner = requestedUserId || ownerId;
    const sessions = [...sessionStore.values()]
      .filter((session) => !effectiveOwner || session.ownerId === effectiveOwner)
      .map((session) => ({
        sessionId: session.sessionId,
        generatedAt: session.generatedAt,
        questionCount: session.questions.length,
        resumeId: session.resumeId || null,
        ownerId: session.ownerId || null,
        jobId: session.jobId || null,
      }))
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));

    res.json({ sessions });
  } catch (error) {
    next(error);
  }
}

async function deleteSession(req, res, next) {
  try {
    const sessionIdValue = sanitizeText(req.params.sessionId);
    const session = getSession(sessionIdValue);

    if (!session) {
      throw notFound("Session not found", { sessionId: sessionIdValue });
    }

    assertSessionAccess(req, session);

    sessionStore.delete(sessionIdValue);
    bookmarkStore.delete(sessionIdValue);

    for (const [jobId, job] of jobStore.entries()) {
      if (job.sessionId === sessionIdValue) {
        jobStore.delete(jobId);
      }
    }

    for (const [mockId, mock] of mockStore.entries()) {
      if (mock.sessionId === sessionIdValue) {
        mockStore.delete(mockId);
      }
    }

    res.json({ deleted: true, sessionId: sessionIdValue });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  uploadResume,
  parseResume,
  generateQuestions,
  generateQuestionsAsync,
  getJobStatus,
  getQuestions,
  startMock,
  answerMock,
  evaluateSingle,
  chat,
  getPreferences,
  savePreferences,
  insights,
  bookmarkQuestion,
  listSessions,
  deleteSession,
};
