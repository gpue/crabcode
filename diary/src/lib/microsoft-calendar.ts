import { db } from "@/lib/db";
import { getValidMicrosoftToken } from "@/lib/microsoft-auth";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  webLink?: string;
  recurrence?: unknown;
}

interface GraphEventsResponse {
  value: GraphEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export async function syncMicrosoftCalendar(connectionId: string): Promise<number> {
  const conn = await db.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const accessToken = await getValidMicrosoftToken(connectionId);

  let url: string;
  if (conn.deltaLink) {
    url = conn.deltaLink;
  } else {
    const startDateTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const endDateTime = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    url = `${GRAPH_BASE}/me/calendarView/delta?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$top=100`;
  }

  let totalSynced = 0;
  let finalDeltaLink: string | undefined;

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!res.ok) {
      if (res.status === 410) {
        // Delta link expired — reset
        await db.oAuthConnection.update({ where: { id: connectionId }, data: { deltaLink: null } });
        return syncMicrosoftCalendar(connectionId);
      }
      throw new Error(`Microsoft Graph API error: ${await res.text()}`);
    }

    const data: GraphEventsResponse = await res.json();

    for (const event of data.value ?? []) {
      // Check if it's a deleted event (has @removed property)
      if ("@removed" in event) {
        await db.calendarEvent.deleteMany({
          where: { externalId: event.id, source: "microsoft" },
        });
        continue;
      }

      const startTime = new Date(event.start.dateTime);
      const endTime = new Date(event.end.dateTime);

      await db.calendarEvent.upsert({
        where: { externalId_source: { externalId: event.id, source: "microsoft" } },
        create: {
          externalId: event.id,
          source: "microsoft",
          title: event.subject ?? "(no title)",
          description: event.bodyPreview,
          startTime,
          endTime,
          allDay: event.isAllDay ?? false,
          location: event.location?.displayName,
          recurrence: event.recurrence ? JSON.stringify(event.recurrence) : null,
          url: event.webLink,
        },
        update: {
          title: event.subject ?? "(no title)",
          description: event.bodyPreview,
          startTime,
          endTime,
          allDay: event.isAllDay ?? false,
          location: event.location?.displayName,
          recurrence: event.recurrence ? JSON.stringify(event.recurrence) : null,
          url: event.webLink,
        },
      });
      totalSynced++;
    }

    finalDeltaLink = data["@odata.deltaLink"];
    url = data["@odata.nextLink"] ?? "";
  }

  if (finalDeltaLink) {
    await db.oAuthConnection.update({
      where: { id: connectionId },
      data: { deltaLink: finalDeltaLink },
    });
  }

  return totalSynced;
}
