import React, { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_HEALTH = "/health";
const API_UPLOAD = "/api/docs/upload";
const API_CHAT_STREAM = "/api/chat/stream";
const API_RAG_RETRIEVE = "/api/rag/retrieve";
const API_REALTIME_SECRET = "/api/realtime/client_secret";

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseSseFrames(buffer) {
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

function safeJsonFromResponse(resp, fallbackText) {
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return resp.json();
  return resp.text().then((t) => {
    throw new Error(fallbackText ? `${fallbackText}: ${t}` : t);
  });
}

/**
 * Lesson 3 UI:
 * - Upload a PDF (build RAG index)
 * - Text chat (kept from Lesson 2)
 * - Voice call (Realtime WebRTC) — interruptible + PDF-scoped
 */
export default function App() {
  const [activeTab, setActiveTab] = useState("voice"); // "voice" | "text"

  // PDF / RAG
  const [doc, setDoc] = useState({ id: null, filename: "", pages: 0, chunks: 0 });
  const [uploading, setUploading] = useState(false);

  // Shared chat log (shows both text and voice interactions)
  const [messages, setMessages] = useState([
    {
      id: uid(),
      role: "assistant",
      content:
        "مرحباً! \n\n1) ارفع ملف PDF\n2) ثم ابدأ مكالمة صوتية واسأل عن محتوى الملف.\n\nYou can also switch to the Text tab for typed RAG chat.",
    },
  ]);

  // Text chat (Lesson 2)
  const [input, setInput] = useState("");
  const [isTextLoading, setIsTextLoading] = useState(false);

  // Voice call (Realtime)
  const [callStatus, setCallStatus] = useState("idle"); // idle | connecting | connected
  const [callError, setCallError] = useState("");

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const micStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Track current response for text deltas
  const responseToMsgIdRef = useRef(new Map());
  const pendingAssistantMsgIdRef = useRef(null);
  const currentResponseIdRef = useRef(null);

  // Meta
  const [meta, setMeta] = useState({ backendOk: null, model: "", latencyMs: null });
  const [error, setError] = useState("");

  const canUpload = useMemo(() => !uploading, [uploading]);
  const canTextSend = useMemo(
    () => !isTextLoading && !!doc.id && input.trim().length > 0,
    [isTextLoading, doc.id, input]
  );
  const canStartCall = useMemo(() => callStatus === "idle" && !!doc.id, [callStatus, doc.id]);
  const canHangup = useMemo(() => callStatus !== "idle", [callStatus]);

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

  function addMessage(role, content, extra = {}) {
    const msg = { id: uid(), role, content, ...extra };
    setMessages((prev) => [...prev, msg]);
    return msg.id;
  }

  function updateMessage(id, patch) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  // -------------------------
  // PDF Upload
  // -------------------------
  async function uploadPdf(file) {
    setError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const resp = await fetch(API_UPLOAD, { method: "POST", body: fd });
      const data = await safeJsonFromResponse(resp, "Upload failed");
      if (!resp.ok) throw new Error(data?.detail || "Upload failed");

      setDoc({ id: data.doc_id, filename: data.filename, pages: data.pages, chunks: data.chunks });
      addMessage(
        "assistant",
        `✅ PDF indexed: **${data.filename}**\n- pages: **${data.pages}**\n- chunks: **${data.chunks}**`
      );
    } catch (e) {
      setError(e?.message || "Upload error");
    } finally {
      setUploading(false);
      refreshHealth();
    }
  }

  // -------------------------
  // Text Chat (Lesson 2 kept)
  // -------------------------
  async function sendTextChat() {
    setError("");
    const text = input.trim();
    if (!text || !doc.id || isTextLoading) return;

    const userId = addMessage("user", text);
    const assistantId = addMessage("assistant", "");

    setInput("");
    setIsTextLoading(true);

    // Prepare conversation for backend (only role+content)
    const convo = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const t0 = performance.now();
    try {
      const resp = await fetch(API_CHAT_STREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: doc.id, messages: [...convo, { role: "user", content: text }] }),
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `Request failed (${resp.status})`);
      }
      if (!resp.body) throw new Error("Streaming not supported.");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let full = "";
      let sources = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;

        for (const frame of parsed.frames) {
          if (frame.event === "sources") sources = frame.data?.sources || [];
          if (frame.event === "delta") {
            full += frame.data?.delta || "";
            updateMessage(assistantId, { content: full, sources });
          }
          if (frame.event === "done") {
            const latencyMs = Math.round(performance.now() - t0);
            setMeta((m) => ({ ...m, latencyMs }));
          }
        }
      }
    } catch (e) {
      setError(e?.message || "Unknown error");
      updateMessage(assistantId, { content: `**Error:** ${e?.message || "Unknown error"}` });
    } finally {
      setIsTextLoading(false);
      refreshHealth();
    }
  }

  // -------------------------
  // Voice Call (Realtime WebRTC)
  // -------------------------
  function dcSend(obj) {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(obj));
  }

  function resetRealtimeState() {
    responseToMsgIdRef.current = new Map();
    pendingAssistantMsgIdRef.current = null;
    currentResponseIdRef.current = null;
  }

  async function startCall() {
    setCallError("");
    setError("");
    if (!doc.id) {
      setCallError("Upload a PDF first.");
      return;
    }
    setCallStatus("connecting");
    resetRealtimeState();

    try {
      // 1) Get ephemeral client secret from our backend
      const tokenResp = await fetch(API_REALTIME_SECRET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: doc.id, ttl_seconds: 600 }),
      });

      const tokenData = await safeJsonFromResponse(tokenResp, "Failed to get Realtime token");
      if (!tokenResp.ok) throw new Error(tokenData?.detail || "Failed to get Realtime token");
      const EPHEMERAL_KEY = tokenData.value;

      // 2) Create WebRTC peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio playback
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      remoteAudioRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      // Local mic
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = ms;
      pc.addTrack(ms.getTracks()[0]);

      // Data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        // Update session config (safe even if already set via client secret)
        dcSend({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            // Keep create_response false: we will create responses after RAG retrieval
            audio: {
              input: {
                turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
              },
            },
          },
        });

        // Ask model to greet in Arabic (welcome message)
        const assistantId = addMessage("assistant", "");
        pendingAssistantMsgIdRef.current = assistantId;

        dcSend({
          type: "response.create",
          response: {
            instructions:
              "ابدأ بتحية ترحيبية قصيرة بالعربية. قل أنك مساعد للإجابة عن أسئلة المستخدم حول ملف PDF المرفوع فقط، وأن المستخدم يمكنه مقاطعتك بالكلام في أي وقت. كن ودوداً ومختصراً.",
          },
        });
      });

      dc.addEventListener("message", async (e) => {
        let ev = null;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        handleRealtimeEvent(ev);
      });

      // 3) SDP offer/answer with OpenAI Realtime
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

      if (!sdpResp.ok) {
        const t = await sdpResp.text();
        throw new Error(`Realtime SDP failed (${sdpResp.status}): ${t}`);
      }

      const answer = { type: "answer", sdp: await sdpResp.text() };
      await pc.setRemoteDescription(answer);

      setCallStatus("connected");
      addMessage("assistant", "✅ Call connected. Speak now — you can interrupt the assistant anytime by talking.");
    } catch (e) {
      setCallError(e?.message || "Failed to start call");
      await hangup();
    }
  }

  async function hangup() {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}

    try {
      micStreamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}

    dcRef.current = null;
    pcRef.current = null;
    micStreamRef.current = null;
    remoteAudioRef.current = null;

    resetRealtimeState();
    setCallStatus("idle");
  }

  async function handleUserTranscript(transcript) {
    const t = (transcript || "").trim();
    if (!t) return;

    // Add user message to UI
    addMessage("user", t, { via: "voice" });

    // Retrieve sources via backend
    let sources = [];
    try {
      const r = await fetch(API_RAG_RETRIEVE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: doc.id, query: t, k: 5 }),
      });
      const data = await safeJsonFromResponse(r, "Retrieve failed");
      if (!r.ok) throw new Error(data?.detail || "Retrieve failed");
      sources = data.sources || [];
    } catch (e) {
      addMessage("assistant", `⚠️ Retrieval failed: ${e?.message || "unknown"}`);
      return;
    }

    const context = sources
      .map((s) => `${s.sid} (page ${s.page}, id ${s.chunk_id}):\n${s.text}`)
      .join("\n\n");

    const assistantId = addMessage("assistant", "", { sources, via: "voice" });
    pendingAssistantMsgIdRef.current = assistantId;

    // Create a model response that uses ONLY the retrieved context.
    dcSend({
      type: "response.create",
      response: {
        instructions:
          `You must answer the user's most recent question using ONLY the CONTEXT below.\n` +
          `If the answer is not in the context, say you cannot answer because it is not in the PDF.\n` +
          `Reply in Arabic by default (or match the user's language).\n` +
          `Cite sources inline like [S1], [S2].\n\n` +
          `CONTEXT:\n${context}`,
      },
    });
  }

  function handleRealtimeEvent(ev) {
    const type = ev?.type;

    // VAD speech started: user is interrupting
    if (type === "input_audio_buffer.speech_started") {
  // User started speaking. If the assistant is currently responding, cancel that response.
  if (currentResponseIdRef.current) {
    dcSend({ type: "response.cancel", response_id: currentResponseIdRef.current });
  }
  return;
}

    // User transcription final
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = ev?.transcript || "";
      handleUserTranscript(transcript);
      return;
    }

    // Response lifecycle
    if (type === "response.created") {
      const rid = ev?.response?.id;
      if (!rid) return;
      currentResponseIdRef.current = rid;

      // Map this response to the latest assistant placeholder we created.
      const msgId = pendingAssistantMsgIdRef.current;
      if (msgId) {
        responseToMsgIdRef.current.set(rid, msgId);
        pendingAssistantMsgIdRef.current = null;
      }
      return;
    }

    // Text deltas (text-mode) OR transcript deltas (audio-mode)
