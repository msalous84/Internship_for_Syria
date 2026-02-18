import json
import io
import os
import time
import uuid
import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Literal, Optional, Tuple

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pypdf import PdfReader
from openai import OpenAI

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o").strip()
OPENAI_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small").strip()

RAG_TOP_K = int(os.getenv("RAG_TOP_K", "5"))
RAG_CHUNK_CHARS = int(os.getenv("RAG_CHUNK_CHARS", "1200"))
RAG_CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "200"))

app = FastAPI(title="Lesson 2 Backend (RAG)", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=OPENAI_API_KEY or None)


# -------------------------
# Data models
# -------------------------

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=20_000)


class RagChatRequest(BaseModel):
    doc_id: str = Field(..., min_length=1, max_length=100)
    messages: List[ChatMessage] = Field(default_factory=list, max_length=60)


class UploadResponse(BaseModel):
    doc_id: str
    filename: str
    pages: int
    chunks: int
    embedding_model: str


@dataclass
class Chunk:
    chunk_id: str
    page: int
    text: str


@dataclass
class DocumentIndex:
    filename: str
    pages: int
    chunks: List[Chunk]
    # shape: (n_chunks, dim), normalized for cosine similarity
    embeddings: np.ndarray


# In-memory store (simple for the lesson).
# In production: persist embeddings (vector DB) and store doc metadata.
DOCS: Dict[str, DocumentIndex] = {}


# -------------------------
# Helpers
# -------------------------

