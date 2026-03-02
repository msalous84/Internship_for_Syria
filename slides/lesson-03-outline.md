# Lesson 3 — Voice-to-Voice + RAG (PDF) with OpenAI Realtime (WebRTC)

**Goal:** After uploading a PDF, start a **live voice call** with an AI assistant that answers **only from the PDF** (RAG).  
Default language **Arabic**, but works multilingual. User can **interrupt anytime** by speaking.

---

## Outcomes
- Connect to OpenAI **Realtime** using **WebRTC**
- Mint an **ephemeral client secret** from backend (keep API key safe)
- Implement **interruptible voice** (server VAD + response cancel)
- Convert speech → transcript → **RAG retrieval** → grounded response
- Stream assistant response transcript in UI + show sources

---

## What we are building (Architecture)
- Frontend:
  - Upload PDF → get `doc_id`
  - Start Call → WebRTC to OpenAI Realtime
  - Data channel receives events (transcripts + deltas)
- Backend:
  - PDF → extract → chunk → embed → store
  - `POST /api/realtime/client_secret` → ephemeral token for browser
  - `POST /api/rag/retrieve` → top-k chunks for a query

**Show files:**  
- `lessons/03-voice-chatbot/docker-compose.yml`  
- `lessons/03-voice-chatbot/frontend/nginx.conf`  
- `lessons/03-voice-chatbot/backend/app/main.py`

---

## Why Realtime?
- Normal chat: user speaks → upload audio → wait → response
- Realtime: interactive conversation like a call
- Enables:
  - low-latency audio
  - **interrupt** and turn-taking
  - live transcription events

---

## Security: Why do we need an ephemeral token?
- Browser must NOT receive your long-lived OpenAI API key
- Backend mints a **short-lived client secret** (ephemeral token)
- Browser uses that token to connect directly to OpenAI Realtime over WebRTC

**Show code:**  
`lessons/03-voice-chatbot/backend/app/main.py` → `create_realtime_client_secret()`

---

## Backend: Create Realtime client secret
- Validate `doc_id` exists (PDF uploaded)
- Send request to OpenAI to create ephemeral token + session defaults
- Return `{ value, expires_at }` to frontend

**Show snippet:**  
`backend/app/main.py` → inside `create_realtime_client_secret()`

```py
payload = {
  "expires_after": {"anchor": "created_at", "seconds": req.ttl_seconds},
  "session": {
    "type": "realtime",
    "model": OPENAI_REALTIME_MODEL,
    "output_modalities": ["audio"],
    "instructions": instructions,
    "audio": {
      "input": {
        "turn_detection": {
          "type": "server_vad",
          "create_response": False,
          "interrupt_response": True,
          "silence_duration_ms": 500
        },
        "transcription": {"model": OPENAI_TRANSCRIBE_MODEL}
      },
      "output": {"voice": OPENAI_REALTIME_VOICE}
    }
  }
}
````

---

## Prompting (Voice Assistant rules)

* Default language Arabic
* If user speaks another language, reply in that language
* **Scope rule:** answer ONLY from the uploaded PDF
* If not in PDF: refuse politely + say it’s out of document scope
* Cite sources like `[S1] [S2]`

**Where to edit:**
`lessons/03-voice-chatbot/backend/app/main.py` → `instructions = ...` in `create_realtime_client_secret()`

---

## WebRTC: What is happening?

* Browser creates `RTCPeerConnection`
* Adds microphone track (`getUserMedia`)
* Opens a data channel for events
* Exchanges SDP offer/answer with OpenAI Realtime endpoint
* Remote audio is played by the browser

**Show code:**
`lessons/03-voice-chatbot/frontend/src/App.jsx` → `startCall()`

---

## Frontend: Start Call (WebRTC handshake)

**Show snippet:**
`frontend/src/App.jsx` → `startCall()`

```js
const pc = new RTCPeerConnection();
const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(ms.getTracks()[0]);

const dc = pc.createDataChannel("oai-events");

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const sdpResp = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  body: offer.sdp,
  headers: {
    Authorization: `Bearer ${EPHEMERAL_KEY}`,
    "Content-Type": "application/sdp",
  },
});

