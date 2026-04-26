import { useEffect, useMemo, useState } from "react";
import {
  completeProviderOAuth,
  disconnectProvider,
  getProviderAuthMethods,
  getProviderConnections,
  startProviderOAuth,
} from "../lib/api";
import type { ProviderAuthMethod } from "../lib/types";
import { Icon } from "./Icon";

interface ProviderConnectionsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface PendingAuthorization {
  providerID: string;
  method: number;
  title: string;
  url: string;
  instructions: string;
  code: string | null;
}

const providerCards = [
  {
    providerID: "github-copilot",
    title: "GitHub Copilot",
    description: "Connect your GitHub Copilot subscription with device login.",
    pickMethod(methods: ProviderAuthMethod[]) {
      return methods.findIndex((method) => method.type === "oauth");
    },
  },
  {
    providerID: "openai",
    title: "OpenAI Codex",
    description: "Connect your ChatGPT/Codex account through the headless device flow.",
    pickMethod(methods: ProviderAuthMethod[]) {
      return methods.findIndex((method) => method.type === "oauth" && /headless|device|codex/i.test(method.label));
    },
  },
];

function extractCode(instructions: string): string | null {
  const match = instructions.match(/Enter code:\s*([^\s]+)/i);
  return match ? match[1] : null;
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available in this browser");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Clipboard is not available in this browser");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export function ProviderConnectionsPanel({ open, onClose }: ProviderConnectionsPanelProps) {
  const [connected, setConnected] = useState<string[]>([]);
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [pending, setPending] = useState<PendingAuthorization | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshState() {
    const [methods, providersResponse] = await Promise.all([getProviderAuthMethods(), getProviderConnections()]);
    const connected = providersResponse.connected || [];
    setAuthMethods(methods);
    setConnected(connected);
    if (pending && connected.includes(pending.providerID)) {
      setPending(null);
      setCopied(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    refreshState().catch((err) => setError(err instanceof Error ? err.message : "Failed to load provider connections"));
  }, [open]);

  useEffect(() => {
    if (!open || !pending) return;
    const interval = window.setInterval(() => {
      refreshState().catch(() => {});
    }, 3000);
    return () => window.clearInterval(interval);
  }, [open, pending]);

  const cards = useMemo(
    () => providerCards.map((card) => ({ ...card, connected: connected.includes(card.providerID), methods: authMethods[card.providerID] || [] })),
    [authMethods, connected],
  );

  async function handleConnect(providerID: string, title: string, methods: ProviderAuthMethod[], pickMethod: (methods: ProviderAuthMethod[]) => number) {
    const method = pickMethod(methods);
    if (method < 0) {
      setError(`No OAuth flow available for ${title}.`);
      return;
    }

    setBusyProvider(providerID);
    try {
      const authorization = await startProviderOAuth(providerID, method);
      setPending({
        providerID,
        method,
        title,
        url: authorization.url,
        instructions: authorization.instructions,
        code: extractCode(authorization.instructions),
      });
      setCopied(false);
      setError(null);
      window.open(authorization.url, "_blank", "noopener,noreferrer");

      if (authorization.method === "auto") {
        void completeProviderOAuth(providerID, method)
          .then(async () => {
            await refreshState();
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : `Failed to complete ${title} OAuth`);
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start ${title} OAuth`);
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleCopyCode() {
    if (!pending?.code) return;
    try {
      await copyText(pending.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to copy code");
    }
  }

  async function handleDisconnect(providerID: string) {
    setBusyProvider(providerID);
    try {
      await disconnectProvider(providerID);
      await refreshState();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect provider");
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <div className={`provider-overlay${open ? " open" : ""}`}>
      <div className="provider-overlay-backdrop" onClick={onClose} />
      <aside className={`provider-panel${open ? " open" : ""}`}>
        <div className="provider-panel-head">
          <div>
            <h2>Provider connections</h2>
            <p>Attach GitHub Copilot or OpenAI Codex credentials without storing secrets in the browser.</p>
          </div>
          <button className="panel-close-button" type="button" onClick={onClose} title="Close connections">
            <Icon name="close" width="14" height="14" />
            <span>Close</span>
          </button>
        </div>
        {error ? <div className="page-state error provider-error">{error}</div> : null}
        {pending ? (
          <section className="provider-pending-card">
            <div className="provider-pending-head">
              <div>
                <strong>{pending.title}</strong>
                <p>{pending.code ? "Enter this code in the provider login page, then come back here." : pending.instructions}</p>
              </div>
              <span className="session-progress running">Awaiting auth</span>
            </div>
            <div className="provider-pending-actions">
              {pending.code ? <code className="provider-device-code">{pending.code}</code> : null}
              {pending.code ? (
                <button className="archive-pill" type="button" onClick={handleCopyCode}>
                  <Icon name="copy" width="14" height="14" />
                  <span>{copied ? "Copied" : "Copy code"}</span>
                </button>
              ) : null}
              <a className="archive-pill" href={pending.url} target="_blank" rel="noreferrer">
                <Icon name="open" width="14" height="14" />
                <span>Open provider login</span>
              </a>
              <button className="archive-pill" type="button" onClick={() => refreshState().catch(() => {})}>
                <Icon name="new" width="14" height="14" />
                <span>Refresh status</span>
              </button>
            </div>
          </section>
        ) : null}
        <div className="provider-card-list">
          {cards.map((card) => (
            <article key={card.providerID} className="provider-card">
              <div className="provider-card-head">
                <div>
                  <h3>{card.title}</h3>
                  <p>{card.description}</p>
                </div>
                <span className={`session-progress${card.connected ? " connected" : ""}`}>{card.connected ? "Connected" : "Not connected"}</span>
              </div>
              <div className="provider-card-actions">
                {card.connected ? (
                  <button className="archive-pill" type="button" onClick={() => handleDisconnect(card.providerID)} disabled={busyProvider === card.providerID}>
                    <Icon name="archive" width="14" height="14" />
                    <span>{busyProvider === card.providerID ? "Disconnecting..." : "Disconnect"}</span>
                  </button>
                ) : (
                  <button
                    className="lane-new-button"
                    type="button"
                    onClick={() => handleConnect(card.providerID, card.title, card.methods, card.pickMethod)}
                    disabled={busyProvider === card.providerID}
                    title={`Connect ${card.title}`}
                  >
                    <Icon name="open" width="14" height="14" />
                    <span>{busyProvider === card.providerID ? "Starting..." : "Connect"}</span>
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
