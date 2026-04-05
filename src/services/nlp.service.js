const nlp = require("compromise");

const SKILL_KEYWORDS = [
  "javascript",
  "typescript",
  "node",
  "express",
  "react",
  "next.js",
  "mongodb",
  "sql",
  "python",
  "java",
  "aws",
  "docker",
  "kubernetes",
  "rest",
  "graphql",
  "git",
  "ci/cd",
  "testing",
  "jest",
  "redis",
  "microservices",
];

function extractSection(text, heading) {
  const regex = new RegExp(`${heading}([\\s\\S]*?)(\\n[A-Z][A-Za-z ]+:|$)`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() || "";
}

function extractSkills(text) {
  const lower = text.toLowerCase();
  return SKILL_KEYWORDS.filter((skill) => lower.includes(skill)).sort();
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function extractEntities(text) {
  const doc = nlp(text || "");

  const emails = unique(doc.emails().out("array"));
  const phones = unique(doc.phoneNumbers().out("array"));
  const names = unique(doc.people().out("array"));
  const organizations = unique(doc.organizations().out("array"));
  const skills = unique(extractSkills(text));

  return {
    names,
    emails,
    phones,
    organizations,
    skills,
    sections: {
      summary: extractSection(text, "summary[:\\n ]"),
      experience: extractSection(text, "experience[:\\n ]"),
      education: extractSection(text, "education[:\\n ]"),
      projects: extractSection(text, "projects[:\\n ]"),
    },
  };
}

module.exports = { extractEntities };
