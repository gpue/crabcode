import type {
  BoardData,
  ComposerOptions,
  Lane,
  PromptOptions,
  ProviderAuthMethod,
  ProviderConnectionSummary,
  ProviderOAuthAuthorization,
  SessionDetail,
  TerminalResult,
  WorkspaceFile,
  WorkspaceNode,
} from "./types";

const base = "/cell/nova-opencode";

export function getEventsUrl(sessionId?: string): string {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return `${base}/events${params}`;
}

async function requestText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${base}${path}`, {
    headers: {
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.text();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getBoard(): Promise<BoardData> {
  return request("/internal/board");
}

export function getArchive(): Promise<{ sessions: BoardData["lanes"][Lane] }> {
  return request("/internal/archive");
}

export function createSession(lane: Lane): Promise<{ id: string }> {
  return request("/internal/session", {
    method: "POST",
    body: JSON.stringify({ lane }),
  });
}

export function moveSession(sessionId: string, lane: Lane, afterId?: string | null): Promise<{ ok: boolean }> {
  return request(`/internal/session/${sessionId}/lane`, {
    method: "PATCH",
    body: JSON.stringify({ lane, afterId }),
  });
}

export function archiveSession(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/internal/session/${sessionId}/archive`, { method: "POST" });
}

export function restoreSession(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/internal/session/${sessionId}/restore`, { method: "POST" });
}

export function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  return request(`/internal/session/${sessionId}`);
}

export function getComposerOptions(): Promise<ComposerOptions> {
  return request("/internal/options/composer");
}

export function getProviderConnections(): Promise<ProviderConnectionSummary> {
  return request("/internal/auth/providers").then((payload) => {
    const connected = Array.isArray((payload as { connected?: unknown }).connected)
      ? ((payload as { connected: unknown[] }).connected.filter((item): item is string => typeof item === "string"))
      : [];
    return { connected };
  });
}

export function getProviderAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
  return request("/api/provider/auth");
}

export function startProviderOAuth(providerID: string, method: number): Promise<ProviderOAuthAuthorization> {
  return request(`/api/provider/${providerID}/oauth/authorize`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });
}

export function completeProviderOAuth(providerID: string, method: number, code?: string): Promise<boolean> {
  return request(`/api/provider/${providerID}/oauth/callback`, {
    method: "POST",
    body: JSON.stringify({ method, ...(code ? { code } : {}) }),
  });
}

export function disconnectProvider(providerID: string): Promise<boolean> {
  return request(`/api/auth/${providerID}`, { method: "DELETE" });
}

export function sendMessage(sessionId: string, prompt: string, options: PromptOptions): Promise<unknown> {
  return request(`/internal/session/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      providerID: options.providerID,
      modelID: options.modelID,
      variant: options.variant,
      mode: options.mode,
    }),
  });
}

export async function stopSession(sessionId: string): Promise<{ ok: boolean }> {
  try {
    return await request(`/internal/session/${sessionId}/interrupt`, { method: "POST" });
  } catch {
    return await request(`/internal/session/${sessionId}/cancel`, { method: "POST" });
  }
}

export function getWorkspaceTree(): Promise<{ tree: WorkspaceNode[] }> {
  return request("/internal/workspace/tree");
}

export function getWorkspaceFile(path: string): Promise<WorkspaceFile> {
  return request(`/internal/workspace/file?path=${encodeURIComponent(path)}`);
}

export function saveWorkspaceFile(path: string, content: string): Promise<{ ok: boolean }> {
  return request("/internal/workspace/file", {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

export function runTerminalCommand(command: string): Promise<TerminalResult> {
  return request("/internal/terminal/run", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

export function interruptTerminalCommand(): Promise<{ ok: boolean; signaled: boolean }> {
  return request("/internal/terminal/interrupt", {
    method: "POST",
  });
}
