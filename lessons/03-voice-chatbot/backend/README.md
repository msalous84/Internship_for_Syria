# Lesson 2 Backend — RAG (FastAPI)

Endpoints:
- `POST /api/docs/upload` (multipart/form-data, PDF) → returns `doc_id`
- `POST /api/chat/stream` (SSE over HTTP) → streams answer tokens + sources

Notes:
- This lesson stores the vector index **in memory** (DOCS dict). Restarting the container clears it.
- We use OpenAI embeddings (default `text-embedding-3-small`). You can switch to `text-embedding-3-large` for better multilingual retrieval.

See OpenAI docs:
- Embeddings guide
- Streaming responses
