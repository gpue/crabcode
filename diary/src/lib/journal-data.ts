import { db } from "@/lib/db";

export async function getJournalEntry(date: string) {
  const d = new Date(date + "T00:00:00.000Z");
  return db.journalEntry.findUnique({ where: { date: d } });
}

export async function upsertJournalEntry(date: string, content: string) {
  const d = new Date(date + "T00:00:00.000Z");
  return db.journalEntry.upsert({
    where: { date: d },
    create: { date: d, content },
    update: { content },
  });
}

export async function getJournalEntriesForMonth(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return db.journalEntry.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });
}

export async function getJournalEntriesForWeek(startDate: string) {
  const start = new Date(startDate + "T00:00:00.000Z");
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return db.journalEntry.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });
}
