"""Combined MCP bridge and REST API for crabcode."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
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

OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD", "")
ACTIVE_RUNS: set[str] = set()


class PromptStartRequest(BaseModel):
    prompt: str
    providerID: str | None = None
    modelID: str | None = None
    variant: str | None = None
    mode: str | None = None


def _auth() -> httpx.BasicAuth | None:
    if OPENCODE_PASSWORD:
        return httpx.BasicAuth(OPENCODE_USERNAME or "user", OPENCODE_PASSWORD)
    return None


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=OPENCODE_BASE, auth=_auth(), timeout=120.0)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


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


async def _fetch_sessions() -> list[dict[str, Any]]:
    async with _client() as client:
        response = await client.get("/session")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []


async def _send_prompt(session_id: str, payload: PromptStartRequest) -> None:
    """Send a prompt to an OpenCode session via the synchronous /message endpoint."""
    body: dict[str, Any] = {
        "parts": [{"type": "text", "text": payload.prompt}],
    }
    # Pass model selection if provided (OpenCode 1.15+ format)
    if payload.providerID and payload.modelID:
        body["model"] = {
            "provider": payload.providerID,
            "model": payload.modelID,
        }
    try:
        async with _client() as client:
            response = await client.post(
                f"/session/{session_id}/message",
                json=body,
                timeout=600.0,
            )
            if response.status_code >= 400:
                err_body = response.text[:1000]
                print(
                    f"[mcp_bridge] /message returned {response.status_code} for {session_id}: {err_body}",
                    flush=True,
                )
                response.raise_for_status()
        print(f"[mcp_bridge] prompt completed for session {session_id}", flush=True)
    except Exception as exc:
        print(
            f"[mcp_bridge] ERROR: prompt failed for session {session_id}: {exc}",
            flush=True,
        )
        raise
    finally:
        ACTIVE_RUNS.discard(session_id)


def _run_prompt_job(session_id: str, payload: PromptStartRequest) -> None:
    ACTIVE_RUNS.add(session_id)
    try:
        asyncio.run(_send_prompt(session_id, payload))
    except Exception as exc:
        print(
            f"[mcp_bridge] ERROR: background prompt job failed for {session_id}: {exc}",
            flush=True,
        )


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
    body = {"parts": [{"type": "text", "text": prompt}]}
    async with _client() as client:
        resp = await client.post(
            f"/session/{session_id}/message", json=body, timeout=300.0
        )
        resp.raise_for_status()
        return {"ok": True, "sessionId": session_id}
        return {"ok": True, "sessionId": session_id}


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


# Build the MCP sub-app once so we can reference its session_manager in the lifespan
_mcp_sub_app = mcp.streamable_http_app()


@contextlib.asynccontextmanager
async def _lifespan(application: FastAPI):  # noqa: ARG001
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


class SessionCreateRequest(BaseModel):
    lane: str = "now"
    title: str | None = None
    directory: str | None = None


# ── Patch session directory in OpenCode's SQLite DB ─────────────────
# OpenCode ignores the 'directory' field on POST /session and always uses
# its CWD (/workspace).  We patch the DB directly so OpenChamber groups
# the session under the correct workspace.

_OC_DB_PATH: str | None = None


def _find_opencode_db() -> str | None:
    """Locate OpenCode's SQLite database (cached after first hit)."""
    global _OC_DB_PATH
    if _OC_DB_PATH is not None:
        return _OC_DB_PATH or None
    xdg_data = os.environ.get("XDG_DATA_HOME", "")
    candidates = []
    if xdg_data:
        candidates.append(os.path.join(xdg_data, "opencode", "opencode.db"))
    candidates += [
        os.path.expanduser("~/.local/share/opencode/opencode.db"),
        "/tmp/opencode-data/opencode/opencode.db",
    ]
    for c in candidates:
        if os.path.isfile(c):
            _OC_DB_PATH = c
            print(f"[mcp_bridge] OpenCode DB: {c}", flush=True)
            return c
    _OC_DB_PATH = ""
    return None


def _patch_session_directory(session_id: str, directory: str) -> None:
    """Update the directory column for a session in OpenCode's SQLite DB."""
    db_path = _find_opencode_db()
    if not db_path:
        print("[mcp_bridge] Cannot patch session directory: DB not found", flush=True)
        return
    try:
        import sqlite3

        conn = sqlite3.connect(db_path)
        cur = conn.execute(
            "UPDATE session SET directory = ? WHERE id = ?",
            (directory, session_id),
        )
        conn.commit()
        if cur.rowcount > 0:
            print(
                f"[mcp_bridge] Patched session {session_id} directory → {directory}",
                flush=True,
            )
        else:
            print(
                f"[mcp_bridge] Session {session_id} not found in DB for directory patch",
                flush=True,
            )
        conn.close()
    except Exception as e:
        print(f"[mcp_bridge] Failed to patch session directory: {e}", flush=True)


@app.post("/session")
async def create_session_internal(
    payload: SessionCreateRequest | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if payload and payload.title:
        body["title"] = payload.title
    async with _client() as client:
        response = await client.post("/session", json=body if body else None)
        response.raise_for_status()
        created = response.json()
    print(
        f"[mcp_bridge] POST /session response: {json.dumps(created)[:500]}", flush=True
    )
    # OpenCode may return the session object directly or nested
    session_id = created.get("id") if isinstance(created, dict) else None
    if not isinstance(session_id, str):
        # Try common nested structures
        for key in ("session", "data"):
            nested = created.get(key, {}) if isinstance(created, dict) else {}
            if isinstance(nested, dict) and isinstance(nested.get("id"), str):
                session_id = nested["id"]
                break
    if not isinstance(session_id, str):
        raise HTTPException(
            status_code=502,
            detail=f"OpenCode did not return session id: {json.dumps(created)[:200]}",
        )
    # Patch session directory in OpenCode's SQLite DB if a target directory was provided.
    # OpenCode sets directory=CWD on creation; we override it so OpenChamber groups
    # the session under the correct workspace.
    if payload and payload.directory:
        _patch_session_directory(session_id, payload.directory)
    return {"id": session_id}


@app.post("/session/{session_id}/prompt")
async def start_prompt_internal(
    session_id: str, payload: PromptStartRequest, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    background_tasks.add_task(_run_prompt_job, session_id, payload)
    return {"ok": True, "sessionId": session_id}


@app.get("/session/{session_id}")
async def session_detail_internal(session_id: str) -> dict[str, Any]:
    if not session_id or session_id in ("null", "undefined"):
        from fastapi.responses import JSONResponse

        return JSONResponse({"error": "Invalid session ID"}, status_code=400)
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


app.mount("/mcp-root", _mcp_sub_app)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=MCP_BRIDGE_PORT)
// oc-vis-test-v2
