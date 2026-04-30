#!/usr/bin/env bash
# start.sh — entrypoint for crabcode container
# All services are only reachable via Tailscale — no public ingress.
#
# Services started by this script:
#   tailscaled        — Tailscale daemon; provides the private overlay network and TLS cert
#   copilot-proxy     — Local HTTP proxy that sanitizes GitHub Copilot API requests/responses
#   crabtalk          — AI chat daemon; handles multi-agent sessions and memory
#   telegram-bridge   — Bridges Telegram messages into CrabTalk sessions
#   linear-agent      — Watches Linear issues and drives OpenCode to implement them
#   mcp-bridge        — Model Context Protocol bridge; exposes tools (files, git, shell) over HTTP
#   opencode          — AI coding web UI; long-running, auto-restarted on crash
#   openchamber       — Browser UI shell that connects to the running OpenCode backend
#   caddy             — Reverse proxy; terminates TLS (or HTTP) and routes to OpenCode/OpenChamber
set -uo pipefail
# NOTE: -e intentionally omitted — we handle errors explicitly below.
# Azure File Share mounts can hang; we must not let that block forever.

echo "[start.sh] Booting crabcode container..."

# Check if workspace mount is responsive (timeout after 5s per attempt)
MOUNT_OK=false
for i in 1 2 3 4 5; do
    if timeout 5 ls "${WORKSPACE_DIR:-/workspace}/" >/dev/null 2>&1; then
        MOUNT_OK=true
        echo "[start.sh] Workspace mount is ready"
        break
    fi
    echo "[start.sh] Waiting for workspace mount... (attempt $i/5)"
    sleep 3
done

if [ "$MOUNT_OK" = "false" ]; then
    echo "[start.sh] WARNING: Workspace mount not responsive — starting with local fallback"
    export WORKSPACE_DIR="/tmp/workspace-fallback"
    mkdir -p "$WORKSPACE_DIR"
fi

export BASE_PATH="${BASE_PATH:-}"
export OPENCODE_PORT="${OPENCODE_PORT:-4096}"
export OPENCHAMBER_PORT="${OPENCHAMBER_PORT:-3000}"
export MCP_BRIDGE_PORT="${MCP_BRIDGE_PORT:-8081}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
export OPENCODE_XDG_ROOT="${WORKSPACE_DIR}/.opencode"
export PERSISTENT_HOME="${WORKSPACE_DIR}/.home/crabcode"
export XDG_CONFIG_HOME="${OPENCODE_XDG_ROOT}/config"
# SQLite doesn't work on Azure File Share — put data/cache on local ephemeral storage
# But we sync from persistent storage on startup and back on shutdown to preserve sessions
export XDG_DATA_HOME="/tmp/opencode-data"
export XDG_CACHE_HOME="/tmp/opencode-cache"
PERSISTENT_DATA="${WORKSPACE_DIR}/.opencode/data"

# ── Persistent home setup ────────────────────────────────────────
echo "[start.sh] Creating persistent directories..."
timeout 10 mkdir -p "${PERSISTENT_HOME}" "${PERSISTENT_HOME}/.config" \
         "${PERSISTENT_HOME}/.cache" "${PERSISTENT_HOME}/.local/share" || echo "[start.sh] WARNING: mkdir persistent home timed out/failed"

echo "[start.sh] Creating opencode directories..."
timeout 10 mkdir -p "${OPENCODE_XDG_ROOT}/config/opencode" \
         "${XDG_DATA_HOME}" \
         "${XDG_CACHE_HOME}" \
         "${PERSISTENT_DATA}" \
         "${PERSISTENT_DATA}/mcp-bridge-state" || echo "[start.sh] WARNING: mkdir opencode dirs timed out/failed"

