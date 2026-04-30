import { db } from "@/lib/db";
import { z } from "zod";

export const LocationCreateSchema = z.object({
  label: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["past", "future"]),
  source: z.enum(["manual", "timeline", "exif", "calendar"]).default("manual"),
  notes: z.string().optional(),
});

export type LocationCreate = z.infer<typeof LocationCreateSchema>;

export async function getAllLocations() {
  return db.location.findMany({ orderBy: { date: "desc" } });
}

export async function getLocationsForRange(start: Date, end: Date) {
  return db.location.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });
}

export async function createLocation(data: LocationCreate) {
  return db.location.create({
    data: {
      ...data,
      date: new Date(data.date + "T00:00:00.000Z"),
    },
  });
}

export async function deleteLocation(id: string) {
  return db.location.delete({ where: { id } });
}

export async function updateLocation(id: string, data: Partial<LocationCreate>) {
  return db.location.update({
    where: { id },
    data: {
      ...data,
      ...(data.date ? { date: new Date(data.date + "T00:00:00.000Z") } : {}),
    },
  });
}

/**
 * Import Google Maps Timeline JSON (from Google Takeout)
 * Format: { locations: [{ latitudeE7, longitudeE7, timestampMs }] }
 */
export async function importGoogleTimeline(json: unknown): Promise<number> {
  const data = json as { locations?: Array<{ latitudeE7?: number; longitudeE7?: number; timestampMs?: string }> };
  const locations = data.locations ?? [];
  let imported = 0;

  for (const loc of locations) {
    if (!loc.latitudeE7 || !loc.longitudeE7 || !loc.timestampMs) continue;
    const lat = loc.latitudeE7 / 1e7;
    const lng = loc.longitudeE7 / 1e7;
    const date = new Date(parseInt(loc.timestampMs));

    await db.location.create({
      data: {
        label: `Timeline: ${date.toISOString().split("T")[0]}`,
        lat,
        lng,
        date,
        type: "past",
        source: "timeline",
      },
    });
    imported++;
  }

  return imported;
}
