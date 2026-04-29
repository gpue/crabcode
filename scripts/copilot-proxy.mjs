/**
 * copilot-proxy.mjs
 *
 * Local OpenAI-compatible proxy for GitHub Copilot's chat completions API.
 * Uses a GitHub OAuth token (with `copilot` scope) directly as Bearer token
 * against https://api.githubcopilot.com — no token exchange required.
 *
 * Token resolution order:
 *   1. GH_TOKEN / GITHUB_TOKEN env var
 *   2. `gh auth token` CLI
 *   3. OpenCode's persisted auth at $XDG_DATA_HOME/opencode/auth.json
 *
 * Environment variables:
 *   GH_TOKEN              - GitHub OAuth token with copilot scope
 *   COPILOT_PROXY_PORT    - Listen port (default: 18791)
 *   COPILOT_MODEL         - Default model (default: claude-sonnet-4)
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { Readable } from "node:stream";

const LISTEN_PORT = Number(process.env.COPILOT_PROXY_PORT || 18791);
const DEFAULT_MODEL = process.env.COPILOT_MODEL || "claude-sonnet-4";
const COPILOT_API = "https://api.githubcopilot.com";

// ── GitHub token resolution ─────────────────────────────────────

function getGitHubToken() {
  // 1. OpenCode's persisted Copilot auth (highest priority — obtained via OAuth with copilot scope)
  const authPaths = [
    `${process.env.XDG_DATA_HOME || ""}/opencode/auth.json`,
    `${process.env.HOME}/.local/share/opencode/auth.json`,
  ];
  for (const p of authPaths) {
    if (p && existsSync(p)) {
      try {
        const auth = JSON.parse(readFileSync(p, "utf8"));
        const token =
          auth?.["github-copilot"]?.access ||
          auth?.["github-copilot"]?.refresh ||
          auth?.copilot?.token ||
          auth?.github?.token;
        if (token) return token;
      } catch {}
    }
  }

  // 2. gh CLI
  try {
    const token = execSync("gh auth token 2>/dev/null", { encoding: "utf8" }).trim();
    if (token) return token;
  } catch {}

  // 3. Environment variable (fallback — may lack copilot scope)
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  return null;
}

// ── Request helpers ─────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const MAX_TOOLS = 128; // Copilot supports many tools, issue is unsupported fields

function normalizeBody(buffer) {
  if (buffer.length === 0) return undefined;
  try {
    const payload = JSON.parse(buffer.toString("utf8"));
    if (payload && typeof payload === "object") {
      if (!payload.model) payload.model = DEFAULT_MODEL;
      // Strip fields that Copilot API doesn't support
      if (Array.isArray(payload.tools)) {
        for (const tool of payload.tools) {
          if (tool.function) {
            // Remove 'strict' field — Copilot API rejects it
            delete tool.function.strict;
            // Ensure description is non-empty — Copilot API rejects empty descriptions
            if (!tool.function.description) {
              tool.function.description = tool.function.name.replace(/_/g, ' ');
            }
            // Remove 'title' from parameters schema recursively — Copilot rejects it
            stripFields(tool.function.parameters);
          }
        }
      }
      // Remove tool_choice — Copilot API may not support it
      delete payload.tool_choice;
      // Remove stream_options — not supported by Copilot API
      delete payload.stream_options;
      return Buffer.from(JSON.stringify(payload));
    }
  } catch {}
  return buffer;
}

function stripFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  delete obj.additionalProperties;
  delete obj.title;
  if (obj.properties) {
    for (const v of Object.values(obj.properties)) {
      stripFields(v);
    }
  }
  if (obj.items) stripFields(obj.items);
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

  return res;
}

// ── HTTP server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.url === "/health") {
    const token = getGitHubToken();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", hasToken: !!token }));
    return;
  }

  console.log(`[copilot-proxy] ${req.method} ${req.url}`);
  try {
    const token = getGitHubToken();
    if (!token) {
      throw new Error(
        "No GitHub token found. Set GH_TOKEN, run 'gh auth login', or authenticate OpenCode with /connect"
      );
    }

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

    // Log request details
    if (body) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        console.log(`[copilot-proxy] → ${upstreamUrl} model=${parsed.model} messages=${parsed.messages?.length} tools=${parsed.tools?.length || 0} stream=${parsed.stream}`);
      } catch {}
    }

    const upstream = await fetchWithRetry(upstreamUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": req.headers["content-type"] || "application/json",
        Accept: req.headers.accept || "application/json",
        "Editor-Version": "vscode/1.90.0",
        "Editor-Plugin-Version": "copilot/1.0.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
      body,
    });

    console.log(`[copilot-proxy] ← ${upstream.status} ${upstream.statusText}`);
    const headers = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-length") headers[key] = value;
    });

    console.log(`[copilot-proxy] ${req.method} ${req.url}`);
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      const readable = Readable.fromWeb(upstream.body);
      const isStream = headers["content-type"]?.includes("text/event-stream");

      if (isStream) {
        // Inject missing "object" field required by OpenAI streaming spec.
        // GitHub Copilot API omits it; CrabTalk's SSE parser requires it.
        let remainder = "";
        readable.on("data", (chunk) => {
          const text = remainder + chunk.toString("utf8");
          const lines = text.split("\n");
          remainder = lines.pop();
          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const obj = JSON.parse(line.slice(6));
                if (!obj.object) obj.object = "chat.completion.chunk";
                res.write("data: " + JSON.stringify(obj) + "\n\n");
              } catch {
                res.write(line + "\n");
              }
            } else {
              res.write(line + "\n");
            }
          }
        });
        readable.on("end", () => { if (remainder) res.write(remainder); res.end(); });
        readable.on("error", () => res.end());
      } else {
        readable.pipe(res);
      }
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
  const token = getGitHubToken();
  console.log(
    `[copilot-proxy] listening on http://127.0.0.1:${LISTEN_PORT} → ${COPILOT_API} (model=${DEFAULT_MODEL}, hasToken=${!!token})`
  );
  if (!token) {
    console.warn("[copilot-proxy] No GH token found yet. Set GH_TOKEN or run 'gh auth login'.");
  }
});
