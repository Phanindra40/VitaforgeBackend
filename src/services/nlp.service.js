const nlp = require("compromise");

/* -------------------------------------------------------------------------- */
/*                              SKILL KEYWORDS                                */
/* -------------------------------------------------------------------------- */

const SKILL_KEYWORDS = [
  "javascript",
  "typescript",
  "node",
  "node.js",
  "express",
  "react",
  "next.js",
  "angular",
  "vue",
  "mongodb",
  "mysql",
  "postgresql",
  "sql",
  "python",
  "java",
  "c",
  "c++",
  "aws",
  "azure",
  "docker",
  "kubernetes",
  "redis",
  "firebase",
  "graphql",
  "rest",
  "rest api",
  "git",
  "github",
  "ci/cd",
  "jenkins",
  "testing",
  "jest",
  "mocha",
  "tailwind",
  "bootstrap",
  "microservices",
  "websocket",
  "webrtc",
  "machine learning",
  "ai",
  "nlp",
];

/* -------------------------------------------------------------------------- */
/*                             TEXT NORMALIZATION                             */
/* -------------------------------------------------------------------------- */

function normalizeText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/*                                UNIQUE HELPER                               */
/* -------------------------------------------------------------------------- */

function unique(items = []) {
  return [
    ...new Set(
      items
        .filter(Boolean)
        .map((item) =>
          String(item).trim()
        )
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/*                            SECTION EXTRACTION                              */
/* -------------------------------------------------------------------------- */

function extractSection(
  text,
  heading
) {
  if (!text || !heading) {
    return "";
  }

  /**
   * Matches:
   * SUMMARY
   * Summary:
   * Summary
   */

  const regex = new RegExp(
    `(?:^|\\n)\\s*${heading}\\s*[:\\n]?([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Za-z &]+\\s*:?\\n|$)`,
    "i"
  );

  const match = text.match(regex);

  return match?.[1]?.trim() || "";
}

/* -------------------------------------------------------------------------- */
/*                              SKILL EXTRACTION                              */
/* -------------------------------------------------------------------------- */

function extractSkills(text) {
  const normalized =
    normalizeText(text).toLowerCase();

  const detectedSkills =
    SKILL_KEYWORDS.filter((skill) => {
      /**
       * Exact word boundary matching
       * Prevents partial false matches
       */

      const escaped =
        skill.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const regex = new RegExp(
        `\\b${escaped}\\b`,
        "i"
      );

      return regex.test(normalized);
    });

  return unique(detectedSkills).sort();
}

/* -------------------------------------------------------------------------- */
/*                             EMAIL EXTRACTION                               */
/* -------------------------------------------------------------------------- */

function extractEmails(doc) {
  try {
    return unique(
      doc.emails().out("array")
    );
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                             PHONE EXTRACTION                               */
/* -------------------------------------------------------------------------- */

function extractPhones(doc) {
  try {
    return unique(
      doc.phoneNumbers().out("array")
    );
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                              NAME EXTRACTION                               */
/* -------------------------------------------------------------------------- */

function extractNames(doc) {
  try {
    return unique(
      doc.people().out("array")
    );
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                        ORGANIZATION EXTRACTION                             */
/* -------------------------------------------------------------------------- */

function extractOrganizations(doc) {
  try {
    return unique(
      doc.organizations().out("array")
    );
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                          LINK EXTRACTION                                   */
/* -------------------------------------------------------------------------- */

function extractLinks(text) {
  const matches =
    text.match(
      /(https?:\/\/[^\s]+)/gi
    ) || [];

  return unique(matches);
}

/* -------------------------------------------------------------------------- */
/*                         GITHUB EXTRACTION                                  */
/* -------------------------------------------------------------------------- */

function extractGithub(text) {
  const links =
    extractLinks(text);

  return unique(
    links.filter((link) =>
      link.includes("github.com")
    )
  );
}

/* -------------------------------------------------------------------------- */
/*                        LINKEDIN EXTRACTION                                 */
/* -------------------------------------------------------------------------- */

function extractLinkedin(text) {
  const links =
    extractLinks(text);

  return unique(
    links.filter((link) =>
      link.includes(
        "linkedin.com"
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/*                          MAIN ENTITY EXTRACTION                            */
/* -------------------------------------------------------------------------- */

function extractEntities(text = "") {
  const cleanedText =
    normalizeText(text);

  const doc = nlp(cleanedText);

  const names =
    extractNames(doc);

  const emails =
    extractEmails(doc);

  const phones =
    extractPhones(doc);

  const organizations =
    extractOrganizations(doc);

  const skills =
    extractSkills(cleanedText);

  const github =
    extractGithub(cleanedText);

  const linkedin =
    extractLinkedin(cleanedText);

  const sections = {
    summary:
      extractSection(
        cleanedText,
        "summary"
      ),

    experience:
      extractSection(
        cleanedText,
        "experience"
      ),

    education:
      extractSection(
        cleanedText,
        "education"
      ),

    projects:
      extractSection(
        cleanedText,
        "projects"
      ),

    skills:
      extractSection(
        cleanedText,
        "skills"
      ),

    certifications:
      extractSection(
        cleanedText,
        "certifications"
      ),
  };

  return {
    names,

    emails,

    phones,

    organizations,

    skills,

    github,

    linkedin,

    sections,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  extractEntities,

  extractSkills,

  extractSection,
};