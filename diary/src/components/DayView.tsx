"use client";

import { useState } from "react";

interface JournalEntry {
  id?: string;
  date: string | Date;
  content: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string | Date;
  endTime: string | Date;
  allDay: boolean;
  location?: string | null;
  url?: string | null;
  source: string;
}

interface MediaItem {
  id: string;
  filename: string;
  mimeType: string;
  thumbnailUrl?: string | null;
  webUrl?: string | null;
  takenAt?: string | Date | null;
}

interface Location {
  id: string;
  label: string;
  lat: number;
  lng: number;
  date: string | Date;
  type: string;
}

interface DayViewProps {
  date: string;
  journalEntry: JournalEntry | null;
  events: CalendarEvent[];
  media: MediaItem[];
  locations: Location[];
}

export default function DayView({ date, journalEntry, events, media, locations }: DayViewProps) {
  const [content, setContent] = useState(journalEntry?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const prevDate = new Date(date + "T00:00:00.000Z");
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const nextDate = new Date(date + "T00:00:00.000Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);

  async function saveJournal() {
    setSaving(true);
    await fetch("/api/journal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, content }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Navigation */}
      <div className="flex items-center gap-4 mb-6">
        <a href={`?date=${prevDate.toISOString().split("T")[0]}`} className="text-gray-400 hover:text-white">←</a>
        <h1 className="text-xl font-semibold">{date}</h1>
        <a href={`?date=${nextDate.toISOString().split("T")[0]}`} className="text-gray-400 hover:text-white">→</a>
        <a href={`?date=${new Date().toISOString().split("T")[0]}`} className="text-sm text-blue-400 ml-auto">Today</a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Journal */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="font-medium text-gray-300">Journal</h2>
          <textarea
            className="w-full h-64 bg-gray-800 border border-gray-700 rounded p-3 text-sm font-mono resize-none focus:outline-none focus:border-blue-500"
            placeholder="Write your journal entry (markdown supported)..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={saveJournal}
              disabled={saving}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {saved && <span className="text-green-400 text-sm">Saved!</span>}
          </div>

          {/* Media */}
          {media.length > 0 && (
            <div>
              <h3 className="font-medium text-gray-300 mb-2">Photos & Videos</h3>
              <div className="grid grid-cols-3 gap-2">
                {media.map((item) => (
                  <a key={item.id} href={item.webUrl ?? "#"} target="_blank" rel="noopener">
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt={item.filename}
                        className="w-full h-24 object-cover rounded"
                      />
                    ) : (
                      <div className="w-full h-24 bg-gray-700 rounded flex items-center justify-center text-xs text-gray-400">
                        {item.filename}
                      </div>
                    )}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar: events + locations */}
        <div className="space-y-4">
          <div>
            <h2 className="font-medium text-gray-300 mb-2">Events ({events.length})</h2>
            {events.length === 0 ? (
              <p className="text-sm text-gray-500">No events</p>
            ) : (
              <ul className="space-y-2">
                {events.map((ev) => (
                  <li key={ev.id} className="bg-gray-800 rounded p-2 text-sm">
                    <div className="font-medium truncate">{ev.title}</div>
                    {!ev.allDay && (
                      <div className="text-gray-400 text-xs">
                        {new Date(ev.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {" – "}
                        {new Date(ev.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    )}
                    {ev.location && <div className="text-gray-400 text-xs truncate">{ev.location}</div>}
                    <div className="text-gray-600 text-xs">{ev.source}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {locations.length > 0 && (
            <div>
              <h2 className="font-medium text-gray-300 mb-2">Locations</h2>
              <ul className="space-y-1">
                {locations.map((loc) => (
                  <li key={loc.id} className="text-sm bg-gray-800 rounded p-2">
                    <div className="font-medium">{loc.label}</div>
                    <div className="text-gray-400 text-xs">{loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
