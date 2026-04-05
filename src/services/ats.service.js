function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean);
}

function calculateATSScore(parsedData, jobText) {
  const jobKeywords = [...new Set(tokenize(jobText))];
  const resumeSkills = (parsedData.skills || []).map((skill) => skill.toLowerCase());

  if (!jobKeywords.length) {
    return { score: 0, matchedKeywords: [], missingKeywords: [] };
  }

  const matchedKeywords = jobKeywords.filter((keyword) => resumeSkills.includes(keyword));
  const missingKeywords = jobKeywords.filter((keyword) => !resumeSkills.includes(keyword));
  const score = Math.max(0, Math.min(100, Math.round((matchedKeywords.length / jobKeywords.length) * 100)));

  return { score, matchedKeywords, missingKeywords };
}

module.exports = { calculateATSScore };
