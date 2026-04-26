/**
 * copilot-proxy.mjs
 *
 * Local OpenAI-compatible proxy for GitHub Copilot's chat completions API.
 * Handles GitHub token → Copilot token exchange with automatic refresh.
 *
 * Token flow:
 *   1. Reads GitHub token from GH_TOKEN env var, or from `gh auth token`, or
 *      from OpenCode's persisted auth at ~/.local/share/opencode/auth.json
 *   2. Exchanges it for a short-lived Copilot API token via
 *      https://api.github.com/copilot_internal/v2/token
 *   3. Proxies requests to https://api.githubcopilot.com with that token
 *   4. Auto-refreshes the Copilot token before expiry
 *
 * Environment variables:
 *   GH_TOKEN              - GitHub personal access token or OAuth token (optional if gh CLI is authed)
 *   COPILOT_PROXY_PORT    - Listen port (default: 18791)
 *   COPILOT_MODEL         - Default model to use (default: claude-sonnet-4)
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { Readable } from "node:stream";

const LISTEN_PORT = Number(process.env.COPILOT_PROXY_PORT || 18791);
const DEFAULT_MODEL = process.env.COPILOT_MODEL || "claude-sonnet-4";
const COPILOT_API = "https://api.githubcopilot.com";
const TOKEN_ENDPOINT = "https://api.github.com/copilot_internal/v2/token";

// Cached Copilot token
let copilotToken = null;
let copilotTokenExpiry = 0;

// ── GitHub token resolution ─────────────────────────────────────

function getGitHubToken() {
  // 1. Environment variable
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. gh CLI
  try {
    const token = execSync("gh auth token 2>/dev/null", { encoding: "utf8" }).trim();
    if (token) return token;
  } catch {}

  // 3. OpenCode's persisted auth
  const authPaths = [
    `${process.env.XDG_DATA_HOME || ""}/opencode/auth.json`,
    `${process.env.HOME}/.local/share/opencode/auth.json`,
  ];
  for (const p of authPaths) {
    if (p && existsSync(p)) {
      try {
        const auth = JSON.parse(readFileSync(p, "utf8"));
        // OpenCode stores Copilot auth as { copilot: { user: ..., token: ... } } or similar
        const token = auth?.copilot?.token || auth?.github?.token || auth?.token;
        if (token) return token;
      } catch {}
    }
  }

  return null;
}

// ── Copilot token exchange ──────────────────────────────────────

async function getCopilotToken() {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (copilotToken && copilotTokenExpiry > now + 60_000) {
    return copilotToken;
  }

  const ghToken = getGitHubToken();
  if (!ghToken) {
    throw new Error(
      "No GitHub token found. Set GH_TOKEN, run 'gh auth login', or authenticate OpenCode with /connect"
    );
  }

  console.log("[copilot-proxy] Exchanging GitHub token for Copilot token...");

  const res = await fetch(TOKEN_ENDPOINT, {
    headers: {
      Authorization: `token ${ghToken}`,
      Accept: "application/json",
      "Editor-Version": "opencode/1.0",
      "Editor-Plugin-Version": "crabcode/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  copilotToken = data.token;
  // expires_at is Unix timestamp in seconds
  copilotTokenExpiry = data.expires_at * 1000;

  const expiresIn = Math.round((copilotTokenExpiry - now) / 1000 / 60);
  console.log(`[copilot-proxy] Got Copilot token, expires in ${expiresIn}min`);

  return copilotToken;
}

// ── Request helpers ─────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function normalizeBody(buffer) {
  if (buffer.length === 0) return undefined;
  try {
    const payload = JSON.parse(buffer.toString("utf8"));
    if (payload && typeof payload === "object") {
      // Set default model if not specified
      if (!payload.model) payload.model = DEFAULT_MODEL;
      return Buffer.from(JSON.stringify(payload));
    }
  } catch {}
  return buffer;
}

// ── Retry with backoff ──────────────────────────────────────────

async function fetchWithRetry(url, options, attempt = 0) {
  const res = await fetch(url, options);

  if (res.status === 429 && attempt < 3) {
    try { await res.text(); } catch {}
    const retryAfter = res.headers.get("retry-after");
    let delay = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
    delay = Math.min(delay, 30_000);
    console.log(`[copilot-proxy] 429, retry in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    return fetchWithRetry(url, options, attempt + 1);
  }

  // If 401, invalidate cached token and retry once
  if (res.status === 401 && attempt === 0) {
    try { await res.text(); } catch {}
    console.log("[copilot-proxy] 401, refreshing token...");
    copilotToken = null;
    copilotTokenExpiry = 0;
    const newToken = await getCopilotToken();
    options.headers.Authorization = `Bearer ${newToken}`;
    return fetchWithRetry(url, options, attempt + 1);
  }

  return res;
}

// ── HTTP server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", hasToken: !!copilotToken }));
    return;
  }

  try {
    const token = await getCopilotToken();
    const url = new URL(req.url || "/", "http://127.0.0.1");

    const rawBody = await readBody(req);
    const body = url.pathname.includes("/chat/completions")
      ? normalizeBody(rawBody)
      : rawBody.length > 0 ? rawBody : undefined;

    // Map path: /v1/chat/completions → /chat/completions
    let upstreamPath = url.pathname;
    if (upstreamPath.startsWith("/v1")) {
      upstreamPath = upstreamPath.slice(3);
    }

    const upstreamUrl = `${COPILOT_API}${upstreamPath}${url.search}`;

    const upstream = await fetchWithRetry(upstreamUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": req.headers["content-type"] || "application/json",
        Accept: req.headers.accept || "application/json",
        "Editor-Version": "opencode/1.0",
        "Editor-Plugin-Version": "crabcode/1.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
      body,
    });

    const headers = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-length") headers[key] = value;
    });

    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error(`[copilot-proxy] Error: ${err.message}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`copilot proxy error: ${err.message}`);
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `[copilot-proxy] listening on http://127.0.0.1:${LISTEN_PORT} → ${COPILOT_API} (model=${DEFAULT_MODEL})`
  );
});

// Pre-warm: try to get token on startup
getCopilotToken().catch((err) => {
  console.warn(`[copilot-proxy] Initial token fetch failed: ${err.message}`);
  console.warn("[copilot-proxy] Will retry on first request. Ensure GH_TOKEN is set or run 'gh auth login'.");
});
