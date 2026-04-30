"use client";

interface JournalEntry {
  id: string;
  date: string | Date;
  content: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string | Date;
  allDay: boolean;
  source: string;
}

interface WeekViewProps {
  weekStart: string;
  journalEntries: JournalEntry[];
  events: CalendarEvent[];
}

function getDaysOfWeek(weekStart: string): string[] {
  const start = new Date(weekStart + "T00:00:00.000Z");
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    return d.toISOString().split("T")[0];
  });
}

export default function WeekView({ weekStart, journalEntries, events }: WeekViewProps) {
  const days = getDaysOfWeek(weekStart);
  const startDate = new Date(weekStart + "T00:00:00.000Z");
  const prevWeek = new Date(startDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const nextWeek = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const journalByDate = Object.fromEntries(
    journalEntries.map((e) => [new Date(e.date).toISOString().split("T")[0], e])
  );
  const eventsByDate: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const d = new Date(event.startTime).toISOString().split("T")[0];
    eventsByDate[d] = eventsByDate[d] ?? [];
    eventsByDate[d].push(event);
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <a href={`?start=${prevWeek}`} className="text-gray-400 hover:text-white">←</a>
        <h1 className="text-xl font-semibold">Week of {weekStart}</h1>
        <a href={`?start=${nextWeek}`} className="text-gray-400 hover:text-white">→</a>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => {
          const entry = journalByDate[day];
          const dayEvents = eventsByDate[day] ?? [];
          const dayName = new Date(day + "T12:00:00.000Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
          const dayNum = new Date(day + "T12:00:00.000Z").toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
          const isToday = day === new Date().toISOString().split("T")[0];

          return (
            <a
              key={day}
              href={`/dashboard/day?date=${day}`}
              className={`block bg-gray-800 rounded p-2 min-h-32 hover:bg-gray-750 ${isToday ? "ring-1 ring-blue-500" : ""}`}
            >
              <div className="font-medium text-sm mb-1">
                <span className="text-gray-400">{dayName}</span>{" "}
                <span className={isToday ? "text-blue-400" : ""}>{dayNum}</span>
              </div>
              {dayEvents.length > 0 && (
                <div className="text-xs text-blue-400 mb-1">{dayEvents.length} event{dayEvents.length !== 1 ? "s" : ""}</div>
              )}
              {entry && (
                <p className="text-xs text-gray-400 line-clamp-3">
                  {entry.content.replace(/[#*`]/g, "").slice(0, 100)}
                </p>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
