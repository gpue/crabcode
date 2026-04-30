import { db } from "@/lib/db";

export async function getMediaForDay(date: string) {
  const start = new Date(date + "T00:00:00.000Z");
  const end = new Date(date + "T23:59:59.999Z");
  return db.mediaItem.findMany({
    where: { takenAt: { gte: start, lte: end } },
    orderBy: { takenAt: "asc" },
  });
}

export async function getAllMedia(page = 1, pageSize = 50) {
  const skip = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    db.mediaItem.findMany({
      orderBy: { takenAt: "desc" },
      skip,
      take: pageSize,
    }),
    db.mediaItem.count(),
  ]);
  return { items, total, page, pageSize };
}
