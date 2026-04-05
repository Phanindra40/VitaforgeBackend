# VitaForge Backend — Detailed Study & Change Guide

This document explains the full backend implementation in detail so you can confidently modify it.

---

## 1) High-Level Architecture

The backend follows a layered clean architecture pattern:

- **Entry + app boot**
  - `Server.js` starts the app from `src/app.js`
- **Routes layer**
  - `src/routes/index.js`
  - `src/routes/resume.routes.js`
- **Controller layer** (HTTP orchestration, validation)
  - `src/controllers/resume.controller.js`
- **Service layer** (business + AI logic)
  - `src/services/*.js`
- **Repository layer** (database access abstraction)
  - `src/repositories/*.js`
- **Model layer** (Mongoose schemas)
  - `src/models/*.js`
- **Cross-cutting**
  - Env config: `src/config/env.js`
  - DB connection: `src/config/database.js`
  - Upload utility: `src/utils/upload.js`
  - Error middleware: `src/middlewares/error.middleware.js`

### Request Lifecycle

1. Request enters Express app (`src/app.js`)
2. Middleware executes (CORS, Helmet, JSON parser, rate limit)
3. Route maps request to controller
4. Controller validates request body/file
5. Controller calls service(s)
6. Service computes output and may call repositories / external APIs
7. Controller returns JSON response
8. Error middleware formats failures

---

## 2) Project Structure (Current)

- `Server.js`
- `src/`
  - `app.js`
  - `config/`
    - `env.js`
    - `database.js`
  - `routes/`
    - `index.js`
    - `resume.routes.js`
  - `controllers/`
    - `resume.controller.js`
  - `services/`
    - `parser.service.js`
    - `nlp.service.js`
    - `matching.service.js`
    - `ats.service.js`
    - `embedding.service.js`
    - `ai.service.js`
    - `recommendation.service.js`
  - `repositories/`
    - `resume.repository.js`
    - `job.repository.js`
  - `models/`
    - `User.js`
    - `Resume.js`
    - `Job.js`
  - `middlewares/`
    - `error.middleware.js`
  - `utils/`
    - `upload.js`
- `public/`
  - `test-ui.html`
  - `test-ui.js`
- `uploads/`
- `.env.example`
- `README.md`

> Note: `AI Features/` exists from older structure and is not used by the current app flow.

---

## 3) Environment Configuration

From `.env.example`:

- `PORT=8000`
- `NODE_ENV=development`
- `CORS_ORIGIN=*`
- `MONGODB_URI=`
- `HF_API_KEY=`
- `GEMINI_KEY=`

### Behavior Without Keys

- Missing `MONGODB_URI`: app still runs; DB writes are skipped.
- Missing `HF_API_KEY`: semantic match endpoint returns error.
- Missing `GEMINI_KEY`: resume improvement endpoint returns error.

---

## 4) Core Middleware & Security

Implemented in `src/app.js`:

- `cors` with configurable origin
- `helmet` for secure headers
- `express.json()` + `express.urlencoded()` parsers
- `express-rate-limit` on `/api` path
- static file serving for test UI
- centralized `404` + error handler middleware

### Important CSP Note

Because Helmet is enabled, inline `<script>` and inline `onclick` handlers are restricted.

That is why Test UI logic is moved into external file `public/test-ui.js` and buttons are wired with `addEventListener`.

---

## 5) API Endpoints (Detailed)

Base: `/api/v1`

### 5.1 GET `/`

- Purpose: Service status
- Handler location: `src/app.js`
- Response example:

```json
{
  "service": "VitaForge Backend",
  "version": "1.0.0",
  "status": "running"
}
```

### 5.2 GET `/api/v1/health`

- Purpose: Health check
- Handler location: `src/routes/index.js`
- Response example:

```json
{
  "ok": true,
  "uptime": 123.45
}
```

### 5.3 POST `/api/v1/resume/upload`

- Content-Type: `multipart/form-data`
- Fields:
  - `resume`: file (`.pdf`, `.doc`, `.docx` allowed; parser supports `.pdf`, `.docx`)
  - `userId` (optional)
