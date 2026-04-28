"""Combined MCP bridge and custom REST API for crabcode."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sqlite3
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_NOTIFY_TARGET = os.environ.get("TELEGRAM_NOTIFY_TARGET", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

OPENCODE_HOST = os.environ.get("OPENCODE_HOST", "127.0.0.1")
OPENCODE_PORT = os.environ.get("OPENCODE_PORT", "4096")
OPENCODE_BASE = f"http://{OPENCODE_HOST}:{OPENCODE_PORT}"

MCP_BRIDGE_PORT = int(os.environ.get("MCP_BRIDGE_PORT", "8081"))
BASE_PATH = os.environ.get("BASE_PATH", "")
WORKSPACE_DIR = Path(os.environ.get("WORKSPACE_DIR", "/workspace"))
# The MCP bridge state DB is low-contention (single writer) so it is safe on Azure File Share.
# Default to the persistent volume so board state survives container restarts.
STATE_DIR = Path(
    os.environ.get("MCP_BRIDGE_STATE_DIR", "/workspace/.opencode/data/mcp-bridge-state")
)
DB_PATH = STATE_DIR / "state.db"

OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD", "")
LANES = ("later", "next", "now")
ACTIVE_RUNS: set[str] = set()
TERMINAL_PROCESS: subprocess.Popen[str] | None = None
TERMINAL_PROCESS_LOCK = threading.Lock()


def _auth_file_paths() -> list[Path]:
    home = Path.home()
    candidates: list[Path] = []
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        candidates.append(Path(xdg_data_home) / "opencode" / "auth.json")
    candidates.append(WORKSPACE_DIR / ".opencode" / "data" / "opencode" / "auth.json")
    candidates.append(home / ".local" / "share" / "opencode" / "auth.json")

    unique_candidates: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve(strict=False)
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_candidates.append(candidate)
    return unique_candidates


def _connected_auth_providers() -> list[str]:
    connected: set[str] = set()
    for path in _auth_file_paths():
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text())
        except Exception:
            continue
        if isinstance(payload, dict):
            connected.update(key for key in payload.keys() if isinstance(key, str))
    return sorted(connected)


class CreateSessionRequest(BaseModel):
    lane: str


class MoveSessionRequest(BaseModel):
    lane: str
    afterId: str | None = None


class WorkspaceFileUpdateRequest(BaseModel):
    path: str
    content: str


class TerminalCommandRequest(BaseModel):
    command: str


def _normalize_terminal_command(command: str) -> tuple[str, str | None]:
    stripped = command.strip()
    if stripped == "gh auth login":
        return (
            "gh auth login --hostname github.com --web --git-protocol https --skip-ssh-key",
            "Using browser-based non-interactive GitHub auth flow for terminal panel.",
        )
    return command, None


class PromptStartRequest(BaseModel):
    prompt: str
    providerID: str
    modelID: str
    variant: str
    mode: str


class SessionBoardRecord(BaseModel):
    session_id: str
    lane: str
    archived: bool
    sort_order: float
    last_lane: str | None
    updated_at: str
    archived_at: str | None


def _auth() -> httpx.BasicAuth | None:
    if OPENCODE_PASSWORD:
        return httpx.BasicAuth(OPENCODE_USERNAME or "user", OPENCODE_PASSWORD)
    return None


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=OPENCODE_BASE, auth=_auth(), timeout=120.0)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _ensure_db() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_board_state (
                session_id TEXT PRIMARY KEY,
                lane TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                sort_order REAL NOT NULL DEFAULT 0,
                last_lane TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT
            )
            """
        )
        conn.commit()


def _row_to_record(row: sqlite3.Row) -> SessionBoardRecord:
    return SessionBoardRecord(
        session_id=row["session_id"],
        lane=row["lane"],
        archived=bool(row["archived"]),
        sort_order=row["sort_order"],
        last_lane=row["last_lane"],
        updated_at=row["updated_at"],
        archived_at=row["archived_at"],
    )


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_lane(value: str) -> str:
    lane = value.lower().strip()
    if lane not in LANES:
        raise HTTPException(status_code=400, detail=f"Invalid lane: {value}")
    return lane


