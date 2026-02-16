import React, { useMemo, useRef, useState } from "react";

const API_CHAT_STREAM = "/api/chat/stream";
const API_HEALTH = "/health";

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [specialization, setSpecialization] = useState(
    "AI internship mentor: building chatbots with the OpenAI API (text)."
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    {
      id: uid(),
      role: "assistant",
      content:
        "Hi! Set a specialization (topic) on the left, then ask me something.\n\nTry: “Explain how a chatbot prompt works” or “Write a FastAPI endpoint that calls OpenAI.”",
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  const [meta, setMeta] = useState({ model: "", latencyMs: null, backendOk: null });
  const [error, setError] = useState("");

  const abortRef = useRef(null);

  const canSend = useMemo(() => {
    return !isLoading && specialization.trim().length > 0 && input.trim().length > 0;
  }, [isLoading, specialization, input]);

  async function refreshHealth() {
    try {
      const r = await fetch(API_HEALTH);
      const data = await r.json();
      setMeta((m) => ({ ...m, backendOk: !!data?.ok, model: data?.model || m.model }));
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

  async function send() {
    setError("");
    const text = input.trim();
    if (!text || !specialization.trim() || isLoading) return;

    const userMsg = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const assistantMsg = { id: assistantId, role: "assistant", content: "" };

    // Update UI immediately
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);
    setStreamingId(assistantId);

    // Prepare payload messages (exclude the empty assistant placeholder)
    const payloadMessages = [...messages, userMsg].map(({ role, content }) => ({ role, content }));

    const controller = new AbortController();
    abortRef.current = controller;

    const t0 = performance.now();
    try {
      const resp = await fetch(API_CHAT_STREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specialization,
          messages: payloadMessages.filter((m) => m.role === "user" || m.role === "assistant"),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `Request failed (${resp.status})`);
      }

      if (!resp.body) {
        throw new Error("Streaming not supported by the browser/response.");
      }

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

      const latencyMs = Math.round(performance.now() - t0);
      setMeta((m) => ({ ...m, latencyMs }));
    } catch (e) {
      if (e?.name === "AbortError") {
        // If we add "Stop" later, this will be used.
        setError("Request aborted.");
      } else {
        setError(e?.message || "Unknown error");
      }
    } finally {
      setIsLoading(false);
      setStreamingId(null);
      abortRef.current = null;
      refreshHealth();
    }
  }

  function clearChat() {
    // If streaming, abort it
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
          "Chat cleared.\n\nTip: change the specialization to make me a different kind of assistant.",
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
          <h1 className="title">Lesson 1 — Text Chatbot</h1>
          <p className="subtitle">
            Streaming enabled (token-by-token).
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
          <label>Specialization (developer prompt topic)</label>
          <textarea
            value={specialization}
            onChange={(e) => setSpecialization(e.target.value)}
            placeholder="e.g., “PowerFactory coding assistant”"
          />

          <div className="meta" style={{ marginTop: 12 }}>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Backend</span>
              <span>{meta.backendOk === null ? "…" : meta.backendOk ? "OK" : "Down"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Model</span>
              <span>{meta.model || "—"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Latency</span>
              <span>{meta.latencyMs != null ? `${meta.latencyMs} ms` : "—"}</span>
            </span>
          </div>

          <div style={{ marginTop: 14 }}>
            <label>Message</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='Try: “Explain message roles: developer vs user”'
            />
            <div style={{ display: "flex", marginTop: 10, justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Streaming: text appears as it is generated.
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
                {m.content}
                {isLoading && m.id === streamingId ? (
                  <span style={{ color: "rgba(255,255,255,0.55)" }}>▍</span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="meta">
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Messages</span>
              <span>{messages.length}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>State</span>
              <span>stored in browser (Lesson 1)</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