def _normalize_l2(vecs: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vecs / norms


def _chunk_text(text: str, chunk_chars: int, overlap: int) -> List[str]:
    # Normalize whitespace a bit
    cleaned = re.sub(r"[ \t]+", " ", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return []

    out = []
    start = 0
    n = len(cleaned)
    while start < n:
        end = min(n, start + chunk_chars)
        chunk = cleaned[start:end].strip()
        if chunk:
            out.append(chunk)
        if end == n:
            break
        start = max(0, end - overlap)
    return out


def _embed_texts(texts: List[str]) -> np.ndarray:
    # Batch to keep requests reasonable
    vectors: List[List[float]] = []
    batch_size = 64
    for i in range(0, len(texts), batch_size):
        batch = [t.replace("\n", " ") for t in texts[i : i + batch_size]]
        resp = client.embeddings.create(
            model=OPENAI_EMBEDDING_MODEL,
            input=batch,
        )
        for item in resp.data:
            vectors.append(item.embedding)
    arr = np.array(vectors, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[0] != len(texts):
        raise RuntimeError("Embedding shape mismatch.")
    return _normalize_l2(arr)


def _retrieve(doc: DocumentIndex, query: str, top_k: int) -> List[Tuple[Chunk, float]]:
    q_emb = _embed_texts([query])[0]  # normalized
    sims = doc.embeddings @ q_emb  # cosine similarity
    k = min(top_k, len(doc.chunks))
    idx = np.argpartition(-sims, kth=max(0, k - 1))[:k]
    ranked = sorted(((doc.chunks[i], float(sims[i])) for i in idx), key=lambda x: x[1], reverse=True)
    return ranked


def _sse(event: str, data_obj) -> str:
    # SSE frame: event + JSON data. Each event ends with an extra newline.
    return f"event: {event}\n" + f"data: {json.dumps(data_obj, ensure_ascii=False)}\n\n"


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": OPENAI_MODEL,
        "embedding_model": OPENAI_EMBEDDING_MODEL,
        "docs_loaded": len(DOCS),
    }


# -------------------------
# Upload PDF → build index
# -------------------------

@app.post("/api/docs/upload", response_model=UploadResponse)
def upload_pdf(file: UploadFile = File(...)):
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Missing OPENAI_API_KEY. Create .env from .env.example and set it.",
        )

    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    if file.content_type not in (None, "", "application/pdf"):
        # Some browsers don't set content_type reliably; extension check is main guard.
        pass

    raw = file.file.read()
    try:
        reader = PdfReader(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read PDF: {str(e)}")

    pages = len(reader.pages)
    if pages == 0:
        raise HTTPException(status_code=400, detail="PDF has no pages.")

    chunks: List[Chunk] = []
    for p in range(pages):
        txt = reader.pages[p].extract_text() or ""
        for ci, chunk_txt in enumerate(_chunk_text(txt, RAG_CHUNK_CHARS, RAG_CHUNK_OVERLAP)):
            chunk_id = f"p{p+1}-c{ci+1}"
            chunks.append(Chunk(chunk_id=chunk_id, page=p + 1, text=chunk_txt))

    if not chunks:
        raise HTTPException(
            status_code=400,
            detail="No extractable text found in this PDF. (If it's scanned images, you need OCR.)",
        )

    # Embed all chunks
    try:
        embeddings = _embed_texts([c.text for c in chunks])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")

    doc_id = uuid.uuid4().hex[:12]
    DOCS[doc_id] = DocumentIndex(
        filename=filename,
        pages=pages,
        chunks=chunks,
        embeddings=embeddings,
    )

    return UploadResponse(
        doc_id=doc_id,
        filename=filename,
        pages=pages,
        chunks=len(chunks),
        embedding_model=OPENAI_EMBEDDING_MODEL,
    )


# -------------------------
# RAG chat (streaming)
# -------------------------

@app.post("/api/chat/stream")
def rag_chat_stream(req: RagChatRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Missing OPENAI_API_KEY. Create .env from .env.example and set it.",
        )

    doc = DOCS.get(req.doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Unknown doc_id. Upload a PDF first.")

    # Find the latest user message as the query
    user_msgs = [m.content for m in req.messages if m.role == "user"]
    if not user_msgs:
        raise HTTPException(status_code=400, detail="No user message provided.")
    query = user_msgs[-1]

    # Retrieve top-k chunks
    ranked = _retrieve(doc, query, top_k=RAG_TOP_K)
    sources = []
    context_lines = []
    for i, (chunk, score) in enumerate(ranked, start=1):
        sid = f"S{i}"
        sources.append(
            {
                "sid": sid,
                "chunk_id": chunk.chunk_id,
                "page": chunk.page,
                "score": round(score, 4),
                "text": chunk.text,
            }
        )
        context_lines.append(f"{sid} (page {chunk.page}, id {chunk.chunk_id}):\n{chunk.text}")

    context = "\n\n---\n\n".join(context_lines)

    system_prompt = "\n".join(
        [
            "You are a helpful assistant. Answer the user using ONLY the provided CONTEXT.",
            "If the answer is not in the context, say you don't know and ask the user to upload a more relevant PDF.",
            "",
            "Citations rules:",
            "- When you use a piece of information from the context, cite it like [S1] or [S2].",
            "- You can cite multiple sources like [S1][S3].",
            "",
            "Write in the same language as the user's question.",
        ]
    )

    msgs = [
        {"role": "developer", "content": system_prompt},
        {"role": "user", "content": f"CONTEXT:\n{context}\n\nQUESTION:\n{query}"},
    ]

    def generate() -> Iterable[str]:
        t0 = time.time()
        # First: send meta and sources (so the UI can show them even while streaming)
        yield _sse(
            "meta",
            {
                "model": OPENAI_MODEL,
                "filename": doc.filename,
                "pages": doc.pages,
                "top_k": RAG_TOP_K,
                "latency_ms": None,
            },
        )
        yield _sse("sources", {"sources": sources})

        try:
            if hasattr(client, "responses"):
                stream = client.responses.create(
                    model=OPENAI_MODEL,
                    input=msgs,
                    stream=True,
                )
                for event in stream:
                    if getattr(event, "type", None) == "response.output_text.delta":
                        delta = getattr(event, "delta", None)
                        if delta:
                            yield _sse("delta", {"delta": delta})
            else:
                stream = client.chat.completions.create(
                    model=OPENAI_MODEL,
                    messages=msgs,
                    stream=True,
                )
                for chunk in stream:
                    choices = getattr(chunk, "choices", None) or []
                    if not choices:
                        continue
                    delta_obj = getattr(choices[0], "delta", None)
                    if not delta_obj:
                        continue
                    delta_text = getattr(delta_obj, "content", None)
                    if delta_text:
                        yield _sse("delta", {"delta": delta_text})
        except Exception as e:
            yield _sse("error", {"error": str(e)})
        finally:
            latency_ms = int((time.time() - t0) * 1000)
            yield _sse("done", {"latency_ms": latency_ms})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(generate(), media_type="text/event-stream", headers=headers)
