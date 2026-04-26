import { useEffect, useMemo, useState } from "react";
import { DndContext, DragEndEvent, DragOverlay, PointerSensor, closestCorners, useSensor, useSensors } from "@dnd-kit/core";
import { useNavigate } from "react-router-dom";
import { archiveSession, createSession, getBoard, getEventsUrl, moveSession } from "../lib/api";
import type { BoardData, Lane, SessionSummary, StreamEnvelope } from "../lib/types";
import { LaneColumn } from "./LaneColumn";
import { TerminalPanel } from "./TerminalPanel";
import { TicketCard } from "./TicketCard";
import { Icon } from "./Icon";
import { WorkspacePanel } from "./WorkspacePanel";

const laneOrder: Array<{ key: Lane; label: string }> = [
  { key: "later", label: "Later" },
  { key: "next", label: "Next" },
  { key: "now", label: "Now" },
];

function cloneLanes(lanes: BoardData["lanes"]) {
  return { later: [...lanes.later], next: [...lanes.next], now: [...lanes.now] } satisfies BoardData["lanes"];
}

function findLaneBySession(lanes: BoardData["lanes"], sessionId: string): Lane | null {
  for (const lane of laneOrder) {
    if (lanes[lane.key].some((session) => session.id === sessionId)) return lane.key;
  }
  return null;
}

function findSession(lanes: BoardData["lanes"], sessionId: string): SessionSummary | null {
  for (const lane of laneOrder) {
    const match = lanes[lane.key].find((session) => session.id === sessionId);
    if (match) return match;
  }
  return null;
}

export function BoardPage() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const navigate = useNavigate();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    let cancelled = false;
    let refreshPending = false;
    let refreshInFlight = false;

    const refresh = () => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }

      refreshInFlight = true;
      getBoard()
        .then((data) => {
          if (!cancelled) {
            setBoard(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load board");
        })
        .finally(() => {
          refreshInFlight = false;
          if (!cancelled) setLoading(false);
          if (refreshPending && !cancelled) {
            refreshPending = false;
            window.setTimeout(refresh, 0);
          }
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 2500);
    const stream = new EventSource(getEventsUrl());
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamEnvelope;
        if (!payload.event || payload.event.startsWith("session.")) {
          refresh();
        }
      } catch {
        refresh();
      }
    };
    stream.onerror = () => {};

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      stream.close();
    };
  }, []);

  async function handleCreate(lane: Lane) {
    const created = await createSession(lane);
    navigate(`/session/${created.id}`);
  }

  async function handleArchive(sessionId: string) {
    await archiveSession(sessionId);
    setBoard((current) => {
      if (!current) return current;
      const lanes = cloneLanes(current.lanes);
      for (const lane of laneOrder) {
        lanes[lane.key] = lanes[lane.key].filter((session) => session.id !== sessionId);
      }
      return { lanes, archiveCount: current.archiveCount + 1 };
    });
  }

  function handleDragStart(event: { active: { id: string | number } }) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (!board || !event.over) return;
    const activeIdValue = String(event.active.id);
    const overId = String(event.over.id);
    const lanes = cloneLanes(board.lanes);
    const fromLane = findLaneBySession(lanes, activeIdValue);
    if (!fromLane) return;
    const sourceIndex = lanes[fromLane].findIndex((item) => item.id === activeIdValue);
    if (sourceIndex === -1) return;

    const [moved] = lanes[fromLane].splice(sourceIndex, 1);
    const isLaneTarget = laneOrder.some((lane) => lane.key === overId);
    const toLane = isLaneTarget ? (overId as Lane) : findLaneBySession(lanes, overId);
    if (!toLane) return;
    moved.lane = toLane;

    if (isLaneTarget) {
      lanes[toLane].push(moved);
      setBoard({ ...board, lanes });
      await moveSession(activeIdValue, toLane, null);
      return;
    }

    const targetIndex = lanes[toLane].findIndex((item) => item.id === overId);
    if (targetIndex === -1) {
      lanes[toLane].push(moved);
      setBoard({ ...board, lanes });
      await moveSession(activeIdValue, toLane, null);
      return;
    }

    lanes[toLane].splice(targetIndex, 0, moved);
    setBoard({ ...board, lanes });
    await moveSession(activeIdValue, toLane, overId);
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  const activeSession = board && activeId ? findSession(board.lanes, activeId) : null;

  const content = useMemo(() => {
    if (loading) return <div className="page-state">Loading board...</div>;
    if (error) return <div className="page-state error">{error}</div>;
    if (!board) return <div className="page-state">No board data.</div>;

    return (
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
        <div className="board-page-head">
          <div>
            <h1>Conversation board</h1>
            <p>Organize OpenCode work into Later, Next, and Now.</p>
          </div>
          <div className="board-toolbar">
            <button className="archive-pill" type="button" onClick={() => setWorkspaceOpen(true)} title="Open workspace panel">
              <Icon name="folder" width="14" height="14" />
              <span>Workspace</span>
            </button>
            <button className={`archive-pill${terminalOpen ? " active" : ""}`} type="button" onClick={() => setTerminalOpen((current) => !current)} title="Toggle terminal overlay">
              <Icon name="terminal" width="14" height="14" />
              <span>Terminal</span>
            </button>
            <button className="archive-pill primary-action" type="button" onClick={() => window.dispatchEvent(new CustomEvent("nova:open-connections"))} title="Connect GitHub Copilot or OpenAI Codex">
              <Icon name="link" width="14" height="14" />
              <span>Connect AI</span>
            </button>
          </div>
        </div>
        <div className="board-grid-wrap">
          <div className="board-grid">
            {laneOrder.map((lane) => (
              <LaneColumn key={lane.key} lane={lane.key} title={lane.label} sessions={board.lanes[lane.key]} onCreate={handleCreate} onArchive={handleArchive} />
            ))}
          </div>
        </div>
        <WorkspacePanel open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} mode="overlay" />
        <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />
        <DragOverlay>{activeSession ? <TicketCard session={activeSession} dragOverlay /> : null}</DragOverlay>
      </DndContext>
    );
  }, [activeSession, board, error, loading, sensors, workspaceOpen, terminalOpen, navigate]);

  return <section className="board-page">{content}</section>;
}
