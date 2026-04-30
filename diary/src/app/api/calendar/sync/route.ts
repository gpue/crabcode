import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { syncGoogleCalendar } from "@/lib/google-calendar";
import { syncMicrosoftCalendar } from "@/lib/microsoft-calendar";
import { db } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest) => {
  const { provider } = await req.json();

  const connections = await db.oAuthConnection.findMany({
    where: provider ? { provider } : undefined,
  });

  if (connections.length === 0) {
    return NextResponse.json({ error: "No OAuth connections found" }, { status: 404 });
  }

  const results: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const conn of connections) {
    try {
      let count = 0;
      if (conn.provider === "google") {
        count = await syncGoogleCalendar(conn.id);
      } else if (conn.provider === "microsoft") {
        count = await syncMicrosoftCalendar(conn.id);
      }
      results[`${conn.provider}:${conn.email}`] = count;
    } catch (err) {
      errors[`${conn.provider}:${conn.email}`] = String(err);
    }
  }

  return NextResponse.json({ results, errors });
});
