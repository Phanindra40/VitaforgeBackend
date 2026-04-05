const http = require("http");

const HOST = process.env.TEST_HOST || "localhost";
const PORT = Number(process.env.TEST_PORT || 5000);

function callApi(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
        : {},
    };

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let parsed = raw;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (_err) {
          // Keep raw body when response is not JSON.
        }

        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          data: parsed,
        });
      });
    });

    req.on("error", reject);

    if (payload) req.write(payload);
    req.end();
  });
}

function printResult(title, result) {
  const statusWord = result.ok ? "PASS" : "FAIL";
  console.log(`\n[${statusWord}] ${title}`);
  console.log(`Status: ${result.status}`);
  console.log("Response:", JSON.stringify(result.data, null, 2));
}

async function run() {
  console.log(`Running sample tests against http://${HOST}:${PORT}`);

  const sampleResume = {
    sourceFileName: "sample-resume.txt",
    rawText: "Backend engineer with Node.js, Express, MongoDB, Docker, and Groq integration.",
    parsedData: {
      name: "Test User",
      skills: ["Node.js", "Express", "MongoDB", "Groq"],
    },
    embeddings: [0.12, 0.34, 0.56],
  };

  let createdResumeId = null;
  let duplicatedResumeId = null;

  const checks = [
    {
      title: "GET /api/health",
      run: () => callApi("/api/health", "GET"),
    },
    {
      title: "POST /api/contact",
      run: () =>
        callApi("/api/contact", "POST", {
          name: "Test User",
          email: "test@example.com",
          message: "Testing contact endpoint",
          source: "sample-test.js",
        }),
    },
    {
      title: "POST /api/groq/generate",
      run: () =>
        callApi("/api/groq/generate", "POST", {
          prompt: "Write a 2-line professional summary for a backend Node.js developer.",
        }),
    },
    {
      title: "POST /api/groq/summary-from-jd",
      run: () =>
        callApi("/api/groq/summary-from-jd", "POST", {
          jobDescription:
            "We are hiring a backend developer with Node.js, Express, MongoDB, REST API design, and Docker experience.",
        }),
    },
    {
      title: "POST /api/resumes",
      run: async () => {
        const result = await callApi("/api/resumes", "POST", sampleResume);
        createdResumeId = result.data?.resume?._id || result.data?.resume?.id || null;
        return result;
      },
    },
    {
      title: "GET /api/resumes",
      run: () => callApi("/api/resumes", "GET"),
    },
    {
      title: "GET /api/resumes/:id",
      run: () =>
        callApi(`/api/resumes/${createdResumeId || "missing-id"}`, "GET"),
    },
    {
      title: "PATCH /api/resumes/:id",
      run: () =>
        callApi(`/api/resumes/${createdResumeId || "missing-id"}`, "PATCH", {
          summary: "Updated summary from sample test",
        }),
    },
    {
      title: "PUT /api/resumes/:id",
      run: () =>
        callApi(`/api/resumes/${createdResumeId || "missing-id"}`, "PUT", {
          ...sampleResume,
          sourceFileName: "updated-sample-resume.txt",
          rawText: "Updated backend engineer resume sample.",
        }),
    },
    {
      title: "POST /api/resumes/:id/duplicate",
      run: async () => {
        const result = await callApi(`/api/resumes/${createdResumeId || "missing-id"}/duplicate`, "POST");
        duplicatedResumeId = result.data?.resume?._id || result.data?.resume?.id || null;
        return result;
      },
    },
    {
      title: "DELETE duplicated resume",
      run: () =>
        callApi(`/api/resumes/${duplicatedResumeId || "missing-id"}`, "DELETE"),
    },
    {
      title: "DELETE original resume",
      run: () =>
        callApi(`/api/resumes/${createdResumeId || "missing-id"}`, "DELETE"),
    },
  ];

  const results = [];

  for (const check of checks) {
    try {
      const result = await check.run();
      results.push({ title: check.title, ...result });
      printResult(check.title, result);
    } catch (error) {
      const failed = {
        title: check.title,
        status: 0,
        ok: false,
        data: { error: error.message || "Request failed" },
      };
      results.push(failed);
      printResult(check.title, failed);
    }
  }

  const passCount = results.filter((r) => r.ok).length;
  console.log(`\nSummary: ${passCount}/${results.length} checks passed`);

  if (passCount !== results.length) {
    process.exitCode = 1;
  }
}

run();
