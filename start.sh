#!/usr/bin/env bash
# start.sh — entrypoint for crabcode container
# Starts Tailscale, OpenCode web UI, CrabTalk, Telegram bridge, and Caddy.
# All services are only reachable via Tailscale — no public ingress.
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
echo "  Caddy proxy     : port 80 (Tailscale only)"
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
}
cleanup() {
    echo "Shutting down..."
    sync_session_data
    kill "$TAILSCALE_PID" "$MCP_PID" "$OPENCODE_PID" "$CRABTALK_PID" \
         "$COPILOT_PROXY_PID" "$TELEGRAM_PID" "$LINEAR_AGENT_PID" "$SYNC_PID" 2>/dev/null || true
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

# ── Fix /etc/hosts for nova ──────────────────────────────────────
# The container platform injects a stale LAN entry for 'nova' on every start.
# Replace it with the correct Tailscale IP.
sed -i "s/.*\bnova\b.*/100.113.46.67\tnova/" /etc/hosts
grep -q "nova" /etc/hosts || echo "100.113.46.67	nova" >> /etc/hosts
echo "[hosts] nova -> 100.113.46.67"

# ── Bootstrap workspace repos ───────────────────────────────────
# Clone default repos into /workspace on first boot so OpenCode has projects to work with.
# Uses GH_TOKEN for auth. Add more repos to the array as needed.
REPOS=(
    "gpue/crabcode"
)

if [ -n "${GH_TOKEN:-}" ]; then
    git config --global credential.helper store
    echo "https://x-access-token:${GH_TOKEN}@github.com" > "${HOME}/.git-credentials"
    git config --global user.name "Georg Püschel"
    git config --global user.email "georg.pueschel@wandelbots.com"
    echo "${GH_TOKEN}" | gh auth login --with-token
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
# Run from /workspace so all projects are accessible via "Open project"
# Initialize /workspace as a git repo if needed (OpenCode requires a git context)
if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
    (cd "${WORKSPACE_DIR}" && git init -b main && git commit --allow-empty -m "workspace root" 2>/dev/null) || true
fi
echo "[opencode] Starting in ${WORKSPACE_DIR}"
(cd "${WORKSPACE_DIR}" && while true; do
    echo "[opencode] Launching opencode web..."
    env opencode web \
        --port "${OPENCODE_PORT}" \
        --hostname 127.0.0.1 \
        --cors "*" || true
    echo "[opencode] Process exited, restarting in 3s..."
    sleep 3
done) &
OPENCODE_PID=$!

# Sync once after OpenCode has had time to write auth.json on first connect
(sleep 30 && sync_session_data && echo "[opencode] Early sync completed") &

# ── Periodic maintenance (every 60 seconds) ─────────────────────
# Syncs session data (including auth.json / provider connections) frequently
# so a hard container kill loses at most 60s of state.
(while true; do
    sleep 60
    sync_session_data
    # Copy opencode.json to any new git repos that appeared since boot
    if [ -f /app/opencode.json ]; then
        for d in "${WORKSPACE_DIR}"/*/; do
            if [ -d "${d}.git" ] && [ ! -f "${d}opencode.json" ]; then
                cp /app/opencode.json "${d}opencode.json" 2>/dev/null || true
                echo "[opencode] Copied config to ${d}"
            fi
        done
    fi
done) &
SYNC_PID=$!

sleep 2

# ── Caddy reverse proxy (foreground) — only way in is Tailscale ──
exec env XDG_CONFIG_HOME=/caddy/config XDG_DATA_HOME=/caddy/data \
    caddy run --config /app/Caddyfile --adapter caddyfile
