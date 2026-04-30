import { getJournalEntriesForWeek } from "@/lib/journal-data";
import { getEventsForRange } from "@/lib/calendar-data";
import WeekView from "@/components/WeekView";

interface PageProps {
  searchParams: Promise<{ start?: string }>;
}

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().split("T")[0];
}

export default async function WeekPage({ searchParams }: PageProps) {
  const { start: startParam } = await searchParams;
  const weekStart = startParam ?? getWeekStart(new Date());

  const start = new Date(weekStart + "T00:00:00.000Z");
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [journalEntries, events] = await Promise.all([
    getJournalEntriesForWeek(weekStart),
    getEventsForRange(start, end),
  ]);

  return <WeekView weekStart={weekStart} journalEntries={journalEntries} events={events} />;
}
