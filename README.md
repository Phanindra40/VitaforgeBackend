# VitaForge Backend (Clean Architecture)

## Detailed Documentation

- Full deep-dive guide: `docs/VITAFORGE_BACKEND_DETAILED_GUIDE.md`

## Run

1. Create `.env`
2. Fill keys as needed (`MONGODB_URI`, `HF_API_KEY`, `GROQ_API_KEY`, `TEST_UI_LOGIN_USERNAME`, `TEST_UI_LOGIN_PASSWORD`, `INTERVIEWFORGE_API_TOKEN`, `INTERVIEWFORGE_JWT_SECRET`)
3. Start server:

```bash
npm install
npm start
```

Server runs on `http://localhost:8000` by default.

## Redis Caching

Redis caching is integrated for read-heavy and AI/analysis endpoints to reduce repeated processing and third-party API usage.

Add these optional variables to `.env`:

- `CACHE_ENABLED=true`
- `REDIS_URL=redis://127.0.0.1:6379`
- `REDIS_PREFIX=vitaforge`
- `REDIS_CONNECT_TIMEOUT_MS=5000`
- `CACHE_DEFAULT_TTL_SECONDS=300`
- `CACHE_AI_TTL_SECONDS=900`
- `CACHE_RESUME_TTL_SECONDS=120`

If Redis is unreachable, the API continues to work and falls back to non-cached responses.

## Test UI

Open:

- `http://localhost:8000/`

Login first, then access the API test page.

## API Base

- `/api` (frontend-compatible)
- `/api/v1` (backward-compatible)

## Endpoints

- `GET /api/health` (also `/api/v1/health`)
- `POST /api/groq/generate`
- `POST /api/groq/summary-from-jd`
- `POST /api/gemini/ats-analyze` (`jobDescription`, `resumeText`, optional `analysisContext`, `responseFormat`, `requestType`; returns `{ analysis: ... }`)
- `POST /api/gemini/ocr-summary` (`text`)
- `POST /api/gemini/ocr-extract` (multipart `file`, optional `fileName`, optional `mimeType`, optional `mode`, optional `language`; returns `{ text }`)
- `POST /api/contact`
- `GET /api/resumes`
- `GET /api/resumes/:id`
- `POST /api/resumes`
- `PATCH /api/resumes/:id`
- `DELETE /api/resumes/:id`
- `PUT /api/resumes/:id`
- `POST /api/resumes/:id/duplicate`
- `POST /api/v1/resume/upload` (multipart: `resume`)
- `POST /api/v1/resume/match` (`resumeText`, `jobText`)
- `POST /api/v1/resume/ats` (`resumeText` or `parsedData`, and `jobText`)
- `POST /api/v1/resume/semantic-match` (`resumeText`, `jobText`)
- `POST /api/v1/resume/improve` (`text`)
- `POST /api/v1/resume/recommend` (`resumeText`, optional `limit`)
- `POST /api/interviewforge/upload` (multipart `file`; accepts `.pdf`, `.docx`, `.doc`, `.txt`)
- `POST /api/interviewforge/parse` (`text`)
- `POST /api/interviewforge/generate` (`resumeText` or `resumeId`, optional `skills`, `experienceSummary`, `targetRole`, `targetCompanies`, `interviewType`, `difficulty`, `maxQuestions`, `premium`)
- `POST /api/interviewforge/generate-async`
- `GET /api/interviewforge/jobs/:jobId`
- `GET /api/interviewforge/questions/:sessionId`
- `POST /api/interviewforge/mock/start`
- `POST /api/interviewforge/mock/:mockId/answer`
- `POST /api/interviewforge/evaluate`
- `POST /api/interviewforge/chat`
- `GET /api/interviewforge/preferences`
- `POST /api/interviewforge/preferences`
- `GET /api/interviewforge/insights`
- `POST /api/interviewforge/insights`
- `GET /api/interviewforge/sessions`
- `DELETE /api/interviewforge/session/:sessionId`
- `POST /api/interviewforge/questions/:sessionId/bookmark`

## InterviewForge Auth

- Protected InterviewForge endpoints accept `Authorization: Bearer <token>`.
- Set `INTERVIEWFORGE_JWT_SECRET` for JWT validation with `sub` and `scope` claims, and `INTERVIEWFORGE_API_TOKEN` for legacy dev token mode.
- If neither token setting is present, the routes still work in development mode without validation.

## Folder Structure

```text
src/
  config/         # env + DB
  controllers/    # request orchestration
  routes/         # API routes
  services/       # business logic + AI integrations
  repositories/   # DB access layer
  models/         # mongoose schemas
  middlewares/    # error handling
  utils/          # upload utility
public/
  test-ui.html    # API smoke test page
uploads/
  # uploaded resumes
```

## Notes
