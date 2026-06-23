const axios = require('axios');

async function test() {
  try {
    console.log("Sending request to http://localhost:5000/api/gemini/ats-analyze...");
    const response = await axios.post('http://localhost:5000/api/gemini/ats-analyze', {
      jobDescription: "We are looking for a React developer with Node.js and AWS experience.",
      resumeText: "John Doe is a React developer. He works with Node.js, HTML, CSS, JavaScript.",
      analysisContext: {
        keywordCoverage: 0.5,
        skillCoverage: 0.5,
        sectionCoverage: 0.8,
        contactPresent: true,
        resumeWordCount: 500,
        actionVerbCount: 5,
        metricCount: 2,
        bulletCount: 6,
        matchedKeywords: ["React", "Node.js"],
        missingKeywords: ["AWS"],
        matchedSkills: ["React"],
        missingSkills: ["Node.js", "AWS"]
      }
    });
    console.log("Response status:", response.status);
    console.log("Response data:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("Error calling backend:", error.message);
    if (error.response) {
      console.error("Response error data:", error.response.data);
    }
  }
}

test();
