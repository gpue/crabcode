import { db } from "@/lib/db";
import IcalGenerator from "ical-generator";
import { randomBytes } from "crypto";

export async function createFeedToken(label: string, calendarFilter?: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.feedToken.create({
    data: { token, label, calendarFilter },
  });
  return token;
}

export async function revokeFeedToken(id: string): Promise<void> {
  await db.feedToken.update({
    where: { id },
    data: { active: false },
  });
}

export async function generateICS(token: string): Promise<string | null> {
  const feedToken = await db.feedToken.findUnique({
    where: { token, active: true },
  });
  if (!feedToken) return null;

  // Update last accessed
  await db.feedToken.update({
    where: { token },
    data: { lastAccessedAt: new Date() },
  });

  let where: Record<string, unknown> = {};
  if (feedToken.calendarFilter) {
    try {
      where = JSON.parse(feedToken.calendarFilter);
    } catch {
      // ignore invalid filter
    }
  }

  const events = await db.calendarEvent.findMany({ where });

  const cal = IcalGenerator({
    name: "Diary Calendar Feed",
    prodId: { company: "diary-app", product: "diary" },
  });

  for (const event of events) {
    cal.createEvent({
      id: event.id,
      summary: event.title,
      description: event.description ?? undefined,
      start: event.startTime,
      end: event.endTime,
      allDay: event.allDay,
      location: event.location ?? undefined,
      url: event.url ?? undefined,
    });
  }

  return cal.toString();
}
