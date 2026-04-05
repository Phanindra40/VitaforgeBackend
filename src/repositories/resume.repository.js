const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const Resume = require("../models/Resume");

const memoryStore = new Map();

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function toPlainResume(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === "function") return doc.toObject();
  return { ...doc };
}

function cloneValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeMemoryResume(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    id: String(doc._id),
  };
}

function sortByRecent(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function buildMemoryResume(payload) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const resume = {
    _id: id,
    id,
    createdAt: now,
    updatedAt: now,
    ...cloneValue(payload),
  };

  memoryStore.set(id, resume);
  return normalizeMemoryResume(resume);
}

async function createResume(payload) {
  if (isDbReady()) {
    const created = await Resume.create(payload);
    return toPlainResume(created);
  }

  return buildMemoryResume(payload);
}

async function listResumes() {
  if (isDbReady()) {
    return Resume.find().sort({ createdAt: -1 }).lean();
  }

  return Array.from(memoryStore.values())
    .map(normalizeMemoryResume)
    .sort(sortByRecent);
}

async function getResumeById(id) {
  if (!id) return null;

  if (isDbReady()) {
    return Resume.findById(id).lean();
  }

  return normalizeMemoryResume(memoryStore.get(id));
}

async function updateResumeById(id, updates) {
  if (!id) return null;

  if (isDbReady()) {
    const updated = await Resume.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).lean();
    return updated || null;
  }

  const current = memoryStore.get(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const next = {
    ...current,
    ...cloneValue(updates),
    _id: id,
    id,
    createdAt: current.createdAt,
    updatedAt: now,
  };

  memoryStore.set(id, next);
  return normalizeMemoryResume(next);
}

async function replaceResumeById(id, payload) {
  return updateResumeById(id, payload);
}

async function deleteResumeById(id) {
  if (!id) return null;

  if (isDbReady()) {
    return Resume.findByIdAndDelete(id).lean();
  }

  const existing = memoryStore.get(id);
  if (!existing) return null;

  memoryStore.delete(id);
  return normalizeMemoryResume(existing);
}

async function duplicateResumeById(id) {
  const existing = await getResumeById(id);
  if (!existing) return null;

  const duplicatePayload = {
    ...existing,
    sourceFileName: existing.sourceFileName ? `${existing.sourceFileName} (copy)` : "resume-copy.txt",
    rawText: existing.rawText || "",
    parsedData: cloneValue(existing.parsedData || {}),
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
