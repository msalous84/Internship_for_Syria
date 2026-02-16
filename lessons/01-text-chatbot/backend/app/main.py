import os
import time
from typing import List, Literal, Iterable, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from openai import OpenAI

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o").strip()

app = FastAPI(title="Lesson 1 Backend", version="1.1.0")

# CORS is useful if you call the backend directly during dev.
# With Docker Compose, the frontend uses an Nginx proxy so CORS isn't required.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=OPENAI_API_KEY or None)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=10_000)


class ChatRequest(BaseModel):
    specialization: str = Field(..., min_length=1, max_length=400)
    messages: List[ChatMessage] = Field(default_factory=list, max_length=40)


class ChatResponse(BaseModel):
    text: str
    model: str
    latencyMs: int


@app.get("/health")
def health():
    return {"ok": True, "model": OPENAI_MODEL}


def _build_messages(req: ChatRequest):
    developer_prompt = "\n".join(
        [
            "You are a helpful chatbot specialized in the following topic:",
            f"TOPIC: {req.specialization}",
            "",
            "Rules:",
            "- Be friendly and clear.",
            "- If the user asks something outside the TOPIC, politely say it's out of scope and steer back.",
            "- When you provide code, keep it minimal and runnable.",
        ]
    )

    msgs = [{"role": "developer", "content": developer_prompt}]
    msgs.extend([{"role": m.role, "content": m.content} for m in req.messages])
    return msgs


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    """Non-streaming endpoint (kept for reference / fallback)."""
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Missing OPENAI_API_KEY. Create .env from .env.example and set it.",
        )

    t0 = time.time()
    msgs = _build_messages(req)

    try:
        # Preferred: Responses API
        if hasattr(client, "responses"):
            resp = client.responses.create(model=OPENAI_MODEL, input=msgs)
            text = getattr(resp, "output_text", "") or ""
        else:
            # Fallback: chat completions
            comp = client.chat.completions.create(model=OPENAI_MODEL, messages=msgs)
            text = (comp.choices[0].message.content or "").strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    latency_ms = int((time.time() - t0) * 1000)
    return ChatResponse(text=text, model=OPENAI_MODEL, latencyMs=latency_ms)


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    """Streaming endpoint.

    The response body is streamed as *plain text deltas* (no SSE framing).
    The frontend reads the HTTP stream and appends chunks as they arrive.

    Note: When proxying through Nginx, buffering must be disabled (see nginx.conf).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Missing OPENAI_API_KEY. Create .env from .env.example and set it.",
        )

    msgs = _build_messages(req)

    def generate() -> Iterable[str]:
        try:
            # Preferred: Responses API streaming events
            if hasattr(client, "responses"):
                stream = client.responses.create(
                    model=OPENAI_MODEL,
                    input=msgs,
                    stream=True,
                )
                for event in stream:
                    # We only forward text deltas to the client.
                    if getattr(event, "type", None) == "response.output_text.delta":
                        delta = getattr(event, "delta", None)
                        if delta:
                            yield delta
            else:
                # Fallback: Chat Completions streaming
                stream = client.chat.completions.create(
                    model=OPENAI_MODEL,
                    messages=msgs,
                    stream=True,
                )
                for chunk in stream:
                    # Some chunks can have empty choices; guard carefully.
                    choices = getattr(chunk, "choices", None) or []
                    if not choices:
                        continue
                    delta_obj = getattr(choices[0], "delta", None)
                    if not delta_obj:
                        continue
                    delta_text = getattr(delta_obj, "content", None)
                    if delta_text:
                        yield delta_text
        except Exception as e:
            # Send error to client as text (frontend will display it).
            yield f"\n\n[ERROR] {str(e)}\n"

    headers = {
        "Cache-Control": "no-cache",
        # Prevent Nginx (and some proxies) from buffering streaming responses.
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8", headers=headers)