# Restore session data from persistent storage (SQLite runs on local tmpfs).
# We only restore the files that matter for session/auth continuity:
#   auth.json         — provider OAuth tokens
#   opencode.db       — SQLite base database
#   opencode.db-wal   — SQLite WAL (contains all recent writes)
#   storage/          — session diffs and other app state
# Explicitly excluded from restore (and sync):
#   snapshot/         — per-tool git-object undo trees; grows to GBs, useless after restart
#   log/              — log files; not needed on restore
#   opencode.db-shm   — SQLite shared-memory index; process-local, SQLite recreates it
if [ -d "${PERSISTENT_DATA}/opencode" ]; then
    mkdir -p "${XDG_DATA_HOME}/opencode"
    for f in auth.json opencode.db opencode.db-wal; do
        [ -f "${PERSISTENT_DATA}/opencode/${f}" ] && \
            timeout 30 cp "${PERSISTENT_DATA}/opencode/${f}" "${XDG_DATA_HOME}/opencode/${f}" 2>/dev/null || true
    done
    if [ -d "${PERSISTENT_DATA}/opencode/storage" ]; then
        timeout 60 cp -a "${PERSISTENT_DATA}/opencode/storage" "${XDG_DATA_HOME}/opencode/" 2>/dev/null || true
    fi
    echo "[opencode] Restored session data from persistent storage"
fi

# Restore OpenChamber config and data from persistent storage
if [ -d "${PERSISTENT_DATA}/openchamber/config" ]; then
    timeout 30 cp -a "${PERSISTENT_DATA}/openchamber/config/." "${HOME}/.config/openchamber/" 2>/dev/null || true
    echo "[openchamber] Restored config from persistent storage"
fi
if [ -d "${PERSISTENT_DATA}/openchamber/data" ]; then
    timeout 30 cp -a "${PERSISTENT_DATA}/openchamber/data/." "${HOME}/.local/share/openchamber/" 2>/dev/null || true
    echo "[openchamber] Restored data from persistent storage"
fi

# Clean up large dirs that should never be persisted (runs in background, non-blocking).
# snapshot/ = per-tool git undo trees (grows to GBs); log/ = log files.
# opencode.db-shm is process-local; remove any stale copy so SQLite starts clean.
(rm -rf "${PERSISTENT_DATA}/opencode/snapshot" \
        "${PERSISTENT_DATA}/opencode/log" \
        "${PERSISTENT_DATA}/opencode/opencode.db-shm" 2>/dev/null && \
 echo "[opencode] Persistent storage cleanup complete") &

