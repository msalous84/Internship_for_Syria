# Lesson 2 — RAG Chatbot (PDF Upload + Embeddings + Retrieval + Citations)

**Goal:** Chat with a PDF using RAG and show sources.

---

## Outcomes
- Upload a PDF
- Extract text + chunk it
- Embed chunks and query
- Retrieve top chunks (similarity search)
- Answer grounded in sources with citations like `[S1]`
- Show sources in UI (expandable / separate section)

---

## What is RAG?
- Retrieval-Augmented Generation
- Combine:
  - **Search**: find relevant passages from document
  - **Generation**: LLM writes answer using only retrieved context
- Why: PDFs are private knowledge; model doesn’t automatically know them

---

## RAG pipeline (end-to-end)
1) Upload PDF  
2) Extract text  
3) Chunk text  
4) Embed chunks  
5) Embed user query  
6) Similarity search (top-k)  
7) Prompt LLM with retrieved context  
8) Answer + citations + show chunks

---

## UI changes vs Lesson 1
- Left panel becomes: **PDF upload**
- After upload, UI shows file info (pages/chunks)
- Chat uses the uploaded `doc_id`

**Show code:**  
`lessons/02-rag-chatbot/frontend/src/App.jsx` → `uploadPdf()`

---

## Backend: Upload endpoint
- Accept file upload (`UploadFile`)
- Validate PDF
- Extract text (pypdf)
- Chunk + embed + store index (in memory for lesson)

**Show code:**  
`lessons/02-rag-chatbot/backend/app/main.py` → `upload_pdf()`

Suggested snippet to show:
```py
@app.post("/api/docs/upload", response_model=UploadResponse)
def upload_pdf(file: UploadFile = File(...)):
  raw = file.file.read()
  reader = PdfReader(io.BytesIO(raw))
  text = "\n".join(page.extract_text() or "" for page in reader.pages)

  chunks = _chunk_text(text)
  vectors = _embed_texts([c.text for c in chunks])
  DOCS[doc_id] = DocumentIndex(chunks=chunks, embeddings=vectors)
  return UploadResponse(doc_id=doc_id, pages=len(reader.pages), chunks=len(chunks))
````

---

## Chunking strategy (why)

* Embeddings + search works on chunks, not whole book
* Chunk size trades off:

  * too large → noisy
  * too small → missing context
* Use overlap to preserve continuity

**Show code:**
`lessons/02-rag-chatbot/backend/app/main.py` → `_chunk_text()`

Suggested snippet:

```py
while start < n:
  end = min(n, start + chunk_chars)
  out.append(cleaned[start:end].strip())
  start = max(0, end - overlap)
```

---

## Embeddings: turning text into vectors

* Embed:

  * chunks once at upload time
  * user query at question time
* Default embedding model is good enough for the internship
* Student task: compare Arabic vs English embedding models

**Show code:**
`lessons/02-rag-chatbot/backend/app/main.py` → `_embed_texts()`

Snippet:

```py
resp = client.embeddings.create(
  model=OPENAI_EMBEDDING_MODEL,
  input=batch,
)
vectors.append(item.embedding)
```

---

## Similarity search (cosine similarity)

* Normalize vectors
* Compute similarity between query vector and all chunk vectors
* Pick top-k chunks as “sources”

**Show code:**
`lessons/02-rag-chatbot/backend/app/main.py` → `_retrieve()`

Snippet:

```py
q = _embed_texts([query])[0]     # normalized
sims = doc.embeddings @ q        # cosine similarity
top_idx = np.argpartition(-sims, kth=k-1)[:k]
```

---

## Grounded answering with citations

* Build a context block like:

  * `S1: (page X) ...chunk text...`
  * `S2: ...`
* Rules:

  * Answer only from context
  * If missing: say it’s not in the document
  * Cite sources in answer: `[S1] [S2]`

**Show code:**
`lessons/02-rag-chatbot/backend/app/main.py` → `rag_chat_stream()`

---

## Streaming + sources to UI (SSE)

* We stream structured events:

  * `meta`
  * `sources`
  * `delta` (text tokens)
  * `done`
* UI can show sources immediately while answer streams

**Show code:**
Backend: `backend/app/main.py` → `_sse()` + `rag_chat_stream()`
Frontend: `frontend/src/App.jsx` → SSE parsing in `send()`

---

## Backend SSE event idea (snippet)

```py
yield _sse("sources", {"sources": sources})
...
yield _sse("delta", {"delta": delta})
yield _sse("done", {"latency_ms": latency_ms})
```

---

## Frontend: parse SSE + update UI (snippet)

```js
for (const frame of frames) {
  if (frame.event === "delta") full += frame.data.delta;
  if (frame.event === "sources") updateMessage(assistantId, { sources: frame.data.sources });
}
updateMessage(assistantId, { content: full });
```

**Show code:**
`lessons/02-rag-chatbot/frontend/src/App.jsx` → `send()` + `parseSseFrames()`

---

## Upload size limits (Nginx)

* Upload can fail with 413 if file is too large
* Fix in `nginx.conf`:

  * `client_max_body_size 100m;` (example)

**Show code:**
`lessons/02-rag-chatbot/frontend/nginx.conf`

---

## Limitations & improvements

* Scanned PDFs → no text (need OCR)
* In-memory index is lost on restart → use vector DB
* Large PDFs cost more embeddings/time
* Production needs auth, rate limiting, malware scanning

---

## Student tasks (RAG extensions)

* Better chunking (tokens / headings / semantic)
* Compare embedding models (Arabic vs English)
* Add multi-document support (select doc)
* Replace in-memory with FAISS/Qdrant/pgvector
* Make citations clickable → scroll to source chunk

---

## Run the project (Docker)

```bash
cd lessons/02-rag-chatbot
cp .env.example .env
# set OPENAI_API_KEY
docker compose up --build
```

Open:

* UI: `http://localhost:8080`
* Backend health: `http://localhost:8000/health`