- Flow:
  1. Multer stores file in `uploads/`
  2. Parser extracts text
  3. NLP extracts entities/skills/sections
  4. Resume is saved if Mongo is connected
- Response example:

```json
{
  "message": "Resume uploaded and parsed",
  "resumeId": "...or null when DB disconnected",
  "rawText": "...",
  "parsed": {
    "names": [],
    "emails": [],
    "phones": [],
    "organizations": [],
    "skills": [],
    "sections": {
      "summary": "",
      "experience": "",
      "education": "",
      "projects": ""
    }
  }
}
```

### 5.4 POST `/api/v1/resume/match`

- JSON body:

```json
{
  "resumeText": "...",
  "jobText": "..."
}
```

- Uses TF-IDF (`natural`) and returns:

```json
{
  "tfidfScore": 2.3781
}
```

### 5.5 POST `/api/v1/resume/ats`

- JSON body supports either:
  - `parsedData` + `jobText`, OR
  - `resumeText` + `jobText`
- Response shape:

```json
{
  "score": 42,
  "matchedKeywords": ["node", "mongodb"],
  "missingKeywords": ["kubernetes", "aws"]
}
```

### 5.6 POST `/api/v1/resume/semantic-match`

- JSON body:

```json
{
  "resumeText": "...",
  "jobText": "..."
}
```

- Calls HuggingFace embeddings API and computes cosine similarity
- Response:

```json
{
  "semanticScore": 78
}
```

### 5.7 POST `/api/v1/resume/improve`

- JSON body:

```json
{
  "text": "resume content"
}
```

- Calls Gemini and returns improved text:

```json
{
  "improved": "..."
}
```

### 5.8 POST `/api/v1/resume/recommend`

- JSON body:

```json
{
  "resumeText": "...",
  "limit": 5
}
```

- Returns ranked jobs by matched skills:

```json
{
  "recommendations": [
    {
      "id": "job-1",
      "title": "Backend Node.js Developer",
      "description": "...",
      "score": 80,
      "matchedSkills": ["node", "mongodb"]
    }
  ]
}
```

---

## 6) Service-by-Service Explanation

### 6.1 `parser.service.js`

- Handles file text extraction
- Supported extraction:
  - `.pdf` via `pdf-parse`
  - `.docx` via `mammoth`
- `.doc` is currently rejected with explicit error

### 6.2 `nlp.service.js`

- Uses `compromise` to extract:
  - emails, phones, names, organizations
- Uses keyword-based skill lookup
- Extracts section snippets (summary/experience/education/projects) via regex

### 6.3 `matching.service.js`

- Uses `natural.TfIdf`
- Adds resume and JD as documents
- Computes TF-IDF relevance score and normalizes to numeric output

### 6.4 `ats.service.js`

- Tokenizes job text
- Compares tokens against parsed resume skills
- Returns:
  - percentage score (0–100)
  - matched keywords
  - missing keywords

### 6.5 `embedding.service.js`

- Calls HuggingFace sentence-transformers model
- Fetches embeddings for resume and JD
- Computes cosine similarity
- Maps similarity to integer 0–100

### 6.6 `ai.service.js`

- Calls Gemini `generateContent`
- Prompt asks for ATS-friendly, concise improvements
- Returns flattened combined output text

### 6.7 `recommendation.service.js`

- Extracts resume skills from text
- Loads jobs from repository
- Scores jobs by skill overlap in title/description
- Sorts descending and returns top `limit`

---

## 7) Repository & Data Strategy

### `resume.repository.js`

- `saveParsedResume(payload)` saves only when Mongo is connected
- Returns `null` if DB disconnected (graceful fallback)

### `job.repository.js`

- Reads from `Job` collection when connected
- Falls back to seeded in-memory jobs if DB disconnected/empty

This ensures recommendation endpoint works in dev even without MongoDB.

---

## 8) Mongoose Schemas

### User (`src/models/User.js`)

- `name` (required)
- `email` (required, unique)

### Resume (`src/models/Resume.js`)

- `userId` (ObjectId ref User, optional)
- `sourceFileName` (required)
- `rawText` (required)
- `parsedData` (required object)
- `embeddings` (number array)