if (type === "response.output_text.delta" || type === "response.output_audio_transcript.delta") {
  const rid = ev?.response_id;
  const delta = ev?.delta || "";
  if (!rid || !delta) return;

  const msgId = responseToMsgIdRef.current.get(rid);
  if (!msgId) return;

  setMessages((prev) =>
    prev.map((m) => {
      if (m.id !== msgId) return m;
      return { ...m, content: (m.content || "") + delta };
    })
  );
  return;
}

// Final transcript (audio-mode)
if (type === "response.output_audio_transcript.done") {
  const rid = ev?.response_id;
  const transcript = ev?.transcript || "";
  if (!rid || !transcript) return;

  const msgId = responseToMsgIdRef.current.get(rid);
  if (!msgId) return;

  updateMessage(msgId, { content: transcript });
  return;
}


    if (type === "response.done") {
      const rid = ev?.response?.id;
      if (rid && currentResponseIdRef.current === rid) currentResponseIdRef.current = null;
      return;
    }

    if (type === "error") {
  const msg = ev?.error?.message || "Realtime error";
  // Ignore harmless cancellation errors (happens if we try to cancel when nothing is playing).
  if (typeof msg === "string" && msg.toLowerCase().includes("no active response")) {
    return;
  }
  setCallError(msg);
  return;
}
  }

  function clearChat() {
    setError("");
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Chat cleared.\n\nUpload a PDF, then start a voice call to ask questions about it.",
      },
    ]);
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (activeTab === "text") sendTextChat();
    }
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="title">Lesson 3 — Voice-to-Voice + RAG (PDF)</h1>
          <p className="subtitle">
            Upload a PDF, then talk live with an assistant (Realtime WebRTC). It will answer only from the PDF.
          </p>
        </div>
        <button className="btn danger" onClick={clearChat}>
          Clear chat
        </button>
      </div>

      <div className="grid">
        <div className="card">
          <label>1) Upload PDF (RAG index)</label>
          <input
            type="file"
            accept="application/pdf"
            disabled={!canUpload}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadPdf(f);
              e.target.value = "";
            }}
          />
          <div className="meta" style={{ marginTop: 12 }}>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Backend</span>
              <span>{meta.backendOk === null ? "…" : meta.backendOk ? "OK" : "Down"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Doc</span>
              <span>{doc.id ? "Loaded" : "None"}</span>
            </span>
            <span className="pill">
              <span style={{ color: "var(--muted)" }}>Chunks</span>
              <span>{doc.chunks || "—"}</span>
            </span>
          </div>

          {doc.id ? (
            <div className="meta">
              <span className="pill">
                <span style={{ color: "var(--muted)" }}>File</span>
                <span title={doc.filename}>{doc.filename || "—"}</span>
              </span>
              <span className="pill">
                <span style={{ color: "var(--muted)" }}>Pages</span>
                <span>{doc.pages}</span>
              </span>
            </div>
          ) : null}

          <div style={{ marginTop: 16 }}>
            <label>2) Choose mode</label>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className={"btn " + (activeTab === "voice" ? "primary" : "")}
                onClick={() => setActiveTab("voice")}
              >
                Voice Call
              </button>
              <button
                className={"btn " + (activeTab === "text" ? "primary" : "")}
                onClick={() => setActiveTab("text")}
              >
                Text Chat
              </button>
            </div>
          </div>

          {activeTab === "voice" ? (
            <div style={{ marginTop: 16 }}>
              <label>3) Voice Call (Realtime)</label>

              <div className="meta">
                <span className="pill">
                  <span style={{ color: "var(--muted)" }}>Status</span>
                  <span>{callStatus}</span>
                </span>
                <span className="pill">
                  <span style={{ color: "var(--muted)" }}>Interrupt</span>
                  <span>on (VAD)</span>
                </span>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="btn primary" disabled={!canStartCall} onClick={startCall}>
                  Start Call
                </button>
                <button className="btn" disabled={!canHangup} onClick={hangup}>
                  Hang up
                </button>
              </div>

              <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                Tip: You can interrupt the assistant by starting to talk.
              </div>

              {callError ? <div className="error">Call error: {callError}</div> : null}
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label>3) Text Chat (RAG)</label>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a question about the uploaded PDF… (Ctrl/Cmd + Enter)"
              />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 10 }}>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  Responses stream + show sources.
                </span>
                <button className={"btn primary"} disabled={!canTextSend} onClick={sendTextChat}>
                  {isTextLoading ? "Streaming..." : "Send"}
                </button>
              </div>
            </div>
          )}

          {error ? <div className="error">{error}</div> : null}
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

                {m.sources?.length ? (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.75)" }}>
                      Sources ({m.sources.length})
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      {m.sources.map((s) => (
                        <div key={s.sid} className="source">
                          <div className="sourceTitle">
                            <b>{s.sid}</b> — page {s.page}, id {s.chunk_id}
                          </div>
                          <div className="sourceText">{s.text}</div>
                        </div>
                      ))}
                    </div>
                  </details>
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
              <span style={{ color: "var(--muted)" }}>Mode</span>
              <span>{activeTab}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