await pc.setRemoteDescription({ type: "answer", sdp: await sdpResp.text() });
```

---

## Data channel events: our control plane

* We send commands to model:

  * `session.update` (optional)
  * `response.create` (make the assistant speak)
  * `response.cancel` (interrupt)
* We receive events:

  * user transcription complete
  * response transcript streaming deltas
  * response done
  * errors

**Show code:**
`lessons/03-voice-chatbot/frontend/src/App.jsx` → `dc.addEventListener("message", ...)` and `handleRealtimeEvent(ev)`

---

## Welcome message in Arabic

* When data channel opens:

  * create assistant bubble
  * ask model to greet in Arabic
  * explain scope (PDF only) + interruption supported

**Show code:**
`frontend/src/App.jsx` → inside `dc.addEventListener("open", ...)`

```js
dcSend({
  type: "response.create",
  response: {
    instructions:
      "ابدأ بتحية ترحيبية قصيرة بالعربية... أنت مساعد للإجابة عن أسئلة PDF فقط... يمكن للمستخدم مقاطعتك...",
  },
});
```

---

## Interrupt (user can talk anytime)

* Realtime sends an event when user starts speaking:

  * `input_audio_buffer.speech_started`
* We cancel current response (if one is active)

**Show code:**
`frontend/src/App.jsx` → `handleRealtimeEvent(ev)` speech start block

```js
if (type === "input_audio_buffer.speech_started") {
  if (currentResponseIdRef.current) {
    dcSend({ type: "response.cancel", response_id: currentResponseIdRef.current });
  }
  return;
}
```

---

## Speech → Text: capture user transcript

* When the user finishes speaking, we receive:

  * `conversation.item.input_audio_transcription.completed`
* We:

  1. add user message bubble
  2. trigger retrieval to get sources from the PDF
  3. send a grounded `response.create` with CONTEXT

**Show code:**
`frontend/src/App.jsx` → `handleRealtimeEvent` transcription block + `handleUserTranscript(transcript)`

---

## RAG retrieval for voice

* Use backend endpoint:

  * `POST /api/rag/retrieve`
* Backend returns top-k sources:

  * `S1, S2...` with page + chunk_id + text
* UI will show them under the assistant message

**Show code:**
Backend: `lessons/03-voice-chatbot/backend/app/main.py` → `rag_retrieve()`
Frontend: `frontend/src/App.jsx` → `handleUserTranscript()`

---

## Backend retrieval (cosine similarity)

* Embed query
* Similarity search over chunk vectors
* Return top-k chunks

**Show code (open):**
`lessons/03-voice-chatbot/backend/app/main.py` → `_retrieve(doc, query, top_k)`

---

## Grounded response.create (Voice)

* Build a context string from sources:

  * `S1 (page X): chunk text...`
* Then send `response.create` with strict instruction:

  * answer ONLY from context
  * cite `[S1] [S2]`
  * Arabic by default, match user language

**Show code snippet:**
`frontend/src/App.jsx` → `handleUserTranscript()`

```js
dcSend({
  type: "response.create",
  response: {
    instructions:
      `You must answer using ONLY the CONTEXT below... Cite like [S1].\n\nCONTEXT:\n${context}`,
  },
});
```

---

## Showing assistant text in the UI (audio transcript)

* Since output modality is `["audio"]`,
  we render text from transcript events:

  * `response.output_audio_transcript.delta`
  * `response.output_audio_transcript.done`

**Show code:**
`frontend/src/App.jsx` → `handleRealtimeEvent(ev)` transcript delta handlers

---

## Sources UI (expandable)

* Each assistant message can include `sources`
* UI shows a collapsible “Sources (N)” section
* Helps students verify grounding (“show me where in PDF”)

**Show code:**
`frontend/src/App.jsx` → rendering `m.sources` under messages

---

## Common issues & fixes

* Microphone permission denied → browser won’t send audio
* Upload too large → Nginx 413

  * fix: `client_max_body_size 100m;` in `frontend/nginx.conf`
* Session update error `Missing required parameter: session.type`

  * fix: add `type: "realtime"` inside `session.update`, or remove `session.update` entirely
* No response after user speaks:

  * ensure transcript event is received and retrieval endpoint works

---

## Run lesson 3 (Docker)

```bash
cd lessons/03-voice-chatbot
cp .env.example .env
# set OPENAI_API_KEY
docker compose up --build
```

Open:

* UI: `http://localhost:8080`
* Backend: `http://localhost:8000/health`

---

## Student tasks (great internship exercises)

* Improve chunking (semantic splitting, headings)
* Make citations clickable: click `[S1]` → scroll/open source block
* Add multi-document support (select which PDF)
* Add conversation memory rules (limit context length)
* Evaluate Arabic PDFs and embedding model choices
* Add safe fallback: if retrieval is weak, ask clarifying question

---

## Demo flow (recommended)

1. Upload PDF → show “pages/chunks”
2. Start Call → Arabic welcome message
3. Ask Arabic question → show transcript + sources + answer
4. Interrupt mid-answer → show the assistant stops
5. Ask off-topic question → show refusal (PDF-only rule)
