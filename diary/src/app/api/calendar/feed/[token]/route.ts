import { NextRequest, NextResponse } from "next/server";
import { generateICS } from "@/lib/ics-feed";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const ics = await generateICS(token);

  if (!ics) {
    return NextResponse.json({ error: "Invalid or inactive token" }, { status: 404 });
  }

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="diary.ics"',
      "Cache-Control": "no-cache",
    },
  });
}
