import { getJournalEntry } from "@/lib/journal-data";
import { getEventsForDay } from "@/lib/calendar-data";
import { getMediaForDay } from "@/lib/media-data";
import { db } from "@/lib/db";
import DayView from "@/components/DayView";

interface PageProps {
  searchParams: Promise<{ date?: string }>;
}

export default async function DayPage({ searchParams }: PageProps) {
  const { date: dateParam } = await searchParams;
  const date = dateParam ?? new Date().toISOString().split("T")[0];

  const [journalEntry, events, media, locations] = await Promise.all([
    getJournalEntry(date),
    getEventsForDay(date),
    getMediaForDay(date),
    db.location.findMany({
      where: {
        date: {
          gte: new Date(date + "T00:00:00.000Z"),
          lte: new Date(date + "T23:59:59.999Z"),
        },
      },
    }),
  ]);

  return (
    <DayView
      date={date}
      journalEntry={journalEntry}
      events={events}
      media={media}
      locations={locations}
    />
  );
}
