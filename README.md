# AI Internship Chatbots (Syria) — Lesson Repo

This repo is structured as a progression of lessons.

- `lessons/01-text-chatbot/` ✅ Text chatbot (prompting + streaming + Markdown)
- `lessons/02-rag-chatbot/` ✅ RAG chatbot (upload PDF → chunk → embed → retrieve sources)
- `lessons/03-voice-chatbot/` placeholder (Lesson 3: voice)
- `lessons/04-integration-and-models/` placeholder (Lesson 4: integration + other models)

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

Open: `http://localhost:8080`

## Run Lesson 2 (RAG)

```bash
cd lessons/02-rag-chatbot
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
docker compose up --build
```

Open: `http://localhost:8080`

> Tip: run **one lesson at a time**, because each lesson uses the same default ports (8080/8000).