# Always overwrite config from image (ensures config updates propagate)
# OpenCode natively supports {env:VAR} syntax — no envsubst needed
echo "[start.sh] Installing opencode config..."
if [ -f /app/opencode.json ]; then
    timeout 5 cp /app/opencode.json "${OPENCODE_XDG_ROOT}/config/opencode/opencode.json" || true
    echo "[opencode] Config installed to ${OPENCODE_XDG_ROOT}/config/opencode/opencode.json" >&2
    # Also copy to /workspace root and git projects (project-level config has highest precedence)
    timeout 5 cp /app/opencode.json "${WORKSPACE_DIR}/opencode.json" 2>/dev/null || true
    for d in "${WORKSPACE_DIR}"/*/; do
        if [ -d "${d}.git" ]; then
            timeout 5 cp /app/opencode.json "${d}opencode.json" 2>/dev/null || true
        fi
    done
else
    echo "[opencode] ERROR: /app/opencode.json not found!" >&2
fi

# Persist git config (non-critical, use timeouts)
echo "[start.sh] Setting up persistent home..."
timeout 5 cp /home/crabcode/.gitconfig "${PERSISTENT_HOME}/.gitconfig" 2>/dev/null || true
timeout 5 cp /home/crabcode/.git-credentials "${PERSISTENT_HOME}/.git-credentials" 2>/dev/null || true
if [ -d /home/crabcode/.config/gh ] && [ ! -d "${PERSISTENT_HOME}/.config/gh" ]; then
    timeout 5 mkdir -p "${PERSISTENT_HOME}/.config" 2>/dev/null || true
    timeout 10 cp -R /home/crabcode/.config/gh "${PERSISTENT_HOME}/.config/gh" 2>/dev/null || true
fi

# Persist Azure CLI state
if [ -d /home/crabcode/.azure ] && [ ! -d "${PERSISTENT_HOME}/.azure" ]; then
    timeout 10 cp -R /home/crabcode/.azure "${PERSISTENT_HOME}/.azure" 2>/dev/null || true
fi

# Symlink persistent dirs
ln -sfn "${PERSISTENT_HOME}/.config" /home/crabcode/.config
ln -sfn "${PERSISTENT_HOME}/.azure" /home/crabcode/.azure
ln -sfn "${PERSISTENT_HOME}/.cache" /home/crabcode/.cache
ln -sfn "${PERSISTENT_HOME}/.local" /home/crabcode/.local

[ -f "${PERSISTENT_HOME}/.gitconfig" ] && ln -sfn "${PERSISTENT_HOME}/.gitconfig" /home/crabcode/.gitconfig
[ -f "${PERSISTENT_HOME}/.git-credentials" ] && ln -sfn "${PERSISTENT_HOME}/.git-credentials" /home/crabcode/.git-credentials

export HOME="${PERSISTENT_HOME}"

# ── Persist CrabTalk data ────────────────────────────────────────
CRABTALK_DATA="${WORKSPACE_DIR}/.crabtalk-data"
mkdir -p "${CRABTALK_DATA}/sessions" "${CRABTALK_DATA}/memory/entries" "${CRABTALK_DATA}/config/agents"
ln -sfn "${CRABTALK_DATA}/sessions" /home/crabcode/.crabtalk/sessions
ln -sfn "${CRABTALK_DATA}/memory" /home/crabcode/.crabtalk/memory

# Overlay user-edited agent prompts from persistent storage
if [ -d "${CRABTALK_DATA}/config/agents" ] && ls "${CRABTALK_DATA}/config/agents"/*.md &>/dev/null; then
    cp "${CRABTALK_DATA}/config/agents"/*.md /home/crabcode/.crabtalk/local/agents/
fi

# Expand env vars in CrabTalk config
envsubst < /home/crabcode/.crabtalk/config.toml > /tmp/config.toml && mv /tmp/config.toml /home/crabcode/.crabtalk/config.toml
envsubst < /home/crabcode/.crabtalk/local/CrabTalk.toml > /tmp/CrabTalk.toml && mv /tmp/CrabTalk.toml /home/crabcode/.crabtalk/local/CrabTalk.toml

echo "=== crabcode ==="
echo "  Caddy proxy     : port 443 HTTPS / port 80 HTTP→HTTPS (Tailscale only)"
echo "  OpenCode web UI : port ${OPENCODE_PORT} (internal)"
echo "  MCP bridge      : port ${MCP_BRIDGE_PORT} (internal)"
echo "  CrabTalk        : port 6688 (internal)"
echo "  Workspace       : /workspace"
echo "  Home            : ${HOME}"
echo "===================="

# ── Trap for cleanup ─────────────────────────────────────────────
sync_session_data() {
    if [ ! -d "${XDG_DATA_HOME}/opencode" ]; then return; fi
    mkdir -p "${PERSISTENT_DATA}/opencode"
    # Checkpoint WAL into the main DB file so opencode.db is self-contained.
    # This makes the backup consistent and reduces the WAL file size over time.
    if [ -f "${XDG_DATA_HOME}/opencode/opencode.db" ]; then
        sqlite3 "${XDG_DATA_HOME}/opencode/opencode.db" "PRAGMA wal_checkpoint(FULL);" 2>/dev/null || true
    fi
    # Copy only what's needed for session/auth persistence.
    # Intentionally exclude: snapshot/ (undo trees, can be GBs), log/, opencode.db-shm
    for f in auth.json opencode.db opencode.db-wal; do
        [ -f "${XDG_DATA_HOME}/opencode/${f}" ] && \
            cp "${XDG_DATA_HOME}/opencode/${f}" "${PERSISTENT_DATA}/opencode/${f}" 2>/dev/null || true
    done
    if [ -d "${XDG_DATA_HOME}/opencode/storage" ]; then
        cp -a "${XDG_DATA_HOME}/opencode/storage" "${PERSISTENT_DATA}/opencode/" 2>/dev/null || true
    fi

    # OpenChamber config + data
    for d in \
        "${HOME}/.config/openchamber" \
        "${HOME}/.local/share/openchamber"; do
        if [ -d "$d" ]; then
            if [[ "$d" == */.config/* ]]; then
                mkdir -p "${PERSISTENT_DATA}/openchamber/config"
                cp -a "$d/." "${PERSISTENT_DATA}/openchamber/config/" 2>/dev/null || true
            else
                mkdir -p "${PERSISTENT_DATA}/openchamber/data"
                cp -a "$d/." "${PERSISTENT_DATA}/openchamber/data/" 2>/dev/null || true
            fi
        fi
    done
}
cleanup() {
    echo "Shutting down..."
    sync_session_data
    kill "$TAILSCALE_PID" "$MCP_PID" "$OPENCODE_PID" "$CRABTALK_PID" \
         "$COPILOT_PROXY_PID" "$TELEGRAM_PID" "$LINEAR_AGENT_PID" "$SYNC_PID" \
         "${OPENCHAMBER_PID:-}" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Start Tailscale (runs as root, userspace networking) ─────────
# Tailscale state is persisted on the volume, but socket must be local
mkdir -p "${WORKSPACE_DIR}/.tailscale" /tmp/tailscale
tailscaled --state="${WORKSPACE_DIR}/.tailscale/${TS_HOSTNAME:-crabcode}.state" \
           --socket=/tmp/tailscale/tailscaled.sock &
TAILSCALE_PID=$!
sleep 2

# Authenticate with pre-auth key (only needed on first run)
tailscale --socket=/tmp/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY:-}" \
    --hostname="${TS_HOSTNAME:-crabcode}" \
    --accept-routes \
    2>/dev/null || echo "[tailscale] Already authenticated or no auth key"

echo "[tailscale] Status: $(tailscale --socket=/tmp/tailscale/tailscaled.sock status --self 2>/dev/null | head -1)"

# ── Provision TLS cert via tailscale cert ────────────────────────
# With kernel TUN mode, Tailscale creates a real interface and Caddy on :443 works.
# `tailscale cert` provisions a Let's Encrypt cert for <hostname>.<tailnet>.ts.net.
# Requires "HTTPS certificates" to be enabled in the Tailscale admin console.
TS_CERT_DIR=/tmp/tailscale-cert
mkdir -p "${TS_CERT_DIR}"

# Get the full FQDN (e.g., crabcode.tail1234.ts.net) from tailscale status
TS_FQDN=$(tailscale --socket=/tmp/tailscale/tailscaled.sock status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "")

if [ -n "${TS_FQDN}" ]; then
    echo "[tailscale] FQDN: ${TS_FQDN}"
    if timeout 15 tailscale --socket=/tmp/tailscale/tailscaled.sock cert \
            --cert-file "${TS_CERT_DIR}/server.crt" \
            --key-file  "${TS_CERT_DIR}/server.key" \
            "${TS_FQDN}" 2>/dev/null; then
        echo "[tailscale] TLS cert provisioned — Caddy will serve HTTPS on :443"
    else
        echo "[tailscale] WARNING: cert fetch failed (HTTPS not enabled in admin console?) — HTTP only"
        rm -f "${TS_CERT_DIR}/server.crt" "${TS_CERT_DIR}/server.key"
    fi
else
    echo "[tailscale] WARNING: could not determine FQDN — HTTP only"
fi

# ── Tailscale kernel networking ──────────────────────────────────
# With privileged mode + TUN device, Tailscale creates a real network interface.
# No SOCKS5 proxy needed — 100.x.x.x routes work natively.
echo "[tailscale] Running in kernel TUN mode (privileged container)"

# ── Fix /etc/hosts for nova ──────────────────────────────────────
# The container platform injects a stale LAN entry for 'nova' on every start.
# Replace it with the correct Tailscale IP.
sed -i "s/.*\bnova\b.*/100.113.46.67\tnova/" /etc/hosts
grep -q "nova" /etc/hosts || echo "100.113.46.67	nova" >> /etc/hosts
echo "[hosts] nova -> 100.113.46.67"

