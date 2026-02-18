import React, { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_HEALTH = "/health";
const API_UPLOAD = "/api/docs/upload";
const API_CHAT_STREAM = "/api/chat/stream";

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseSseFrames(buffer) {
  // SSE frames are separated by a blank line.
  // Each frame looks like:
  // event: delta
  // data: {...json...}
  //
  // Returns { frames: [{event, data}], rest }
  const frames = [];
  while (true) {
    const sepIndex = buffer.indexOf("\n\n");
    if (sepIndex === -1) break;

    const rawFrame = buffer.slice(0, sepIndex);
    buffer = buffer.slice(sepIndex + 2);

    const lines = rawFrame.split("\n").filter(Boolean);
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const dataText = dataLines.join("\n");
    let data = null;
    try {
      data = dataText ? JSON.parse(dataText) : null;
    } catch {
      data = { raw: dataText };
    }
    frames.push({ event, data });
  }
  return { frames, rest: buffer };
}

export default function App() {
  const [doc, setDoc] = useState(null); // {doc_id, filename, pages, chunks, embedding_model}
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    {
      id: uid(),
      role: "assistant",
      content:
        "### Lesson 2 — RAG Chatbot\n\n1) Upload a **PDF** on the left\n2) Ask a question\n\nI will answer using the PDF context and cite sources like **[S1]**.",
      sources: [],
    },
  ]);

  const [isLoading, setIsLoading] = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  const [meta, setMeta] = useState({
    model: "",
    embeddingModel: "",
    latencyMs: null,
    backendOk: null,
    docsLoaded: 0,
  });
  const [error, setError] = useState("");

  const abortRef = useRef(null);

  const canSend = useMemo(() => {
    return !isLoading && !!doc?.doc_id && input.trim().length > 0;
  }, [isLoading, doc, input]);

  async function refreshHealth() {
    try {
      const r = await fetch(API_HEALTH);
      const data = await r.json();
      setMeta((m) => ({
        ...m,
        backendOk: !!data?.ok,
        model: data?.model || m.model,
        embeddingModel: data?.embedding_model || m.embeddingModel,
        docsLoaded: data?.docs_loaded ?? m.docsLoaded,
      }));
    } catch {
      setMeta((m) => ({ ...m, backendOk: false }));
    }
  }

  React.useEffect(() => {
    refreshHealth();
  }, []);

  function updateMessage(id, patch) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function uploadPdf(file) {
    setUploadError("");
    setError("");
    if (!file) return;

    if (file.type && file.type !== "application/pdf") {
      setUploadError("Only PDF files are allowed.");
      return;
    }
    if (!file.name?.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only PDF files are allowed.");
      return;
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const resp = await fetch(API_UPLOAD, { method: "POST", body: fd });
      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data?.detail || `Upload failed (${resp.status})`);
      }

      setDoc(data);
      // Add a small assistant note in the chat
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: `✅ PDF indexed: **${data.filename}**\n\nPages: **${data.pages}** — Chunks: **${data.chunks}**\n\nNow ask a question.`,
          sources: [],
        },
      ]);
      refreshHealth();
    } catch (e) {
      setUploadError(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    setError("");
    const text = input.trim();
    if (!text || !doc?.doc_id || isLoading) return;

    const userMsg = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const assistantMsg = { id: assistantId, role: "assistant", content: "", sources: [] };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);
    setStreamingId(assistantId);

    const payloadMessages = [...messages, userMsg].map(({ role, content }) => ({ role, content }));

    const controller = new AbortController();
    abortRef.current = controller;

    const t0 = performance.now();

    try {
      const resp = await fetch(API_CHAT_STREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_id: doc.doc_id,
          messages: payloadMessages.filter((m) => m.role === "user" || m.role === "assistant"),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `Request failed (${resp.status})`);
      }
      if (!resp.body) throw new Error("Streaming not supported by the browser/response.");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let buffer = "";
      let full = "";
      let gotSources = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;

        for (const frame of parsed.frames) {
          if (frame.event === "delta") {
            const delta = frame.data?.delta || "";
            full += delta;
            updateMessage(assistantId, { content: full });
          } else if (frame.event === "sources") {
            const sources = frame.data?.sources || [];
            gotSources = true;
            updateMessage(assistantId, { sources });
          } else if (frame.event === "meta") {
            setMeta((m) => ({ ...m, model: frame.data?.model || m.model }));
          } else if (frame.event === "error") {
            throw new Error(frame.data?.error || "Unknown error");
          } else if (frame.event === "done") {
            // handled below
          }
        }
      }

      const latencyMs = Math.round(performance.now() - t0);
      setMeta((m) => ({ ...m, latencyMs }));

      if (!gotSources) {
        // If something went wrong with events, keep UI stable
        updateMessage(assistantId, { sources: [] });
      }
    } catch (e) {
      if (e?.name === "AbortError") setError("Request aborted.");
      else setError(e?.message || "Unknown error");
    } finally {
      setIsLoading(false);
      setStreamingId(null);
      abortRef.current = null;
      refreshHealth();
    }
  }

  function clearChat() {
    try {
      abortRef.current?.abort();
    } catch {}

    setError("");
    setMeta((m) => ({ ...m, latencyMs: null }));
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Chat cleared.\n\nUpload a PDF again (or keep the same one) and ask a new question.",
        sources: [],
      },
    ]);
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="title">Lesson 2 — RAG Chatbot (PDF)</h1>
          <p className="subtitle">
            Upload a PDF, then ask questions. Answers are generated using retrieved PDF chunks + citations.
            <br />
            <span style={{ color: "rgba(255,255,255,0.8)" }}>
              Send shortcut: <b>Ctrl</b>/<b>Cmd</b> + <b>Enter</b>
            </span>
          </p>
        </div>
        <button className="btn danger" onClick={clearChat}>
          Clear chat
        </button>
      </div>

      <div className="grid">
        <div className="card">
          <label>Upload PDF</label>

          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={uploading}
            onChange={(e) => uploadPdf(e.target.files?.[0])}
          />

          {uploading ? <div className="meta">Uploading & indexing…</div> : null}
          {uploadError ? <div className="error">Upload error: {uploadError}</div> : null}

          {doc ? (
            <div className="docCard">
              <div className="docTitle">{doc.filename}</div>
              <div className="docMeta">
                <span className="pill">
                  <span style={{ color: "var(--muted)" }}>doc_id</span>
                  <span>{doc.doc_id}</span>
                </span>
                <span className="pill">
                  <span style={{ color: "var(--muted)" }}>Pages</span>
                  <span>{doc.pages}</span>
                </span>
                <span className="pill">
                  <span style={{ color: "var(--muted)" }}>Chunks</span>
                  <span>{doc.chunks}</span>
                </span>
              </div>
            </div>
          ) : (
            <div className="meta">
              <span className="pill">
                <span style={{ color: "var(--muted)" }}>Status</span>
                <span>Upload a PDF to start</span>
              </span>
            </div>
          )}

          <div className="meta" style={{ marginTop: 12 }}>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Backend</span>
              <span>{meta.backendOk === null ? "…" : meta.backendOk ? "OK" : "Down"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Chat model</span>
              <span>{meta.model || "—"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Embedding</span>
              <span>{meta.embeddingModel || "—"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Latency</span>
              <span>{meta.latencyMs != null ? `${meta.latencyMs} ms` : "—"}</span>
            </span>
          </div>

          <div style={{ marginTop: 14 }}>
            <label>Question</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={doc ? 'Ask about the PDF…' : "Upload a PDF first…"}
            />
            <div style={{ display: "flex", marginTop: 10, justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {doc ? "Answers cite sources like [S1]." : "PDF required for RAG."}
              </span>
              <button className={"btn primary"} disabled={!canSend} onClick={send}>
                {isLoading ? "Streaming..." : "Send"}
              </button>
            </div>
          </div>

          {error ? <div className="error">Error: {error}</div> : null}
        </div>

        <div className="card">
          <label>Conversation</label>
          <div className="messages">
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.role === "assistant" ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <span>{m.content}</span>
                )}

                {m.role === "assistant" && (m.sources?.length ?? 0) > 0 ? (
                  <div className="sources">
                    <div className="sourcesTitle">Sources</div>
                    {m.sources.map((s) => (
                      <details key={s.sid} className="sourceItem">
                        <summary>
                          <b>[{s.sid}]</b> page {s.page} — id {s.chunk_id} — score {s.score}
                        </summary>
                        <pre>{s.text}</pre>
                      </details>
                    ))}
                  </div>
                ) : null}

                {isLoading && m.id === streamingId ? <span className="cursor">▍</span> : null}
              </div>
            ))}
          </div>
          <div className="meta">
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Messages</span>
              <span>{messages.length}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Index</span>
              <span>{doc ? "in memory (Lesson 2)" : "—"}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
