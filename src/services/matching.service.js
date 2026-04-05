const natural = require("natural");

function normalizeScore(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number(value.toFixed(4));
}

function matchResumeToJob(resumeText, jobText) {
  const tfidf = new natural.TfIdf();
  tfidf.addDocument(resumeText || "");
  tfidf.addDocument(jobText || "");

  const rawScore = tfidf.tfidf(jobText || "", 0);
  return normalizeScore(rawScore);
}

module.exports = { matchResumeToJob };
