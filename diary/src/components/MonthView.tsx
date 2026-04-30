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
}

interface MonthViewProps {
  year: number;
  month: number;
  journalEntries: JournalEntry[];
  events: CalendarEvent[];
}

export default function MonthView({ year, month, journalEntries, events }: MonthViewProps) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDayOfWeek = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();

  const journalByDate = Object.fromEntries(
    journalEntries.map((e) => [new Date(e.date).toISOString().split("T")[0], e])
  );
  const eventsByDate: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const d = new Date(event.startTime).toISOString().split("T")[0];
    eventsByDate[d] = eventsByDate[d] ?? [];
    eventsByDate[d].push(event);
  }

  const prevMonth = month === 1 ? `?year=${year - 1}&month=12` : `?year=${year}&month=${month - 1}`;
  const nextMonth = month === 12 ? `?year=${year + 1}&month=1` : `?year=${year}&month=${month + 1}`;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const today = new Date().toISOString().split("T")[0];

  const cells: (number | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <a href={prevMonth} className="text-gray-400 hover:text-white">←</a>
        <h1 className="text-xl font-semibold">{monthName}</h1>
        <a href={nextMonth} className="text-gray-400 hover:text-white">→</a>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-500 mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, idx) => {
          if (!day) return <div key={idx} />;
          const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const hasJournal = !!journalByDate[dateStr];
          const dayEvents = eventsByDate[dateStr] ?? [];
          const isToday = dateStr === today;

          return (
            <a
              key={idx}
              href={`/dashboard/day?date=${dateStr}`}
              className={`block bg-gray-800 rounded p-1.5 min-h-16 hover:bg-gray-700 text-left ${isToday ? "ring-1 ring-blue-500" : ""}`}
            >
              <div className={`text-sm font-medium mb-1 ${isToday ? "text-blue-400" : ""}`}>{day}</div>
              {dayEvents.length > 0 && (
                <div className="text-xs text-blue-400">{dayEvents.length} ev</div>
              )}
              {hasJournal && <div className="text-xs text-green-400">✎</div>}
            </a>
          );
        })}
      </div>
    </div>
  );
}
