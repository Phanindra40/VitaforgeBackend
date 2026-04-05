# VitaForge Frontend → Backend Requirements & API Contract

Date: 2026-02-27  
Scope: This document describes backend requirements based on the current frontend implementation.

---

## 1) Frontend Integration Summary

The current frontend directly calls backend endpoints only for:
1. AI summary generation
2. Contact message submission (endpoint provided by env var)

Authentication UI is implemented with Clerk on the frontend. Resume CRUD is currently stored in browser localStorage, not API.

---

## 2) Environment Variables Expected by Frontend

The frontend expects these environment variables:

- `VITE_CLERK_PUBLISHABLE_KEY`
  - Required for authentication UI.
- `VITE_CONTACT_ENDPOINT`
  - Required for Contact form POST target.
  - Can point to your backend endpoint, e.g. `http://localhost:5000/api/contact`.

Also note:
- Axios API base URL is currently hardcoded to `http://localhost:5000` in `src/api/axios.jsx`.
- All AI endpoints below are called relative to that base URL.

---

## 3) Required Endpoints (Used Right Now by Frontend)

## 3.1 POST /api/gemini/generate

Used by: Resume Summary section ("Use AI Writer")

### Request Body
```json
{
  "prompt": "Optimize this professional summary: <user_summary_text>"
}
```

### Success Response (200)
```json
{
  "text": "Improved professional summary text..."
}
```

### Frontend Behavior Dependency
- Frontend reads `res.data.text`.
- If `text` is missing, frontend falls back to empty string.

### Validation Rules (backend)
- `prompt`: required, string, non-empty
- Recommended max length: 8,000 characters

### Error Response (recommended)
```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "prompt is required"
  }
}
```

---

## 3.2 POST /api/gemini/summary-from-jd

Used by: Resume Summary section ("Generate from JD")

### Request Body
```json
{
  "jobDescription": "<job_description_text>"
}
```

### Success Response (200)
```json
{
  "text": "Generated professional summary from job description..."
}
```

### Frontend Behavior Dependency
- Frontend reads `res.data.text`.
- If `text` is missing, frontend falls back to empty string.

### Validation Rules (backend)
- `jobDescription`: required, string, non-empty
- Recommended max length: 12,000 characters

### Error Response (recommended)
```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "jobDescription is required"
  }
}
```

---

## 3.3 POST Contact Endpoint (from VITE_CONTACT_ENDPOINT)

Used by: Contact page form submit

### Request Body
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "message": "Hello...",
  "source": "VitaForge Contact Form"
}
```

### Success Response
- Any HTTP `2xx` response is treated as success.
- Response body is not required by current frontend.

### Frontend Behavior Dependency
- If response is not `ok` (`!response.ok`), frontend shows error state.
- If env var is not set, frontend does not submit and shows configuration error.

### Validation Rules (backend)
- `name`: required, string, 1..100 chars
- `email`: required, valid email format
- `message`: required, string, 1..5000 chars
- `source`: optional string

### Error Response (recommended)
```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid email"
  }
}
```

---

## 4) Auth Requirements (Current Frontend)

Current frontend auth is Clerk-native (`@clerk/clerk-react`) for sign-in/sign-up/OAuth.

### Backend requirement options

Option A (recommended): Keep Clerk
- Backend verifies Clerk JWT/session tokens for protected APIs.
- Protected endpoints should require `Authorization: Bearer <token>`.
- CORS must allow frontend origin and credentials if cookies are used.

Option B: Replace with custom auth
- Requires frontend auth refactor (not currently implemented).

### Important note
The shared axios instance has `withCredentials: true` and supports bearer token header via `setAuthToken(token)`.

---

## 5) Resume Data Model Used by Frontend

Even though resume data is currently localStorage-only, backend should use this schema for future API persistence.

## 5.1 Resume Object
```json
{
  "id": "uuid",
  "name": "My Resume",
  "template": "classic",
  "createdAt": "2026-02-27T00:00:00.000Z",
  "updatedAt": "2026-02-27T00:00:00.000Z",
  "personalInfo": {
    "FullName": "",
    "Email": "",
    "Phone": "",
    "GitHub": "",
    "LinkedIn": "",
    "customFields": [
      { "label": "", "value": "" }
    ]
  },
  "summary": "",
  "experiences": [
    {
      "role": "",
      "company": "",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "technologiesUsed": "",
      "description": ""
    }
  ],
  "projects": [
    {
      "name": "",
      "description": "",
      "technologies": "",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM"
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "description": ""
    }
  ],
  "skills": ["JavaScript", "React"],
  "sectionTitles": {
    "summary": "PROFESSIONAL SUMMARY",
    "experience": "PROFESSIONAL EXPERIENCE",
    "projects": "KEY PROJECTS",
    "education": "EDUCATION",
    "skills": "CORE COMPETENCIES"
  }
}
```

### Template enum currently used
- `classic`
- `modern`
- `minimal`
- `executive`
- `columns`
- `accent`
- `classicPlus`

---

## 6) Recommended Additional Endpoints (For Full Backend Migration)

These are not currently called by frontend code, but are needed if you want true server-side persistence instead of localStorage.

## 6.1 Resumes
- `GET /api/resumes` → list user resumes
- `POST /api/resumes` → create resume
- `GET /api/resumes/:id` → fetch single resume
- `PUT /api/resumes/:id` → full update
- `PATCH /api/resumes/:id` → partial update/autosave
- `DELETE /api/resumes/:id` → delete resume

## 6.2 Optional utility
- `POST /api/resumes/:id/duplicate`
- `GET /api/health`

---

## 7) Non-Functional Requirements

- CORS
  - Allow frontend origin(s): local dev (Vite) and production domain
  - Allow `Content-Type`, `Authorization`
  - Support credentials if cookie-based auth/session is used
- Rate limiting
  - Strong limit for AI endpoints and contact endpoint
- Security
  - Sanitize and validate all text fields
  - Add spam protection for contact (honeypot/reCAPTCHA/IP throttling)
- Logging/observability
  - Request ID, latency, error logs
- Performance
  - AI endpoints should return in reasonable time or stream (if upgraded later)

---

## 8) Frontend Error Handling Expectations

Current frontend error behavior is simple:
- AI endpoints: failure logs to console; user remains on form.
- Contact endpoint: shows generic failure message when non-2xx or network error.

Recommended backend error shape (consistent):
```json
{
  "error": {
    "code": "SOME_ERROR_CODE",
    "message": "Human readable message"
  }
}
```

---

## 9) Implementation Checklist (Backend)

1. Implement `POST /api/gemini/generate`
2. Implement `POST /api/gemini/summary-from-jd`
3. Implement `POST /api/contact` and set `VITE_CONTACT_ENDPOINT` to it
4. Configure CORS and auth verification strategy (Clerk recommended)
5. (Optional next) Add resume CRUD endpoints and migrate frontend storage layer

---

## 10) Notes About Current Frontend Constraints

- Resume create/edit/delete/preview currently reads/writes browser localStorage (`resumes`, `resumesData`).
- If you want backend persistence immediately, frontend storage utility must be replaced with API service calls.
- API base URL should eventually be env-configured (e.g. `VITE_API_URL`) instead of hardcoded.
