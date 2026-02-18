# Lesson 2 — RAG Chatbot (PDF)

This lesson extends Lesson 1 by adding **Retrieval-Augmented Generation (RAG)**:

1. Upload a **PDF**
2. Backend extracts text and splits it into **chunks**
3. Backend creates **embeddings** for each chunk and stores them in an in-memory “vector index”
4. For every question, the backend:
   - embeds the question
   - retrieves the **top-k** most similar chunks
   - sends them as **CONTEXT** to the chat model
   - streams the answer **token-by-token**
   - returns the retrieved chunks as **Sources** (shown in the UI)

## Run

```bash
cp .env.example .env
# set OPENAI_API_KEY
docker compose up --build
```

Open:
- UI: `http://localhost:8080`
- Backend health: `http://localhost:8000/health`

## Notes

- The vector index is stored in memory only (restart clears it).
- Default embedding model is `text-embedding-3-small`. For better multilingual retrieval, try `text-embedding-3-large`.

## Student tasks (good exercises)

- Improve chunking (by tokens, by headings, by semantic splitting)
- Add OCR for scanned PDFs
- Replace the in-memory index with a real vector DB (FAISS / Qdrant / Weaviate / pgvector)
- Evaluate different embedding models (Arabic vs English PDFs)
