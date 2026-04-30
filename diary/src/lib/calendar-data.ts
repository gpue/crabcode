import { db } from "@/lib/db";

export async function getEventsForDay(date: string) {
  const start = new Date(date + "T00:00:00.000Z");
  const end = new Date(date + "T23:59:59.999Z");
  return db.calendarEvent.findMany({
    where: {
      OR: [
        { startTime: { gte: start, lte: end } },
        { endTime: { gte: start, lte: end } },
        { startTime: { lte: start }, endTime: { gte: end } },
      ],
    },
    orderBy: { startTime: "asc" },
  });
}

export async function getEventsForRange(start: Date, end: Date) {
  return db.calendarEvent.findMany({
    where: {
      OR: [
        { startTime: { gte: start, lte: end } },
        { endTime: { gte: start, lte: end } },
        { startTime: { lte: start }, endTime: { gte: end } },
      ],
    },
    orderBy: { startTime: "asc" },
  });
}
