import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createFeedToken, revokeFeedToken } from "@/lib/ics-feed";

// GET /api/calendar/tokens — list all feed tokens
export const GET = withAuth(async (_req: NextRequest) => {
  const tokens = await db.feedToken.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(tokens);
});

// POST /api/calendar/tokens — create a new feed token
export const POST = withAuth(async (req: NextRequest) => {
  const { label, calendarFilter } = await req.json();
  const token = await createFeedToken(label, calendarFilter);
  return NextResponse.json({ token });
});

// DELETE /api/calendar/tokens — revoke a token
export const DELETE = withAuth(async (req: NextRequest) => {
  const { id } = await req.json();
  await revokeFeedToken(id);
  return NextResponse.json({ ok: true });
});
