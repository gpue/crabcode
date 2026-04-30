import { db } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/google-auth";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  location?: string;
  recurrence?: string[];
  htmlLink?: string;
  status?: string;
}

interface EventsResponse {
  items: GoogleEvent[];
  nextSyncToken?: string;
  nextPageToken?: string;
}

export async function syncGoogleCalendar(connectionId: string): Promise<number> {
  const conn = await db.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const accessToken = await getValidGoogleToken(connectionId);

  let url = `${CALENDAR_BASE}/calendars/primary/events?maxResults=2500&singleEvents=true`;
  if (conn.syncToken) {
    url += `&syncToken=${encodeURIComponent(conn.syncToken)}`;
  } else {
    // Initial sync: last 1 year + next 1 year
    const timeMin = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    url += `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&orderBy=startTime`;
  }

  let totalSynced = 0;
  let nextPageToken: string | undefined;
  let finalSyncToken: string | undefined;

  do {
    const pageUrl = nextPageToken ? `${url}&pageToken=${nextPageToken}` : url;
    const res = await fetch(pageUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 410) {
      // Sync token expired — reset and do full sync
      await db.oAuthConnection.update({ where: { id: connectionId }, data: { syncToken: null } });
      return syncGoogleCalendar(connectionId);
    }

    if (!res.ok) throw new Error(`Google Calendar API error: ${await res.text()}`);

    const data: EventsResponse = await res.json();
    finalSyncToken = data.nextSyncToken;
    nextPageToken = data.nextPageToken;

    for (const event of data.items ?? []) {
      if (event.status === "cancelled") {
        await db.calendarEvent.deleteMany({
          where: { externalId: event.id, source: "google" },
        });
        continue;
      }

      const allDay = !event.start.dateTime;
      const startTime = new Date(event.start.dateTime ?? event.start.date ?? "");
      const endTime = new Date(event.end?.dateTime ?? event.end?.date ?? "");

      await db.calendarEvent.upsert({
        where: { externalId_source: { externalId: event.id, source: "google" } },
        create: {
          externalId: event.id,
          source: "google",
          title: event.summary ?? "(no title)",
          description: event.description,
          startTime,
          endTime,
          allDay,
          location: event.location,
          recurrence: event.recurrence?.join("\n"),
          url: event.htmlLink,
        },
        update: {
          title: event.summary ?? "(no title)",
          description: event.description,
          startTime,
          endTime,
          allDay,
          location: event.location,
          recurrence: event.recurrence?.join("\n"),
          url: event.htmlLink,
        },
      });
      totalSynced++;
    }
  } while (nextPageToken);

  if (finalSyncToken) {
    await db.oAuthConnection.update({
      where: { id: connectionId },
      data: { syncToken: finalSyncToken },
    });
  }

  return totalSynced;
}
