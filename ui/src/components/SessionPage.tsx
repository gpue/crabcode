import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getComposerOptions, getEventsUrl, getSessionDetail, sendMessage, stopSession } from "../lib/api";
import type { AgentMode, ComposerOptions, PromptOptions, ProviderModelOption, SessionDetail, StreamEnvelope } from "../lib/types";
import { ConversationMessage } from "./ConversationMessage";
import { Icon } from "./Icon";
import { TerminalPanel } from "./TerminalPanel";
import { WorkspacePanel } from "./WorkspacePanel";

export function SessionPage() {
  const { sessionId = "" } = useParams();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [options, setOptions] = useState<ComposerOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [providerID, setProviderID] = useState("");
  const [modelID, setModelID] = useState("");
  const [variant, setVariant] = useState("medium");
  const [mode, setMode] = useState<AgentMode>("plan");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  function scrollTimelineToBottom() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }

  useEffect(() => {
    getComposerOptions()
      .then((data) => {
        setOptions(data);
        if (data.defaultModel) {
          setProviderID(data.defaultModel.providerID);
          setModelID(data.defaultModel.modelID);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load composer options"));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let refreshPending = false;
    let refreshInFlight = false;

    const refresh = () => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }

      refreshInFlight = true;
      getSessionDetail(sessionId)
        .then((data) => {
          if (!cancelled) {
            setDetail(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load conversation");
        })
        .finally(() => {
          refreshInFlight = false;
          if (!cancelled) setLoading(false);
          if (refreshPending && !cancelled) {
            refreshPending = false;
            window.setTimeout(refresh, 0);
          }
        });
    };

    setLoading(true);
    refresh();
    const interval = window.setInterval(refresh, 2500);

    const stream = new EventSource(getEventsUrl(sessionId));
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamEnvelope;
        if (!payload.event || payload.event.startsWith("message.") || payload.event.startsWith("session.")) {
          refresh();
        }
      } catch {
        refresh();
      }
    };
    stream.onerror = () => {};

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      stream.close();
    };
  }, [sessionId]);

  const selectedModel = useMemo(
    () => options?.models.find((item) => item.providerID === providerID && item.modelID === modelID) ?? null,
    [modelID, options, providerID],
  );

  const groupedModels = useMemo(() => {
    const groups = new Map<string, ProviderModelOption[]>();
    for (const item of options?.models ?? []) {
      const existing = groups.get(item.providerID);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.providerID, [item]);
      }
    }
    return Array.from(groups.entries()).map(([provider, models]) => ({ provider, models }));
  }, [options]);

  const selectedModelValue = providerID && modelID ? `${providerID}::${modelID}` : "";

  useEffect(() => {
    if (!options?.models.length) return;
    const hasSelection = options.models.some((item) => item.providerID === providerID && item.modelID === modelID);
    if (hasSelection) return;
    if (options.defaultModel) {
      setProviderID(options.defaultModel.providerID);
      setModelID(options.defaultModel.modelID);
      return;
    }
    const [first] = options.models;
    setProviderID(first.providerID);
    setModelID(first.modelID);
  }, [modelID, options, providerID]);

  const latestAssistant = useMemo(() => {
    const messages = detail?.messages ?? [];
    return [...messages].reverse().find((message) => (message.info?.role || message.role) === "assistant") ?? null;
  }, [detail]);

  const waitingForInput = useMemo(() => {
    const parts = latestAssistant?.parts ?? [];
    return parts.some((part) => part.type === "tool" && (part as { state?: { status?: string } }).state?.status === "running");
  }, [latestAssistant]);

  useEffect(() => {
    window.requestAnimationFrame(() => scrollTimelineToBottom());
  }, [detail?.messages.length, detail?.running]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!sessionId || !prompt.trim() || !providerID || !modelID) return;
    setSending(true);
    try {
      const payload: PromptOptions = { providerID, modelID, variant, mode };
      await sendMessage(sessionId, prompt.trim(), payload);
      setPrompt("");
      scrollTimelineToBottom();
      const refreshed = await getSessionDetail(sessionId);
      setDetail(refreshed);
    } finally {
      setSending(false);
    }
  }

  async function handleAnswer(answer: string) {
    if (!sessionId || !answer.trim() || !providerID || !modelID) return;
    setSending(true);
    try {
      const payload: PromptOptions = { providerID, modelID, variant, mode };
      await sendMessage(sessionId, answer.trim(), payload);
      scrollTimelineToBottom();
      const refreshed = await getSessionDetail(sessionId);
      setDetail(refreshed);
    } finally {
      setSending(false);
    }
  }

  async function handleStop() {
    if (!sessionId || stopping) return;
    setStopping(true);
    try {
      await stopSession(sessionId);
      const refreshed = await getSessionDetail(sessionId);
      setDetail(refreshed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop processing");
    } finally {
      setStopping(false);
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void handleSubmit(event);
  }

  return (
    <section className="session-page">
      <header className="session-header">
        <div>
          <Link to="/" className="archive-back-link session-back-link">Back to board</Link>
          <h1>{detail?.title || "Conversation"}</h1>
          <p>{detail?.updatedAt ? `Updated ${new Date(detail.updatedAt).toLocaleString()}` : "Live OpenCode session"}</p>
        </div>
        <div className="session-header-actions">
          <button className={`archive-pill${workspaceOpen ? " active" : ""}`} type="button" onClick={() => setWorkspaceOpen((current) => !current)} title="Open workspace panel">
            <Icon name="folder" width="14" height="14" />
            <span>Workspace</span>
          </button>
          <button className={`archive-pill${terminalOpen ? " active" : ""}`} type="button" onClick={() => setTerminalOpen((current) => !current)} title="Toggle terminal overlay">
            <Icon name="terminal" width="14" height="14" />
            <span>Terminal</span>
          </button>
          <div className={`session-progress${detail?.running ? " running" : ""}`}>
            {waitingForInput ? "Waiting for input" : detail?.running ? "Thinking..." : "Idle"}
          </div>
        </div>
      </header>
      {loading ? <div className="page-state">Loading conversation...</div> : null}
      {error ? <div className="page-state error">{error}</div> : null}
      {!loading && !error && detail ? (
        <div className="session-shell">
          <div className="session-main">
            <div className="session-timeline" ref={timelineRef}>
              {detail.messages.map((message) => (
                <ConversationMessage
                  key={message.id}
                  message={message}
                  onAnswer={handleAnswer}
                  busy={sending || stopping}
                  isPending={detail.running && latestAssistant?.id === message.id}
                />
              ))}
              {detail.messages.length === 0 ? <div className="lane-empty">No messages yet. Send the first prompt.</div> : null}
            </div>
            <form className="session-composer" onSubmit={handleSubmit}>
              <div className="session-controls">
                <label>
                  <span>Model</span>
                  <select
                    value={selectedModelValue}
                    onChange={(event) => {
                      const [nextProviderID, nextModelID] = event.target.value.split("::");
                      if (!nextProviderID || !nextModelID) return;
                      setProviderID(nextProviderID);
                      setModelID(nextModelID);
                    }}
                  >
                    {groupedModels.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((item) => (
                          <option key={`${item.providerID}:${item.modelID}`} value={`${item.providerID}::${item.modelID}`}>
                            {item.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Thinking</span>
                  <select value={variant} onChange={(event) => setVariant(event.target.value)}>
                    {(selectedModel?.variants.length ? selectedModel.variants : ["medium"]).map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Mode</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as AgentMode)}>
                    <option value="build">build</option>
                    <option value="plan">plan</option>
                  </select>
                </label>
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Tell OpenCode what to do next..."
                rows={5}
              />
              <div className="session-composer-actions">
                <span className="session-composer-hint">Enter sends. Shift+Enter adds a newline.</span>
                <div className="session-composer-buttons">
                  {(detail?.running || waitingForInput) ? (
                    <button className="archive-pill" type="button" onClick={() => void handleStop()} disabled={stopping} title="Stop processing">
                      <span>{stopping ? "Stopping..." : "Stop"}</span>
                    </button>
                  ) : null}
                  <button className="lane-new-button" type="submit" disabled={sending || !prompt.trim() || !providerID || !modelID} title="Send prompt">
                    <Icon name="open" width="14" height="14" />
                    <span>{sending ? "Sending..." : "Send"}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
          <WorkspacePanel open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} mode="overlay" />
          <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />
        </div>
      ) : null}
    </section>
  );
}
