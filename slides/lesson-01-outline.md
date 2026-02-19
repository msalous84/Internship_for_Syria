# Lesson 1 — Text Chatbot (FastAPI + React + Docker + Streaming)

**Goal:** Build a text chatbot with a secure backend, then add streaming like ChatGPT.

---

## Outcomes
- Build a **text chatbot** using OpenAI API
- Understand **messages + roles** (developer/user/assistant)
- Keep API key in backend (security)
- Add **streaming** (token-by-token)
- Run everything via **Docker Compose**

---

## What we are building (Architecture)
- React UI in browser
- Nginx serves UI and proxies `/api/*`
- FastAPI backend calls OpenAI
- Docker Compose runs frontend + backend

**Live demo:** show UI at `http://localhost:8080`

**Show code:**  
- `lessons/01-text-chatbot/docker-compose.yml`  
- `lessons/01-text-chatbot/frontend/nginx.conf`

---

## Why a backend? (Security + control)
- API key must **never** be shipped to the browser
- Backend controls:
  - prompt / specialization rules
  - logging + future rate-limits
  - model selection

**Show file:**  
- `lessons/01-text-chatbot/.env.example`

---

## Prompting concept: Specialization
- A chatbot is “specialized” by giving it:
  - a topic
  - behavior rules and constraints
- We inject a **developer prompt** before conversation messages

**Show code snippet:**  
`lessons/01-text-chatbot/backend/app/main.py` → `_build_messages()`

```py
developer_prompt = "\n".join([
  "You are a helpful chatbot specialized in the following topic:",
  f"TOPIC: {req.specialization}",
  "",
  "Rules:",
  "- Be friendly and clear.",
  "- If the user asks something outside the TOPIC, politely say it's out of scope and steer back.",
  "- When you provide code, keep it minimal and runnable.",
])

msgs = [{"role": "developer", "content": developer_prompt}]
msgs.extend([{"role": m.role, "content": m.content} for m in req.messages])
````

---

## Message roles (Developer / User / Assistant)

* **developer:** instructions + guardrails (your system design)
* **user:** question / request
* **assistant:** generated response
* In Lesson 1, frontend stores conversation in the browser and sends it each request

**Show code:**

* Backend: `backend/app/main.py` → `_build_messages()`
* Frontend: `frontend/src/App.jsx` → `send()`

---

## API endpoints

* `GET /health`
* `POST /api/chat` (non-streaming, reference)
* `POST /api/chat/stream` (streaming, used by UI)

**Show code:**
`lessons/01-text-chatbot/backend/app/main.py`

---

## Streaming: Why it matters

* Better UX: users see response immediately
* Feels interactive like ChatGPT
* Enables “Stop generating” later

---

## Backend streaming (OpenAI → FastAPI)

* Call OpenAI with `stream=True`
* Forward text deltas via FastAPI `StreamingResponse`
* Disable buffering headers for proxies

**Show code:**
`lessons/01-text-chatbot/backend/app/main.py` → `chat_stream()`

```py
stream = client.responses.create(
  model=OPENAI_MODEL,
  input=msgs,
  stream=True,
)

for event in stream:
  if event.type == "response.output_text.delta":
    yield event.delta
```

```py
return StreamingResponse(
  generate(),
  media_type="text/plain; charset=utf-8",
  headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
)
```

---

## Frontend streaming (ReadableStream)

* Use `fetch()` and read `resp.body.getReader()`
* Append chunks into assistant bubble continuously

**Show code:**
`lessons/01-text-chatbot/frontend/src/App.jsx` → inside `send()`

```js
const reader = resp.body.getReader();
const decoder = new TextDecoder("utf-8");

let full = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  full += chunk;
  updateMessage(assistantId, { content: full });
}
```

---

## Nginx proxy config (Streaming critical)

* Frontend container runs Nginx
* Proxies `/api/*` to backend container
* Must set buffering off to avoid “all-at-once” output

**Show code:**
`lessons/01-text-chatbot/frontend/nginx.conf`

```nginx
location /api/ {
  proxy_pass http://backend:8000/api/;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600;
}
```

---

## Run the project (Docker Compose)

```bash
cd lessons/01-text-chatbot
cp .env.example .env
# set OPENAI_API_KEY
docker compose up --build
```

Open:

* UI: `http://localhost:8080`
* Backend health: `http://localhost:8000/health`

---

## Debug checklist

* `localhost:8000/` returns 404 → normal (no root route)
* No output / error → check `OPENAI_API_KEY`
* Streaming feels slow → verify Nginx buffering off
* Wrong model name → OpenAI error

Commands:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

---

## Exercises (students)

* Make the bot refuse off-topic questions more strictly
* Add “Stop generating” button (AbortController)
* Add localStorage persistence for chat
* Add better prompt templates (templates + examples)