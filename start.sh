#!/usr/bin/env bash
# start.sh — entrypoint for crabcode container
# Starts Tailscale, OpenCode web UI, CrabTalk, Telegram bridge, and Caddy.
# All services are only reachable via Tailscale — no public ingress.
set -euo pipefail

export BASE_PATH="${BASE_PATH:-}"
export OPENCODE_PORT="${OPENCODE_PORT:-4096}"
export MCP_BRIDGE_PORT="${MCP_BRIDGE_PORT:-8081}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
export OPENCODE_XDG_ROOT="${WORKSPACE_DIR}/.opencode"
export PERSISTENT_HOME="${WORKSPACE_DIR}/.home/crabcode"
export XDG_CONFIG_HOME="${OPENCODE_XDG_ROOT}/config"
# SQLite doesn't work on Azure File Share — put data/cache on local ephemeral storage
export XDG_DATA_HOME="/tmp/opencode-data"
export XDG_CACHE_HOME="/tmp/opencode-cache"

# ── Persistent home setup ────────────────────────────────────────
mkdir -p "${PERSISTENT_HOME}" "${PERSISTENT_HOME}/.config" \
         "${PERSISTENT_HOME}/.cache" "${PERSISTENT_HOME}/.local/share"

mkdir -p "${OPENCODE_XDG_ROOT}/config/opencode" \
         "${XDG_DATA_HOME}" \
         "${XDG_CACHE_HOME}"

# Always overwrite config from image (ensures config updates propagate)
# Expand env vars (e.g. LINEAR_API_KEY) in the config
if [ -f /home/crabcode/.config/opencode/opencode.json ]; then
    envsubst '$LINEAR_API_KEY' < /home/crabcode/.config/opencode/opencode.json > "${OPENCODE_XDG_ROOT}/config/opencode/opencode.json"
fi

# Persist git config
if [ -f /home/crabcode/.gitconfig ] && [ ! -f "${PERSISTENT_HOME}/.gitconfig" ]; then
    cp /home/crabcode/.gitconfig "${PERSISTENT_HOME}/.gitconfig"
fi
if [ -f /home/crabcode/.git-credentials ] && [ ! -f "${PERSISTENT_HOME}/.git-credentials" ]; then
    cp /home/crabcode/.git-credentials "${PERSISTENT_HOME}/.git-credentials"
fi
if [ -d /home/crabcode/.config/gh ] && [ ! -d "${PERSISTENT_HOME}/.config/gh" ]; then
    mkdir -p "${PERSISTENT_HOME}/.config"
    cp -R /home/crabcode/.config/gh "${PERSISTENT_HOME}/.config/gh"
fi

# Symlink persistent dirs
ln -sfn "${PERSISTENT_HOME}/.config" /home/crabcode/.config
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
echo "  Caddy proxy     : port 80 (Tailscale only)"
echo "  OpenCode web UI : port ${OPENCODE_PORT} (internal)"
echo "  MCP bridge      : port ${MCP_BRIDGE_PORT} (internal)"
echo "  CrabTalk        : port 6688 (internal)"
echo "  Workspace       : /workspace"
echo "  Home            : ${HOME}"
echo "===================="

# ── Trap for cleanup ─────────────────────────────────────────────
cleanup() {
    echo "Shutting down..."
    kill "$TAILSCALE_PID" "$MCP_PID" "$OPENCODE_PID" "$CRABTALK_PID" \
         "$COPILOT_PROXY_PID" "$TELEGRAM_PID" "$LINEAR_AGENT_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Start Tailscale (runs as root, userspace networking) ─────────
# Tailscale state is persisted on the volume, but socket must be local
mkdir -p "${WORKSPACE_DIR}/.tailscale" /tmp/tailscale
tailscaled --state="${WORKSPACE_DIR}/.tailscale/tailscaled.state" \
           --socket=/tmp/tailscale/tailscaled.sock \
           --tun=userspace-networking &
TAILSCALE_PID=$!
sleep 2

# Authenticate with pre-auth key (only needed on first run)
tailscale --socket=/tmp/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY:-}" \
    --hostname="${TS_HOSTNAME:-crabcode}" \
    --accept-routes \
    2>/dev/null || echo "[tailscale] Already authenticated or no auth key"

echo "[tailscale] Status: $(tailscale --socket=/tmp/tailscale/tailscaled.sock status --self 2>/dev/null | head -1)"

# ── Bootstrap workspace repos ───────────────────────────────────
# Clone default repos into /workspace on first boot so OpenCode has projects to work with.
# Uses GH_TOKEN for auth. Add more repos to the array as needed.
REPOS=(
    "gpue/crabcode"
)

if [ -n "${GH_TOKEN:-}" ]; then
    git config --global credential.helper store
    echo "https://x-access-token:${GH_TOKEN}@github.com" > "${HOME}/.git-credentials"
    git config --global user.name "crab"
    git config --global user.email "georg.pueschel+crabcode@gmail.com"
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
HOME=/home/crabcode crabtalk --foreground --tcp &
CRABTALK_PID=$!
sleep 3

# ── Telegram bridge (direct TCP to CrabTalk, no NATS) ────────────
node /app/scripts/telegram-bridge.mjs &
TELEGRAM_PID=$!

# ── Linear ticket agent ──────────────────────────────────────────
node /app/scripts/linear-agent.mjs &
LINEAR_AGENT_PID=$!

# ── MCP bridge server ────────────────────────────────────────────
python3 /app/mcp_bridge.py &
MCP_PID=$!

# ── OpenCode web UI ──────────────────────────────────────────────
# Run from the first available repo in /workspace, or /workspace itself
OPENCODE_CWD="${WORKSPACE_DIR}"
for d in "${WORKSPACE_DIR}"/*/; do
    if [ -d "${d}.git" ]; then
        OPENCODE_CWD="${d}"
        break
    fi
done
echo "[opencode] Starting in ${OPENCODE_CWD}"
(cd "${OPENCODE_CWD}" && env opencode web \
    --port "${OPENCODE_PORT}" \
    --hostname 127.0.0.1 \
    --cors "*") &
OPENCODE_PID=$!

sleep 2

# ── Caddy reverse proxy (foreground) — only way in is Tailscale ──
exec env XDG_CONFIG_HOME=/caddy/config XDG_DATA_HOME=/caddy/data \
    caddy run --config /app/Caddyfile --adapter caddyfile
