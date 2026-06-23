const mongoose = require("mongoose");
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

async function createResume(payload) {
  if (!isDbReady()) {
    const id = new mongoose.Types.ObjectId().toString();
    const now = new Date();
    const doc = {
      _id: id,
      id: id,
      ...payload,
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.set(id, doc);
    return doc;
  }

  const created = await Resume.create(payload);
  return toPlainResume(created);
}

async function listResumes() {
  if (!isDbReady()) {
    return Array.from(memoryStore.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  return Resume.find().sort({ createdAt: -1 }).lean();
}

async function getResumeById(id) {
  if (!id) return null;

  if (!isDbReady()) {
    return memoryStore.get(id.toString()) || null;
  }

  return Resume.findById(id).lean();
}

async function updateResumeById(id, updates) {
  if (!id) return null;

  if (!isDbReady()) {
    const key = id.toString();
    const existing = memoryStore.get(key);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    memoryStore.set(key, updated);
    return updated;
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
    const key = id.toString();
    const existing = memoryStore.get(key);
    if (!existing) return null;
    memoryStore.delete(key);
    return existing;
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
