import { getJournalEntriesForMonth } from "@/lib/journal-data";
import { getEventsForRange } from "@/lib/calendar-data";
import MonthView from "@/components/MonthView";

interface PageProps {
  searchParams: Promise<{ year?: string; month?: string }>;
}

export default async function MonthPage({ searchParams }: PageProps) {
  const { year: yearParam, month: monthParam } = await searchParams;
  const now = new Date();
  const year = yearParam ? parseInt(yearParam) : now.getUTCFullYear();
  const month = monthParam ? parseInt(monthParam) : now.getUTCMonth() + 1;

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const [journalEntries, events] = await Promise.all([
    getJournalEntriesForMonth(year, month),
    getEventsForRange(start, end),
  ]);

  return <MonthView year={year} month={month} journalEntries={journalEntries} events={events} />;
}
