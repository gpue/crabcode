import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Lane, SessionSummary } from "../lib/types";
import { Icon } from "./Icon";
import { TicketCard } from "./TicketCard";

interface LaneColumnProps {
  lane: Lane;
  title: string;
  sessions: SessionSummary[];
  onCreate: (lane: Lane) => void;
  onArchive: (sessionId: string) => void;
}

export function LaneColumn({ lane, title, sessions, onCreate, onArchive }: LaneColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: lane });

  return (
    <section className={`board-lane${isOver ? " is-over" : ""}`} data-lane={lane}>
      <header className="board-lane-header">
        <div>
          <h2>{title}</h2>
          <p>{sessions.length} tickets</p>
        </div>
        <button className="lane-new-button" type="button" onClick={() => onCreate(lane)} title={`Create a new ${title} conversation`}>
          <Icon name="new" width="14" height="14" />
          <span>New</span>
        </button>
      </header>
      <SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="board-lane-list">
          {sessions.map((session) => (
            <TicketCard key={session.id} session={session} onArchive={onArchive} />
          ))}
          {sessions.length === 0 ? <div className="lane-empty">No conversations yet.</div> : null}
        </div>
      </SortableContext>
    </section>
  );
}
