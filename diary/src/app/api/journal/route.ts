import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getJournalEntry, upsertJournalEntry } from "@/lib/journal-data";

// GET /api/journal?date=YYYY-MM-DD
export const GET = withAuth(async (req: NextRequest) => {
  const date = req.nextUrl.searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const entry = await getJournalEntry(date);
  return NextResponse.json(entry ?? { date, content: "" });
});

// PUT /api/journal — upsert
export const PUT = withAuth(async (req: NextRequest) => {
  const { date, content } = await req.json();
  if (!date || content === undefined) {
    return NextResponse.json({ error: "date and content required" }, { status: 400 });
  }
  const entry = await upsertJournalEntry(date, content);
  return NextResponse.json(entry);
});
