# Lesson 1 Backend (FastAPI)

This backend uses the official OpenAI Python SDK.

- Preferred: **Responses API** (`client.responses.create`)
- Fallback: **Chat Completions** (`client.chat.completions.create`) if the SDK doesn't expose `.responses`

## Run (without Docker)

```bash
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- `GET /health`
- `POST /api/chat`
