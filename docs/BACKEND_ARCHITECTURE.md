# Backend Architecture Overview

## Runtime Flow

- `Server.js` boots the app and starts the HTTP server.
- `src/app.js` configures Express, security middleware, static assets, auth gates, and route mounting.
- `src/routes/index.js` exposes the shared API router under `/api` and `/api/v1`.

## Current Folder Structure

```text
src/
  config/        env, database, cache
  controllers/   request handlers
  middlewares/   auth and error handlers
  models/        mongoose schemas
  repositories/  persistence access helpers
  routes/        API route definitions
  services/      business logic and third-party integrations
  utils/         upload helpers and logger
public/          test UI and login page
uploads/         stored uploaded files
```

## Major Cleanup Completed

- Removed the Groq route collision so `/api/gemini` now only serves Gemini endpoints.
- Replaced noisy console logging in runtime code with `src/utils/logger.js`.
- Split Groq-specific text generation into `src/services/groq.service.js` for clearer ownership.
- Repointed AI consumers to the new Groq service and left `src/services/ai.service.js` as a compatibility shim that re-exports the Groq service.

## Validation

- The route module loads cleanly.
- The main app module loads cleanly.
- Updated controllers and services pass syntax validation.

## Notes

- The test UI login flow is still handled inside `src/app.js` for compatibility.
- The legacy `ai.service.js` implementation now acts as a compatibility shim; new code should import `src/services/groq.service.js` directly.
