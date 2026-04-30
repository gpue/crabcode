# crabcode — Always-on AI coding agent with OpenChamber UI + CrabTalk
# -------------------------------------------------------------------
# Provides:
#   - OpenChamber UI (port 3000, internal) for browser-based AI coding
#   - OpenCode backend (port 4096, internal) as the session engine
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

# ── Stage 2: Final image ──────────────────────────────────────────
FROM debian:bookworm-slim

# ── Versions ────────────────────────────────────────────────────────
ARG OPENCODE_VERSION=1.3.17
ARG CRABTALK_VERSION=0.0.22
ARG TAILSCALE_VERSION=1.82.0
ARG GO_VERSION=1.24.2

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ── System packages + Python 3 + git + Node.js + dev tools ─────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gh gnupg git make python3 python3-pip python3-venv \
        openssh-client netcat-openbsd iputils-ping dnsutils traceroute \
        gettext-base jq ripgrep iptables iproute2 psmisc \
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

# ── Install OpenChamber ─────────────────────────────────────────────
RUN curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash \
    && (ls /root/.local/bin/openchamber 2>/dev/null && ln -sf /root/.local/bin/openchamber /usr/local/bin/openchamber || true)

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

# ── Azure CLI ───────────────────────────────────────────────────────
RUN curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash \
    && rm -rf /var/lib/apt/lists/*

# ── kubectl ─────────────────────────────────────────────────────────
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# ── Helm ────────────────────────────────────────────────────────────
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ── zip / unzip / openvpn ────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends zip unzip openvpn postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# ── glab (GitLab CLI) ───────────────────────────────────────────────
ARG GLAB_VERSION=1.93.0
RUN curl -fsSL -L "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /usr/local/bin bin/glab --strip-components=1 \
    && chmod +x /usr/local/bin/glab

# ── Go ──────────────────────────────────────────────────────────────
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# ── Nova CLI ────────────────────────────────────────────────────────
ARG NOVA_CLI_VERSION=0.0.228
RUN curl -fsSL "https://github.com/wandelbotsgmbh/nova-cli/releases/download/${NOVA_CLI_VERSION}/novacli_linux_amd64-${NOVA_CLI_VERSION}.tar.gz" \
    | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/nova

# ── Vercel CLI ───────────────────────────────────────────────────────
RUN npm install -g vercel

# ── Docker CLI (no daemon) ───────────────────────────────────────────
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*


# ── Create non-root user ────────────────────────────────────────────
RUN groupadd -r crabcode && useradd -r -g crabcode -m -d /home/crabcode crabcode

# ── Directory structure ─────────────────────────────────────────────
RUN mkdir -p /workspace \
    && mkdir -p /home/crabcode/.config/opencode \
    && mkdir -p /home/crabcode/.local/share/opencode \
    && mkdir -p /home/crabcode/.crabtalk/local/agents \
    && mkdir -p /home/crabcode/.crabtalk/run \
    && mkdir -p /app/static /app/proto \
    && mkdir -p /caddy/config /caddy/data \
    && mkdir -p /var/lib/tailscale \
    && mkdir -p /home/crabcode/.config/openchamber \
    && mkdir -p /home/crabcode/.local/share/openchamber \
    && chown -R crabcode:crabcode /workspace /home/crabcode /app /caddy

# ── CrabTalk config ─────────────────────────────────────────────────
COPY --chown=crabcode:crabcode crabtalk/config.toml /home/crabcode/.crabtalk/config.toml
COPY --chown=crabcode:crabcode crabtalk/CrabTalk.toml /home/crabcode/.crabtalk/local/CrabTalk.toml
COPY --chown=crabcode:crabcode crabtalk/agents/ /home/crabcode/.crabtalk/local/agents/

# ── Protobuf stubs for CrabTalk bridge ──────────────────────────────
COPY --chown=crabcode:crabcode proto/ /app/proto/

# ── Application files ──────────────────────────────────────────────
COPY --chown=crabcode:crabcode opencode.json /app/opencode.json
COPY --chown=crabcode:crabcode mcp_bridge.py /app/mcp_bridge.py
COPY --chown=crabcode:crabcode scripts/ /app/scripts/
COPY --chown=crabcode:crabcode start.sh /app/start.sh
COPY --chown=crabcode:crabcode Caddyfile /app/Caddyfile
COPY --chown=crabcode:crabcode Caddyfile.http /app/Caddyfile.http
COPY --chown=crabcode:crabcode package.json /app/package.json

# ── Install Node.js deps for bridge scripts ─────────────────────────
RUN cd /app && npm install --omit=dev

# ── SSH config for Tailscale peers (SOCKS5 proxy) ───────────────────
# Tailscale runs in userspace mode — no kernel routes for 100.x.x.x.
# Route SSH through the SOCKS5 proxy for all Tailscale IPs and hostnames.
RUN printf 'Host 100.*\n    ProxyCommand nc -X 5 -x localhost:1055 %%h %%p\n    StrictHostKeyChecking no\n\nHost nova spot unitree pidog\n    ProxyCommand nc -X 5 -x localhost:1055 %%h %%p\n    StrictHostKeyChecking no\n' \
    >> /etc/ssh/ssh_config

RUN chmod +x /app/start.sh

WORKDIR /workspace

# Only Caddy port — reachable exclusively via Tailscale
EXPOSE 80

ENTRYPOINT ["/app/start.sh"]