def _workspace_path(path: str) -> Path:
    candidate = (WORKSPACE_DIR / path).resolve()
    workspace_root = WORKSPACE_DIR.resolve()
    if candidate != workspace_root and workspace_root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Path escapes workspace")
    return candidate


def _workspace_tree(root: Path) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for child in sorted(
        root.iterdir(), key=lambda item: (item.is_file(), item.name.lower())
    ):
        if child.name in {".git", "node_modules", ".crabcode"}:
            continue
        relative_path = child.relative_to(WORKSPACE_DIR).as_posix()
        if child.is_dir():
            nodes.append(
                {
                    "name": child.name,
                    "path": relative_path,
                    "type": "directory",
                    "children": _workspace_tree(child),
                }
            )
        else:
            nodes.append({"name": child.name, "path": relative_path, "type": "file"})
    return nodes


def _get_record(session_id: str) -> SessionBoardRecord | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM session_board_state WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    return _row_to_record(row) if row else None


def _upsert_session_state(
    session_id: str,
    lane: str,
    archived: bool,
    sort_order: float | None = None,
    last_lane: str | None = None,
) -> None:
    now = _utc_now()
    lane = _normalize_lane(lane)
    with _db() as conn:
        existing = conn.execute(
            "SELECT * FROM session_board_state WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if sort_order is None:
            if existing:
                sort_order = existing["sort_order"]
            else:
                max_row = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM session_board_state WHERE lane = ? AND archived = 0",
                    (lane,),
                ).fetchone()
                sort_order = float(max_row["max_order"] or 0) + 1024.0
        if existing:
            conn.execute(
                """
                UPDATE session_board_state
                SET lane = ?, archived = ?, sort_order = ?, last_lane = ?, updated_at = ?, archived_at = ?
                WHERE session_id = ?
                """,
                (
                    lane,
                    1 if archived else 0,
                    sort_order,
                    last_lane,
                    now,
                    now if archived else None,
                    session_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO session_board_state (
                    session_id, lane, archived, sort_order, last_lane, created_at, updated_at, archived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    lane,
                    1 if archived else 0,
                    sort_order,
                    last_lane,
                    now,
                    now,
                    now if archived else None,
                ),
            )
        conn.commit()


def _archive_session_state(session_id: str) -> None:
    record = _get_record(session_id)
    last_lane = record.lane if record else "next"
    _upsert_session_state(session_id, last_lane, archived=True, last_lane=last_lane)


def _restore_session_state(session_id: str) -> None:
    record = _get_record(session_id)
    if not record:
        _upsert_session_state(session_id, "next", archived=False, last_lane="next")
        return
    restore_lane = record.last_lane or record.lane or "next"
    _upsert_session_state(
        session_id, restore_lane, archived=False, last_lane=restore_lane
    )


def _reorder_session_state(session_id: str, lane: str, after_id: str | None) -> None:
    lane = _normalize_lane(lane)
    with _db() as conn:
        rows = conn.execute(
            "SELECT session_id, sort_order FROM session_board_state WHERE lane = ? AND archived = 0 ORDER BY sort_order ASC",
            (lane,),
        ).fetchall()
        if after_id:
            after_index = next(
                (
                    index
                    for index, row in enumerate(rows)
                    if row["session_id"] == after_id
                ),
                None,
            )
            if after_index is None:
                sort_order = float(rows[-1]["sort_order"] + 1024.0) if rows else 1024.0
            else:
                prev_order = float(rows[after_index]["sort_order"])
                next_order = (
                    float(rows[after_index + 1]["sort_order"])
                    if after_index + 1 < len(rows)
                    else prev_order + 1024.0
                )
                sort_order = (prev_order + next_order) / 2.0
        else:
            first = rows[0]["sort_order"] if rows else 1024.0
            sort_order = float(first) / 2.0 if rows else 1024.0
    _upsert_session_state(
        session_id, lane, archived=False, sort_order=sort_order, last_lane=lane
    )


def _extract_title(session: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    title = session.get("title") or session.get("name")
    if isinstance(title, str) and title.strip():
        return title.strip()
    for message in messages:
        for part in message.get("parts", []) or []:
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                line = text.strip().splitlines()[0]
                return line[:80]
    return "Untitled conversation"


def _extract_preview(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        for part in message.get("parts", []) or []:
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip().replace("\n", " ")[:180]
    return ""


async def _fetch_sessions() -> list[dict[str, Any]]:
    async with _client() as client:
        response = await client.get("/session")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []


async def _run_prompt_in_background(
    session_id: str, payload: PromptStartRequest
) -> None:
    ACTIVE_RUNS.add(session_id)
    try:
        async with _client() as client:
            response = await client.post(
                f"/session/{session_id}/message",
                json={
                    "parts": [{"type": "text", "text": payload.prompt}],
                    "model": {
                        "providerID": payload.providerID,
                        "modelID": payload.modelID,
                    },
                    "variant": payload.variant,
                    "mode": payload.mode,
                    "agent": payload.mode,
                    "tools": {},
                },
                timeout=300.0,
            )
            response.raise_for_status()
    finally:
        ACTIVE_RUNS.discard(session_id)


def _run_prompt_job(session_id: str, payload: PromptStartRequest) -> None:
    asyncio.run(_run_prompt_in_background(session_id, payload))


async def _fetch_messages(session_id: str, limit: int = 25) -> list[dict[str, Any]]:
    async with _client() as client:
        response = await client.get(
            f"/session/{session_id}/message", params={"limit": limit}
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []


async def _fetch_session_detail(session_id: str) -> dict[str, Any]:
    async with _client() as client:
        session_response, messages_response = await asyncio.gather(
            client.get(f"/session/{session_id}"),
            client.get(f"/session/{session_id}/message"),
        )
        session_response.raise_for_status()
        messages_response.raise_for_status()

        session = session_response.json()
        messages = messages_response.json()
        status = session.get("status")
        if isinstance(status, dict):
            running = status.get("type") not in (None, "idle", "complete")
        else:
            running = status not in (None, "idle", "complete")

        return {
            "id": session_id,
            "title": _extract_title(
                session, messages if isinstance(messages, list) else []
            ),
            "updatedAt": session.get("time", {}).get("updated")
            if isinstance(session.get("time"), dict)
            else None,
            "running": bool(running or session_id in ACTIVE_RUNS),
            "messages": messages if isinstance(messages, list) else [],
        }


async def _build_session_summary(session: dict[str, Any]) -> dict[str, Any]:
    session_id = session.get("id")
    if not isinstance(session_id, str):
        raise HTTPException(status_code=500, detail="Invalid session id")
    record = _get_record(session_id)
    messages = await _fetch_messages(session_id, limit=20)
    lane = record.lane if record else "next"
    status = session.get("status")
    if isinstance(status, dict):
        running = status.get("type") not in (None, "idle", "complete")
    else:
        running = status not in (None, "idle", "complete")
    return {
        "id": session_id,
        "title": _extract_title(session, messages),
        "preview": _extract_preview(messages),
        "updatedAt": session.get("time", {}).get("updated")
        if isinstance(session.get("time"), dict)
        else None,
        "lane": lane,
        "archived": record.archived if record else False,
        "running": bool(running or session_id in ACTIVE_RUNS),
        "messageCount": len(messages),
    }


async def _board_payload() -> dict[str, Any]:
    sessions = await _fetch_sessions()
    summaries = await asyncio.gather(
        *(_build_session_summary(session) for session in sessions)
    )
    lanes: dict[str, list[dict[str, Any]]] = {lane: [] for lane in LANES}
    archive: list[dict[str, Any]] = []

    for summary in summaries:
        record = _get_record(summary["id"])
        if record and record.archived:
            archive.append(summary)
            continue
        lanes[summary["lane"]].append(summary)

    def sort_key(item: dict[str, Any]) -> float:
        record = _get_record(item["id"])
        return record.sort_order if record else 1024.0

    for lane in LANES:
        lanes[lane].sort(key=sort_key)

    archive.sort(key=sort_key)
    return {"lanes": lanes, "archiveCount": len(archive)}


def _event_session_id(event: Any) -> str | None:
    if not isinstance(event, dict):
        return None

    properties = event.get("properties")
    if not isinstance(properties, dict):
        return None

    for key in ("sessionID", "sessionId"):
        value = properties.get(key)
        if isinstance(value, str) and value:
            return value

    info = properties.get("info")
    if isinstance(info, dict):
        info_session_id = info.get("sessionID") or info.get("sessionId")
        if isinstance(info_session_id, str) and info_session_id:
            return info_session_id
        if str(event.get("type", "")).startswith("session."):
            info_id = info.get("id")
            if isinstance(info_id, str) and info_id:
                return info_id

    part = properties.get("part")
    if isinstance(part, dict):
        part_session_id = part.get("sessionID") or part.get("sessionId")
        if isinstance(part_session_id, str) and part_session_id:
            return part_session_id

    tool = properties.get("tool")
    if isinstance(tool, dict):
        tool_session_id = tool.get("sessionID") or tool.get("sessionId")
        if isinstance(tool_session_id, str) and tool_session_id:
            return tool_session_id

    return None


def _format_sse_message(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


async def _relay_global_events(session_id: str | None):
    headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}

    async with _client() as client:
        async with client.stream(
            "GET", "/global/event", headers=headers, timeout=None
        ) as response:
            response.raise_for_status()

            event_name = "message"
            data_lines: list[str] = []

            async for line in response.aiter_lines():
                if line == "":
                    if not data_lines:
                        event_name = "message"
                        continue

                    raw_data = "\n".join(data_lines)
                    try:
                        parsed_data: Any = json.loads(raw_data)
                    except json.JSONDecodeError:
                        parsed_data = raw_data

                    payload = {"event": event_name, "data": parsed_data}
                    if (
                        session_id is None
                        or _event_session_id(parsed_data) == session_id
                    ):
                        yield _format_sse_message(payload)

                    event_name = "message"
                    data_lines = []
                    continue

                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip() or "message"
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())

            if data_lines:
                raw_data = "\n".join(data_lines)
                try:
                    parsed_data = json.loads(raw_data)
                except json.JSONDecodeError:
                    parsed_data = raw_data
                if session_id is None or _event_session_id(parsed_data) == session_id:
                    yield _format_sse_message(
                        {"event": event_name, "data": parsed_data}
                    )


mcp = FastMCP(
    "crabcode",
    instructions=(
        "Use these tools to interact with OpenCode — an AI coding assistant "
        "running in the Nova platform. You can create sessions, send prompts, "
        "retrieve file diffs, and manage the assistant programmatically."
    ),
    streamable_http_path="/",
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@mcp.tool(name="list_sessions")
async def list_sessions() -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get("/session")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="create_session")
async def create_session() -> dict[str, Any]:
    async with _client() as client:
        resp = await client.post("/session")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_session")
async def get_session(session_id: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get(f"/session/{session_id}")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="send_prompt")
async def send_prompt(session_id: str, prompt: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.post(
            f"/session/{session_id}/message", json={"content": prompt}, timeout=300.0
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_messages")
async def get_messages(session_id: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get(f"/session/{session_id}/message")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="abort_session")
async def abort_session(session_id: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.post(f"/session/{session_id}/abort")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_files")
async def get_files() -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get("/file")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_file")
async def get_file(path: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get("/file/read", params={"path": path})
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_diff")
async def get_diff(session_id: str) -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get(f"/session/{session_id}/diff")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_config")
async def get_config() -> dict[str, Any]:
    async with _client() as client:
        resp = await client.get("/config")
        resp.raise_for_status()
        return resp.json()


@mcp.tool(name="get_status")
async def get_status() -> dict[str, Any]:
    try:
        async with _client() as client:
            resp = await client.get("/config")
            opencode_ok = resp.status_code == 200
    except Exception:
        opencode_ok = False
    return {
        "base_path": BASE_PATH,
        "opencode_url": OPENCODE_BASE,
        "opencode_reachable": opencode_ok,
        "mcp_bridge_port": MCP_BRIDGE_PORT,
        "state_db": str(DB_PATH),
    }


@mcp.tool(name="send_telegram_message")
async def send_telegram_message(chat_id: str, text: str) -> dict[str, Any]:
    """Send a Markdown message to a Telegram chat.

    chat_id: numeric Telegram chat ID (extract from sender by stripping the
             "telegram-" prefix, e.g. sender="telegram-123456" → chat_id="123456").
    text:    message body; Markdown formatting is supported.
    """
    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "CHANGE_ME":
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN not configured"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
        )
        data = resp.json()
        # Retry without parse_mode if Telegram rejects the Markdown
        if not data.get("ok") and resp.status_code == 400:
            resp2 = await client.post(
                f"{TELEGRAM_API}/sendMessage",
                json={"chat_id": chat_id, "text": text},
            )
            data = resp2.json()
        return data


app = FastAPI(title="crabcode")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Build the MCP sub-app once so we can reference its session_manager in the lifespan
_mcp_sub_app = mcp.streamable_http_app()


@contextlib.asynccontextmanager
async def _lifespan(application: FastAPI):  # noqa: ARG001
    _ensure_db()
    # The MCP streamable-HTTP session manager needs its task group started.
    # We enter its lifespan context manually since FastAPI does not propagate
    # sub-application lifespans when using app.mount().
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="crabcode", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _normalize_mcp_accept(request, call_next):
    """Ensure MCP sub-app always sees 'application/json' in Accept.

    CrabTalk sends 'Accept: text/event-stream' for post-initialize requests,
    but FastMCP with json_response=True requires 'application/json'.
    We normalise the header so both transports work.
    """
    if request.url.path.startswith("/mcp-root"):
        accept = request.headers.get("accept", "")
        if "application/json" not in accept:
            # Rebuild the ASGI scope headers with the fixed Accept value
            new_accept = (accept + ", application/json").lstrip(", ").encode()
            new_headers = [
                (k, v) for k, v in request.scope["headers"] if k.lower() != b"accept"
            ]
            new_headers.append((b"accept", new_accept))
            request.scope["headers"] = new_headers
    return await call_next(request)


@app.get("/board")
async def get_board() -> dict[str, Any]:
    return await _board_payload()


@app.get("/options/composer")
async def get_composer_options() -> dict[str, Any]:
    async with _client() as client:
        response = await client.get("/config/providers")
        response.raise_for_status()
        payload = response.json()

    models: list[dict[str, Any]] = []
    providers = payload.get("providers", []) if isinstance(payload, dict) else []
    for provider in providers:
        provider_id = provider.get("id")
        model_map = provider.get("models", {})
        if not isinstance(provider_id, str) or not isinstance(model_map, dict):
            continue
        for model_id, model in model_map.items():
            if not isinstance(model_id, str) or not isinstance(model, dict):
                continue
            variants = model.get("variants", {})
            models.append(
                {
                    "providerID": provider_id,
                    "modelID": model_id,
                    "name": model.get("name") or model_id,
                    "variants": list(variants.keys())
                    if isinstance(variants, dict) and variants
                    else ["medium"],
                }
            )

    default = payload.get("default", {}) if isinstance(payload, dict) else {}
    default_model = None
    if isinstance(default, dict):
        for provider_id, model_id in default.items():
            if isinstance(provider_id, str) and isinstance(model_id, str):
                default_model = {"providerID": provider_id, "modelID": model_id}
                break

    return {"models": models, "defaultModel": default_model}


@app.get("/auth/providers")
async def get_auth_providers() -> dict[str, Any]:
    return {"connected": _connected_auth_providers()}


@app.get("/archive")
async def get_archive() -> dict[str, Any]:
    sessions = await _fetch_sessions()
    archived = []
    for session in sessions:
        summary = await _build_session_summary(session)
        record = _get_record(summary["id"])
        if record and record.archived:
            archived.append(summary)

    def sort_key(item: dict[str, Any]) -> float:
        record = _get_record(item["id"])
        return record.sort_order if record else 1024.0

    archived.sort(key=sort_key)
    return {"sessions": archived}


@app.post("/session")
async def create_session_internal(payload: CreateSessionRequest) -> dict[str, Any]:
    lane = _normalize_lane(payload.lane)
    async with _client() as client:
        response = await client.post("/session")
        response.raise_for_status()
        created = response.json()
    session_id = created.get("id")
    if not isinstance(session_id, str):
        raise HTTPException(
            status_code=502, detail="OpenCode did not return session id"
        )
    _upsert_session_state(session_id, lane, archived=False, last_lane=lane)
    return {"id": session_id}


@app.post("/session/{session_id}/prompt")
async def start_prompt_internal(
    session_id: str, payload: PromptStartRequest, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    ACTIVE_RUNS.add(session_id)
    background_tasks.add_task(_run_prompt_job, session_id, payload)
    return {"ok": True, "sessionId": session_id}


@app.patch("/session/{session_id}/lane")
async def move_session_internal(
    session_id: str, payload: MoveSessionRequest
) -> dict[str, Any]:
    _reorder_session_state(session_id, payload.lane, payload.afterId)
    return {"ok": True}


@app.post("/session/{session_id}/archive")
async def archive_session_internal(session_id: str) -> dict[str, Any]:
    _archive_session_state(session_id)
    return {"ok": True}


@app.post("/session/{session_id}/restore")
async def restore_session_internal(session_id: str) -> dict[str, Any]:
    _restore_session_state(session_id)
    return {"ok": True}


@app.get("/session/{session_id}")
async def session_detail_internal(session_id: str) -> dict[str, Any]:
    return await _fetch_session_detail(session_id)


@app.get("/events")
async def internal_events(
    sessionId: str | None = Query(default=None),
) -> StreamingResponse:
    return StreamingResponse(
        _relay_global_events(sessionId),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/workspace/tree")
async def workspace_tree_internal() -> dict[str, Any]:
    return {"tree": _workspace_tree(WORKSPACE_DIR)}


@app.get("/workspace/file")
async def workspace_file_internal(path: str = Query(...)) -> dict[str, Any]:
    file_path = _workspace_path(path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return {"path": path, "content": file_path.read_text()}


@app.put("/workspace/file")
async def workspace_file_update_internal(
    payload: WorkspaceFileUpdateRequest,
) -> dict[str, Any]:
    file_path = _workspace_path(payload.path)
    if file_path.exists() and not file_path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(payload.content)
    return {"ok": True}


@app.post("/terminal/run")
async def terminal_run_internal(payload: TerminalCommandRequest) -> dict[str, Any]:
    command, note = _normalize_terminal_command(payload.command)

    def run() -> subprocess.CompletedProcess[str]:
        global TERMINAL_PROCESS
        with TERMINAL_PROCESS_LOCK:
            if TERMINAL_PROCESS and TERMINAL_PROCESS.poll() is None:
                raise RuntimeError("Another terminal command is already running")
            TERMINAL_PROCESS = subprocess.Popen(
                ["bash", "-lc", command],
                cwd=WORKSPACE_DIR,
                env={**os.environ, "TERM": os.environ.get("TERM", "xterm-256color")},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            proc = TERMINAL_PROCESS

        assert proc is not None
        try:
            stdout, stderr = proc.communicate(timeout=300)
            return subprocess.CompletedProcess(
                args=["bash", "-lc", command],
                returncode=proc.returncode,
                stdout=stdout,
                stderr=stderr,
            )
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            stdout, stderr = proc.communicate()
            return subprocess.CompletedProcess(
                args=["bash", "-lc", command],
                returncode=124,
                stdout=stdout,
                stderr=(stderr + "\nCommand timed out after 300 seconds").strip(),
            )
        finally:
            with TERMINAL_PROCESS_LOCK:
                if TERMINAL_PROCESS is proc:
                    TERMINAL_PROCESS = None

    try:
        completed = await asyncio.to_thread(run)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if note:
        stdout = f"{note}\n{stdout}" if stdout else f"{note}\n"

    return {
        "command": command,
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": completed.returncode,
    }


@app.post("/terminal/interrupt")
async def terminal_interrupt_internal() -> dict[str, Any]:
    with TERMINAL_PROCESS_LOCK:
        proc = TERMINAL_PROCESS
    if not proc or proc.poll() is not None:
        return {"ok": True, "signaled": False}
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        return {"ok": True, "signaled": False}
    return {"ok": True, "signaled": True}


app.mount("/mcp-root", _mcp_sub_app)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=MCP_BRIDGE_PORT)
