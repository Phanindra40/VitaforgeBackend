const mongoose = require("mongoose");
const Resume = require("../models/Resume");

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function toPlainResume(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === "function") return doc.toObject();
  return { ...doc };
}

function createDatabaseUnavailableError() {
  const error = new Error("MongoDB is not connected. Resume data cannot be saved without a database.");
  error.status = 503;
  return error;
}

async function createResume(payload) {
  if (!isDbReady()) {
    throw createDatabaseUnavailableError();
  }

  const created = await Resume.create(payload);
  return toPlainResume(created);
}

async function listResumes() {
  if (!isDbReady()) {
    throw createDatabaseUnavailableError();
  }

  return Resume.find().sort({ createdAt: -1 }).lean();
}

async function getResumeById(id) {
  if (!id) return null;

  if (!isDbReady()) {
    throw createDatabaseUnavailableError();
  }

  return Resume.findById(id).lean();
}

async function updateResumeById(id, updates) {
  if (!id) return null;

  if (!isDbReady()) {
    throw createDatabaseUnavailableError();
  }

  const updated = await Resume.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  }).lean();
  return updated || null;
}

async function replaceResumeById(id, payload) {
  return updateResumeById(id, payload);
}

async function deleteResumeById(id) {
  if (!id) return null;

  if (!isDbReady()) {
    throw createDatabaseUnavailableError();
  }

  return Resume.findByIdAndDelete(id).lean();
}

async function duplicateResumeById(id) {
  const existing = await getResumeById(id);
  if (!existing) return null;

  const duplicatePayload = {
    ...existing,
    sourceFileName: existing.sourceFileName ? `${existing.sourceFileName} (copy)` : "resume-copy.txt",
    rawText: existing.rawText || "",
    parsedData: JSON.parse(JSON.stringify(existing.parsedData || {})),
    embeddings: Array.isArray(existing.embeddings) ? [...existing.embeddings] : [],
  };

  delete duplicatePayload._id;
  delete duplicatePayload.id;
  delete duplicatePayload.createdAt;
  delete duplicatePayload.updatedAt;

  return createResume(duplicatePayload);
}

async function saveParsedResume(payload) {
  return createResume(payload);
}

module.exports = {
  saveParsedResume,
  createResume,
  listResumes,
  getResumeById,
  updateResumeById,
  replaceResumeById,
  deleteResumeById,
  duplicateResumeById,
};
