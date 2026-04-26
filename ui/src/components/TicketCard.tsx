import { Link } from "react-router-dom";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import type { SessionSummary } from "../lib/types";
import { Icon } from "./Icon";

interface TicketCardProps {
  session: SessionSummary;
  onArchive?: (sessionId: string) => void;
  dragOverlay?: boolean;
}

function TicketStatus({ running }: { running: boolean }) {
  return <span className={`ticket-status${running ? " running" : " idle"}`}>{running ? "Active" : "Idle"}</span>;
}

export function TicketCard({ session, onArchive, dragOverlay = false }: TicketCardProps) {
  const sortable = useSortable({ id: session.id, disabled: dragOverlay });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  return (
    <article
      ref={dragOverlay ? undefined : setNodeRef}
      className={`ticket-card${isDragging ? " dragging" : ""}${dragOverlay ? " overlay" : ""}`}
      style={dragOverlay ? undefined : { transform: CSS.Transform.toString(transform), transition }}
      {...(dragOverlay ? {} : attributes)}
      {...(dragOverlay ? {} : listeners)}
    >
      <div className="ticket-card-top">
        <span className="ticket-move-label">Move</span>
        <div className="ticket-status-wrap">
          <TicketStatus running={session.running} />
        </div>
      </div>
      <Link to={`/session/${session.id}`} className="ticket-link">
        <h3 className="ticket-title">{session.title || "Untitled conversation"}</h3>
        <p className="ticket-preview">{session.preview || "Open this conversation to start working."}</p>
      </Link>
      <div className="ticket-meta">
        <span>{session.messageCount} messages</span>
        <span>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "Just now"}</span>
      </div>
      <div className="ticket-actions">
        <Link to={`/session/${session.id}`} className="ticket-action-link" title="Open conversation">
          <Icon name="open" width="14" height="14" />
          <span>Open</span>
        </Link>
        {onArchive ? (
          <button className="ticket-action-button" type="button" title="Archive conversation" onClick={(event) => { event.stopPropagation(); onArchive(session.id); }}>
            <Icon name="archive" width="14" height="14" />
            <span>Archive</span>
          </button>
        ) : null}
      </div>
    </article>
  );
}
