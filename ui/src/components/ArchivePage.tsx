import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getArchive, restoreSession } from "../lib/api";
import type { SessionSummary } from "../lib/types";

export function ArchivePage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getArchive()
      .then((data) => {
        setSessions(data.sessions);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load archive"))
      .finally(() => setLoading(false));
  }, []);

  async function handleRestore(sessionId: string) {
    await restoreSession(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
  }

  return (
    <section className="archive-page">
      <div className="archive-head">
        <div>
          <h1>Archive</h1>
          <p>Restore conversations back to their last active lane.</p>
        </div>
        <Link className="archive-back-link" to="/">Back to board</Link>
      </div>
      {loading ? <div className="page-state">Loading archive...</div> : null}
      {error ? <div className="page-state error">{error}</div> : null}
      {!loading && !error ? (
        <div className="archive-list">
          {sessions.map((session) => (
            <article key={session.id} className="archive-card">
              <div>
                <h2>{session.title || "Untitled conversation"}</h2>
                <p>{session.preview || "No preview available."}</p>
              </div>
              <div className="archive-card-actions">
                <Link to={`/session/${session.id}`} className="ticket-action-link">Open</Link>
                <button className="lane-new-button" type="button" onClick={() => handleRestore(session.id)}>
                  Restore
                </button>
              </div>
            </article>
          ))}
          {sessions.length === 0 ? <div className="lane-empty">No archived conversations.</div> : null}
        </div>
      ) : null}
    </section>
  );
}
