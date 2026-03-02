# Lesson 3 — Voice-to-Voice + RAG (PDF)

This lesson extends Lesson 2:

- Upload a PDF and build a RAG index (embeddings + similarity search)
- Use **OpenAI Realtime API over WebRTC** for a **live voice-to-voice call**
- The assistant greets in **Arabic** and answers **only from the uploaded PDF**
- The user can **interrupt** the assistant by speaking (VAD interrupt)

## Run with Docker

```bash
cp .env.example .env
# Set OPENAI_API_KEY
docker compose up --build
```

Open: http://localhost:8080

## Notes

- Your OpenAI API key stays server-side.
- The frontend requests a **Realtime client secret** from the backend (`/api/realtime/client_secret`),
  then connects to OpenAI Realtime directly via WebRTC.

## Key endpoints

- `POST /api/docs/upload` — upload & index PDF
- `POST /api/chat/stream` — text RAG streaming (same as Lesson 2, kept for reference)
- `POST /api/realtime/client_secret` — mint ephemeral Realtime token for the browser
- `POST /api/rag/retrieve` — debug retrieval endpoint (optional)

