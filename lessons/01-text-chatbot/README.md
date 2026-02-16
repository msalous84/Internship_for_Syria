# Lesson 1 — Text Chatbot (Python backend + Docker Compose)

You build a **text-based chatbot** specialized to a topic using a **developer prompt** — now with **streaming** so the response appears as it’s generated (like ChatGPT).

## Run with Docker

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
docker compose up --build
```

Open:
- UI: `http://localhost:8080`
- Backend health: `http://localhost:8000/health`

## API

- `POST /api/chat/stream`  (streaming; used by frontend)
- `POST /api/chat`         (non-streaming; kept for reference)
