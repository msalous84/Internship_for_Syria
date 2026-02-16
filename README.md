# AI Internship Chatbots (Syria) — Lesson Repo

This repo is structured as a progression of lessons.

- `lessons/01-text-chatbot/` ✅ complete (Lesson 1 handout; Python backend + Docker Compose)
- `lessons/02-image-chatbot/` placeholder (Lesson 2)
- `lessons/03-voice-chatbot/` placeholder (Lesson 3)
- `lessons/04-integration-and-models/` placeholder (Lesson 4)

## Requirements

- Docker + Docker Compose (recommended)
- An OpenAI API key

## Run Lesson 1

```bash
cd lessons/01-text-chatbot
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
docker compose up --build
```

Then open: `http://localhost:8080`

## Notes

- The API key stays in the backend container (never in the browser).
- Frontend is served by Nginx and proxies `/api/*` to the backend.
