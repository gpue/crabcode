# crabcode — Always-on AI coding agent with OpenCode Web UI + CrabTalk
# -------------------------------------------------------------------
# Provides:
#   - OpenCode web UI (port 4096, internal) for browser-based AI coding
#   - MCP bridge server (port 8081, internal) for programmatic agent access
#   - CrabTalk daemon (port 6688, internal) for AI agent orchestration
#   - Telegram bridge for chat-based ticket interaction
#   - Linear MCP server for ticket management
#   - Tailscale for secure mesh VPN access (no public ingress)
#   - Caddy reverse proxy (port 8080, exposed via Tailscale only)
# -------------------------------------------------------------------

# ── Stage 1: Build custom Caddy with replace-response module ───────
ARG CADDY_VERSION=2.9.1
FROM caddy:${CADDY_VERSION}-builder AS caddy-builder
ARG CADDY_VERSION=2.9.1
RUN xcaddy build v${CADDY_VERSION} \
        --with github.com/caddyserver/replace-response \
        --output /usr/local/bin/caddy

# ── Stage 2: Build custom frontend ─────────────────────────────────
FROM node:22-bookworm-slim AS ui-builder

WORKDIR /ui
COPY ui/package.json ui/package-lock.json ui/tsconfig.json ui/tsconfig.app.json ui/vite.config.ts ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 3: Final image ───────────────────────────────────────────
FROM debian:bookworm-slim

# ── Versions ────────────────────────────────────────────────────────
ARG OPENCODE_VERSION=1.2.27
ARG CRABTALK_VERSION=0.0.22
ARG TAILSCALE_VERSION=1.82.0

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ── System packages + Python 3 + git + Node.js + dev tools ─────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gh gnupg git python3 python3-pip python3-venv \
        openssh-client netcat-openbsd iputils-ping dnsutils traceroute \
        gettext-base jq ripgrep iptables iproute2 \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ──────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Python tooling (uv) ─────────────────────────────────────────────
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv

# ── Install OpenCode binary ─────────────────────────────────────────
RUN curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/opencode

# ── Install CrabTalk binary ─────────────────────────────────────────
RUN curl -fsSL "https://github.com/gpue/crabtalk/releases/download/v${CRABTALK_VERSION}/crabtalk-linux-amd64.tar.gz" \
    | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/crabtalk

# ── Install Tailscale ───────────────────────────────────────────────
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    | tar -xz --strip-components=1 -C /usr/local/bin \
    && chmod +x /usr/local/bin/tailscale /usr/local/bin/tailscaled

# ── Copy custom Caddy binary ───────────────────────────────────────
COPY --from=caddy-builder /usr/local/bin/caddy /usr/local/bin/caddy

# ── Install Python deps for MCP bridge ──────────────────────────────
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    -r /tmp/requirements.txt && rm /tmp/requirements.txt

# ── Install Linear MCP server ───────────────────────────────────────
RUN npm install -g @anthropic/linear-mcp-server 2>/dev/null || \
    npm install -g mcp-linear 2>/dev/null || true

# ── Create non-root user ────────────────────────────────────────────
RUN groupadd -r crabcode && useradd -r -g crabcode -m -d /home/crabcode crabcode

# ── Directory structure ─────────────────────────────────────────────
RUN mkdir -p /workspace \
    && mkdir -p /home/crabcode/.config/opencode \
    && mkdir -p /home/crabcode/.local/share/opencode \
    && mkdir -p /home/crabcode/.crabtalk/local/agents \
    && mkdir -p /home/crabcode/.crabtalk/run \
    && mkdir -p /app/static /app/ui /app/proto \
    && mkdir -p /caddy/config /caddy/data \
    && mkdir -p /var/lib/tailscale \
    && chown -R crabcode:crabcode /workspace /home/crabcode /app /caddy

# ── CrabTalk config ─────────────────────────────────────────────────
COPY --chown=crabcode:crabcode crabtalk/config.toml /home/crabcode/.crabtalk/config.toml
COPY --chown=crabcode:crabcode crabtalk/CrabTalk.toml /home/crabcode/.crabtalk/local/CrabTalk.toml
COPY --chown=crabcode:crabcode crabtalk/agents/ /home/crabcode/.crabtalk/local/agents/

# ── Protobuf stubs for CrabTalk bridge ──────────────────────────────
COPY --chown=crabcode:crabcode proto/ /app/proto/

# ── Application files ──────────────────────────────────────────────
COPY --chown=crabcode:crabcode opencode.json /home/crabcode/.config/opencode/opencode.json
COPY --chown=crabcode:crabcode mcp_bridge.py /app/mcp_bridge.py
COPY --chown=crabcode:crabcode scripts/ /app/scripts/
COPY --chown=crabcode:crabcode start.sh /app/start.sh
COPY --chown=crabcode:crabcode Caddyfile /app/Caddyfile
COPY --chown=crabcode:crabcode package.json /app/package.json
COPY --from=ui-builder --chown=crabcode:crabcode /ui/dist/ /app/ui/

# ── Install Node.js deps for bridge scripts ─────────────────────────
RUN cd /app && npm install --omit=dev

RUN chmod +x /app/start.sh

WORKDIR /workspace

# Only Caddy port — reachable exclusively via Tailscale
EXPOSE 8080

ENTRYPOINT ["/app/start.sh"]
