const { extractEntities } = require("./nlp.service");
const { getAllJobs } = require("../repositories/job.repository");

function rankJobs(resumeSkills, jobs) {
  const normalizedSkills = resumeSkills.map((skill) => skill.toLowerCase());

  return jobs
    .map((job) => {
      const text = `${job.title || ""} ${job.description || ""}`.toLowerCase();
      const matchedSkills = normalizedSkills.filter((skill) => text.includes(skill));
      const score = normalizedSkills.length
        ? Math.round((matchedSkills.length / normalizedSkills.length) * 100)
        : 0;

      return {
        id: job._id || job.id || null,
        title: job.title,
        description: job.description,
        score,
        matchedSkills,
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function recommendJobsForResume(resumeText, limit = 5) {
  const parsed = extractEntities(resumeText);
  const jobs = await getAllJobs();
  const ranked = rankJobs(parsed.skills || [], jobs || []);
  return ranked.slice(0, Math.max(1, Math.min(limit, 20)));
}

module.exports = { recommendJobsForResume };
