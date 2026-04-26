import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { BoardPage } from "./components/BoardPage";
import { ArchivePage } from "./components/ArchivePage";
import { ProviderConnectionsPanel } from "./components/ProviderConnectionsPanel";
import { SessionPage } from "./components/SessionPage";

export function App() {
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  useEffect(() => {
    const open = () => setConnectionsOpen(true);
    window.addEventListener("nova:open-connections", open);
    return () => window.removeEventListener("nova:open-connections", open);
  }, []);

  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/session/:sessionId" element={<SessionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <ProviderConnectionsPanel open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
    </div>
  );
}