# ── OpenVPN (corporate VPN for code.wabo.run access) ─────────────
if [ -n "${OVPN_CONFIG:-}" ]; then
    echo "[openvpn] Setting up VPN connection..."
    mkdir -p /dev/net /etc/openvpn
    [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
    echo "$OVPN_CONFIG" | base64 -d > /etc/openvpn/client.ovpn
    printf '%s\n%s\n' "${OVPN_USERNAME:-}" "${OVPN_PASSWORD:-}" > /etc/openvpn/auth.txt
    chmod 600 /etc/openvpn/auth.txt
    # Ensure auth-user-pass points to our credentials file
    sed -i 's|^auth-user-pass.*|auth-user-pass /etc/openvpn/auth.txt|' /etc/openvpn/client.ovpn
    openvpn --config /etc/openvpn/client.ovpn --daemon --log /var/log/openvpn.log
    for i in $(seq 1 30); do
        if ip addr show tun0 &>/dev/null; then
            echo "[openvpn] Connected: $(ip addr show tun0 | grep 'inet ' | awk '{print $2}')"
            break
        fi
        sleep 1
    done
    if ! ip addr show tun0 &>/dev/null; then
        echo "[openvpn] WARNING: VPN connection failed — check /var/log/openvpn.log"
    fi
else
    echo "[openvpn] No OVPN_CONFIG set — skipping VPN"
fi

# ── glab (GitLab CLI for code.wabo.run) ──────────────────────────
if [ -n "${GLAB_TOKEN:-}" ]; then
    # Azure File Share mounts are 777 and can't chmod — glab rejects config files
    # that aren't 600. Use a local tmpfs directory instead.
    export GLAB_CONFIG_DIR="/tmp/glab-config"
    mkdir -p "${GLAB_CONFIG_DIR}"
    cat > "${GLAB_CONFIG_DIR}/config.yml" <<GLABEOF
git_protocol: https
host: code.wabo.run
hosts:
    code.wabo.run:
        api_protocol: https
        api_host: code.wabo.run
        token: ${GLAB_TOKEN}
GLABEOF
    chmod 600 "${GLAB_CONFIG_DIR}/config.yml"
    echo "[glab] Configured for code.wabo.run (GLAB_CONFIG_DIR=${GLAB_CONFIG_DIR})"
fi

# ── Bootstrap workspace repos ───────────────────────────────────
# Clone default repos into /workspace on first boot so OpenCode has projects to work with.
# Uses GH_TOKEN for auth. Add more repos to the array as needed.
REPOS=(
    "gpue/crabcode"
    "gpue/gp"
    "gpue/formfactors"
)

if [ -n "${GH_TOKEN:-}" ]; then
    git config --global credential.helper store
    echo "https://x-access-token:${GH_TOKEN}@github.com" > "${HOME}/.git-credentials"
    git config --global user.name "Georg Püschel"
    git config --global user.email "georg.pueschel@wandelbots.com"
    echo "${GH_TOKEN}" | gh auth login --with-token
    # NOTE: We intentionally do NOT export GITHUB_TOKEN for OpenCode.
    # This hides the built-in github-copilot provider which sends unsanitized
    # tool schemas (empty descriptions, title fields) that the Copilot API rejects.
    # Instead, all LLM traffic goes through our copilot-proxy which sanitizes requests.
    # The copilot-proxy resolves its token via `gh auth token` (set above).
    unset GITHUB_TOKEN
fi

# Add GitLab credentials for code.wabo.run
if [ -n "${GLAB_TOKEN:-}" ]; then
    echo "https://oauth2:${GLAB_TOKEN}@code.wabo.run" >> "${HOME}/.git-credentials"
fi

for repo in "${REPOS[@]}"; do
    repo_name="${repo##*/}"
    if [ ! -d "${WORKSPACE_DIR}/${repo_name}" ]; then
        echo "[workspace] Cloning ${repo} into ${WORKSPACE_DIR}/${repo_name}..."
        git clone "https://github.com/${repo}.git" "${WORKSPACE_DIR}/${repo_name}" 2>&1 || \
            echo "[workspace] Failed to clone ${repo}"
    else
        echo "[workspace] ${repo_name} already exists, skipping"
    fi
done

# ── GitHub Copilot proxy ─────────────────────────────────────────
node /app/scripts/copilot-proxy.mjs &
COPILOT_PROXY_PID=$!

sleep 1

# ── CrabTalk daemon ──────────────────────────────────────────────
# NO_PROXY ensures CrabTalk bypasses SOCKS5 for local copilot proxy (127.0.0.1:18791)
NO_PROXY=127.0.0.1,localhost HOME=/home/crabcode crabtalk --foreground --tcp &
CRABTALK_PID=$!
sleep 3

# ── Telegram bridge (direct TCP to CrabTalk, no NATS) ────────────
node /app/scripts/telegram-bridge.mjs &
TELEGRAM_PID=$!

# ── Linear ticket agent ──────────────────────────────────────────
ALL_PROXY="" NO_PROXY=127.0.0.1,localhost node /app/scripts/linear-agent.mjs >> /tmp/linear-agent.log 2>&1 &
LINEAR_AGENT_PID=$!

# ── MCP bridge server ────────────────────────────────────────────
# Use local tmpfs for SQLite state to avoid Azure File Share locking issues
MCP_BRIDGE_STATE_DIR=/tmp/mcp-bridge-state python3 /app/mcp_bridge.py &
MCP_PID=$!

# ── OpenCode web UI ──────────────────────────────────────────────
# Run from /workspace so OpenCode has access to all project repos.
# /workspace/opencode.json provides full provider + MCP config.
OPENCODE_DIR="${WORKSPACE_DIR}"
echo "[opencode] Starting in ${OPENCODE_DIR}"

# Re-enable MCPs and providers that are disabled in the committed opencode.json
# (disabled by default so the project can be opened locally without failures)
export OPENCODE_CONFIG_CONTENT='{"mcp":{"linear":{"enabled":true},"crabcode-bridge":{"enabled":true}}}'

(cd "${OPENCODE_DIR}" && while true; do
    echo "[opencode] Launching opencode web..."
    env opencode web \
        --port "${OPENCODE_PORT}" \
        --hostname 0.0.0.0 \
        --cors "*" || true
    echo "[opencode] Process exited, restarting in 3s..."
    sleep 3
done) &
OPENCODE_PID=$!

# ── OpenChamber UI ───────────────────────────────────────────────────
# Connects to the already-running OpenCode backend (OPENCODE_SKIP_START=true)
# Only reachable over Tailscale — no UI password needed.
echo "[openchamber] Waiting for OpenCode on port ${OPENCODE_PORT}..."
for i in $(seq 1 30); do
    if nc -z 127.0.0.1 "${OPENCODE_PORT}" 2>/dev/null; then
        # Verify the API actually responds, not just TCP open
        if NO_PROXY=127.0.0.1 curl -s --max-time 2 http://127.0.0.1:${OPENCODE_PORT}/api/session >/dev/null 2>&1; then
            echo "[openchamber] OpenCode API ready"
            break
        fi
    fi
    sleep 2
done
# Give OpenCode a moment to fully stabilize
sleep 3

# Kill any stale openchamber process and remove PID files from previous runs
pkill -f "openchamber serve" 2>/dev/null || true
rm -f /tmp/openchamber.pid "${HOME}/.local/share/openchamber/openchamber.pid" \
      "${HOME}/.config/openchamber/openchamber.pid" 2>/dev/null || true
# Free port 3000 if anything is holding it
fuser -k ${OPENCHAMBER_PORT}/tcp 2>/dev/null || true
sleep 1

echo "[openchamber] Starting OpenChamber UI..."
# NO_PROXY ensures openchamber connects directly to OpenCode on localhost
# without being routed through the Tailscale SOCKS5 proxy (which rejects
# localhost connections).
(while true; do
    # Kill any stale process on port 3000 before attempting to start
    fuser -k ${OPENCHAMBER_PORT}/tcp 2>/dev/null || true
    sleep 1
    # Unset ALL_PROXY entirely — Node.js proxy libraries may not respect NO_PROXY
    # correctly for localhost, causing OpenChamber to fail connecting to OpenCode.
    # OPENCODE_HOST must be a full URL (not just hostname) per OpenChamber's validation.
    ALL_PROXY="" all_proxy="" HTTP_PROXY="" HTTPS_PROXY="" http_proxy="" https_proxy="" \
    NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
        OPENCODE_PORT="${OPENCODE_PORT}" \
        OPENCODE_HOST="http://127.0.0.1:${OPENCODE_PORT}" \
        OPENCODE_SKIP_START=true \
        openchamber serve --port "${OPENCHAMBER_PORT}" --host 0.0.0.0 --foreground || true
    echo "[openchamber] Process exited, restarting in 3s..."
    sleep 3
done) &
OPENCHAMBER_PID=$!

# Wait for OpenChamber to be listening before starting Caddy so that
# Azure Container Apps health checks succeed and the new revision is promoted.
echo "[openchamber] Waiting for port ${OPENCHAMBER_PORT}..."
for i in $(seq 1 15); do
    if nc -z 127.0.0.1 "${OPENCHAMBER_PORT}" 2>/dev/null; then
        echo "[openchamber] Ready on port ${OPENCHAMBER_PORT}"
        break
    fi
    sleep 1
done

# Sync once after OpenCode has had time to write auth.json on first connect
(sleep 30 && sync_session_data && echo "[opencode] Early sync completed") &

# ── Periodic maintenance (every 60 seconds) ─────────────────────
# Syncs session data (including auth.json / provider connections) frequently
# so a hard container kill loses at most 60s of state.
(while true; do
    sleep 60
    sync_session_data
    # Copy opencode.json to all git repos (overwrite to ensure copilot-proxy config)
    if [ -f /app/opencode.json ]; then
        for d in "${WORKSPACE_DIR}"/*/; do
            if [ -d "${d}.git" ]; then
                cp /app/opencode.json "${d}opencode.json" 2>/dev/null || true
            fi
        done
    fi
done) &
SYNC_PID=$!

# ── Caddy reverse proxy (foreground) — only way in is Tailscale ──
# If the Tailscale cert was not provisioned, fall back to the HTTP-only Caddyfile.
if [ -f /tmp/tailscale-cert/server.crt ] && [ -f /tmp/tailscale-cert/server.key ]; then
    CADDYFILE=/app/Caddyfile
else
    echo "[caddy] No TLS cert — using HTTP-only config"
    CADDYFILE=/app/Caddyfile.http
fi
exec env XDG_CONFIG_HOME=/caddy/config XDG_DATA_HOME=/caddy/data \
    caddy run --config "${CADDYFILE}" --adapter caddyfile
