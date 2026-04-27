# crabcode

Always-on AI coding workspace running on Azure Container Apps, accessible exclusively via Tailscale.

## What it does

crabcode is a self-hosted AI development environment that combines:

- **OpenCode Web UI** — browser-based AI coding agent (port 4096, proxied via Caddy on port 80)
- **CrabTalk** — AI agent daemon that processes coding tasks autonomously
- **Linear integration** — automatically picks up tickets assigned to the "crab" user, works on them, and comments on progress
- **Telegram bot** — chat interface to CrabTalk via `@gp_crabtalk_bot`
- **GitHub Copilot** — LLM backend for all AI operations (proxied through a local Copilot proxy)

### Linear workflow

When a Linear ticket is assigned to the "crab" user:
1. The linear-agent polls Linear every 30 seconds for new assignments
2. Moves the ticket from **Todo** → **In Progress**
3. Creates an OpenCode session to work on the ticket
4. Comments on the ticket with progress updates
5. Moves the ticket to **Done** when complete (or comments with questions if stuck)

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Azure Container App (4 vCPU, 8 GB RAM)         │
│                                                   │
│  ┌─────────┐    ┌──────────────┐                │
│  │  Caddy   │───▶│  OpenCode    │  :4096         │
│  │  :80     │    │  Web UI      │                │
│  │          │───▶│  MCP Bridge  │  :8081         │
│  └────┬─────┘    └──────────────┘                │
│       │                                           │
│  ┌────┴─────┐  ┌───────────┐  ┌──────────────┐  │
│  │Tailscale │  │ CrabTalk  │  │Copilot Proxy │  │
│  │(VPN mesh)│  │  :6688    │  │  :18791      │  │
│  └──────────┘  └─────┬─────┘  └──────────────┘  │
│                      │                            │
│  ┌───────────┐  ┌────┴──────┐  ┌──────────────┐ │
│  │ Telegram  │──┤           │  │ Linear Agent │ │
│  │ Bridge    │  │  TCP      │  │ (polls &     │ │
│  └───────────┘  └───────────┘  │  dispatches) │ │
│                                 └──────────────┘ │
│                                                   │
│  /workspace (Azure File Share)                   │
│    ├── crabcode/    (this repo, cloned on boot)  │
│    ├── .opencode/   (config, session data sync)  │
│    ├── .tailscale/  (VPN state)                  │
│    └── .crabtalk-data/ (sessions, memory)        │
└─────────────────────────────────────────────────┘
```

## Access

**No public ingress.** All access is via Tailscale:
- Web UI: `http://crabcode/` (Tailscale hostname)
- CLI attach: `opencode attach http://crabcode`
- Tailscale IP: `100.89.230.121`

## Configuration

### Environment variables (set as Container App secrets)

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` | GitHub token with `copilot` scope — used for Copilot API and repo cloning |
| `LINEAR_API_KEY` | Linear API key for ticket management |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for chat bridge |
| `TS_AUTHKEY` | Tailscale auth key (reusable, server type) |
| `TS_HOSTNAME` | Tailscale hostname (default: `crabcode`) |
| `COPILOT_MODEL` | Default model for Copilot proxy (default: `claude-sonnet-4`) |
| `WORKSPACE_DIR` | Workspace mount path (default: `/workspace`) |

### OpenCode config

The `opencode.json` config uses OpenCode's native `{env:VAR}` syntax for env var substitution. It configures:
- **GitHub Copilot** as the AI provider
- **Linear MCP server** (`linear-mcp-server` npm package) for ticket tools
- Auto-allow permissions for autonomous operation

### Key files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build: Caddy builder + final image with all binaries |
| `start.sh` | Entrypoint: boots Tailscale, Copilot proxy, CrabTalk, bridges, OpenCode, Caddy |
| `Caddyfile` | Reverse proxy on :80, strips CSP headers |
| `opencode.json` | OpenCode config with Copilot provider and Linear MCP |
| `scripts/copilot-proxy.mjs` | Proxies to `api.githubcopilot.com` using GH token directly |
| `scripts/telegram-bridge.mjs` | Telegram ↔ CrabTalk TCP bridge (protobuf) |
| `scripts/linear-agent.mjs` | Polls Linear for "crab" assignments, creates OpenCode sessions |
| `mcp_bridge.py` | FastAPI MCP bridge server |
| `crabtalk/` | CrabTalk config, agent manifests, system prompts |

## Deployment

### CI/CD

Push to `main` triggers:
1. **`.github/workflows/docker-build.yml`** — builds and pushes to `waboreg.azurecr.io/crabcode`
2. **`.github/workflows/deploy.yml`** — deploys to Azure Container Apps (`wabo` resource group)

### Infrastructure

- **Resource group**: `wabo`
- **Container Apps environment**: `nats-relay-env`
- **Container registry**: `waboreg.azurecr.io`
- **Storage**: Azure File Share `crabcodestorage/crabcode-workspace` mounted at `/workspace`
- **Specs**: 4 vCPU, 8 GB RAM, min/max 1 replica (always-on), internal ingress only

### Session persistence

OpenCode's SQLite database doesn't work on Azure File Share (no file locking). Sessions are stored on local ephemeral storage (`/tmp/opencode-data`) and synced to the persistent volume every 5 minutes and on shutdown.

## Development

### Running tests

```bash
npm test
```

### Local testing

The container can be built and run locally:

```bash
docker build -t crabcode .
docker run -it --rm \
  -e GH_TOKEN=... \
  -e LINEAR_API_KEY=... \
  -e TELEGRAM_BOT_TOKEN=... \
  -p 8080:80 \
  crabcode
```

Note: Tailscale requires a valid auth key for VPN connectivity.