### Job (`src/models/Job.js`)

- `title` (required)
- `description` (required)
- `embeddings` (number array)

All use `timestamps: true`.

---

## 9) Upload System Details

Configured in `src/utils/upload.js`:

- Storage: `uploads/`
- File naming: timestamp + sanitized original file name
- Allowed extensions: `.pdf`, `.doc`, `.docx`
- Max file size: 10 MB

If unsupported type is uploaded, API returns an error response.

---

## 10) Test UI Guide

Open: `http://localhost:8000/test-ui`

Files:
- UI markup: `public/test-ui.html`
- UI logic/events: `public/test-ui.js`

Capabilities:
- test root + health
- test each resume endpoint individually
- run one-click non-upload endpoint batch test
- view response status + JSON in each panel

If button clicks stop working in future, first check whether script loading or CSP changed.

---

## 11) Error Handling Pattern

In `src/controllers/resume.controller.js`:

- Controller validates required input fields
- Throws custom 400 via `badRequest()` for invalid client input
- Forwards errors with `next(error)`

In `src/middlewares/error.middleware.js`:

- Unknown route: 404 JSON
- Any error: returns status (or 500) and message

---

## 12) How to Modify Safely (Recommended Workflow)

1. Identify layer you want to change:
   - API contract? → routes + controller
   - business logic? → service
   - persistence? → repository + model
2. Keep controller thin and move logic to service
3. Keep response schema consistent for frontend
4. Test from `/test-ui`
5. Test again with invalid data to verify error messages

---

## 13) Known Gaps / Improvement Backlog

Good next improvements when you are ready:

1. Add automated tests (unit + integration)
2. Add request validation library (Joi/Zod)
3. Add API docs (OpenAPI/Swagger)
4. Implement true `.doc` parsing or remove `.doc` from upload allow-list
5. Add authentication for user-bound resume storage
6. Add logging framework (pino/winston)
7. Persist semantic embeddings in DB for faster recommendation at scale

---

## 14) Common Troubleshooting

### A) `npm start` fails

Check:

1. `node_modules` installed: run `npm install`
2. Port conflict on `PORT`
3. Syntax errors from latest edits
4. Missing `.env` keys for optional AI features

### B) Semantic match fails

- Ensure `HF_API_KEY` is set and valid
- Check HuggingFace API limits / model availability

### C) Improve endpoint fails

- Ensure `GEMINI_KEY` is set and valid
- Check network and API quota

### D) Upload endpoint fails

- Ensure file type is valid
- Ensure file size ≤ 10MB
- Ensure parser supports extension (`.pdf`, `.docx`)

---

## 15) Quick cURL Samples

### Health

```bash
curl http://localhost:8000/api/v1/health
```

### TF-IDF Match

```bash
curl -X POST http://localhost:8000/api/v1/resume/match \
  -H "Content-Type: application/json" \
  -d '{"resumeText":"Node.js Express MongoDB","jobText":"Need Node.js and MongoDB"}'
```

### ATS

```bash
curl -X POST http://localhost:8000/api/v1/resume/ats \
  -H "Content-Type: application/json" \
  -d '{"resumeText":"Node.js Express MongoDB","jobText":"Need Node.js Docker MongoDB"}'
```

### Recommendations

```bash
curl -X POST http://localhost:8000/api/v1/resume/recommend \
  -H "Content-Type: application/json" \
  -d '{"resumeText":"Node.js Express MongoDB Docker","limit":5}'
```

---

## 16) Study Order (Best Path)

If you want to understand deeply, read in this sequence:

1. `src/app.js`
2. `src/routes/*.js`
3. `src/controllers/resume.controller.js`
4. `src/services/*` (one by one)
5. `src/repositories/*`
6. `src/models/*`
7. `public/test-ui.js`

This order follows real runtime flow and is easiest to learn.

---

If you want, next I can generate a second document with **change recipes** (e.g., “how to replace TF-IDF with BERT ranking”, “how to add auth”, “how to move from fallback jobs to full Mongo jobs CRUD”) step-by-step.
