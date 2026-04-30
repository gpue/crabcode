import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { importGoogleTimeline } from "@/lib/location-data";

/**
 * POST /api/timeline
 * Body: { data: <Google Takeout Timeline JSON> }
 * Supports both legacy format ({ locations: [{ latitudeE7, longitudeE7, timestampMs }] })
 * and the semantic format (passed through to importGoogleTimeline which handles both).
 */
export const POST = withAuth(async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = body as { data?: unknown };
  if (!payload.data) {
    return NextResponse.json({ error: "Missing `data` field" }, { status: 400 });
  }

  try {
    const count = await importGoogleTimeline(payload.data);
    return NextResponse.json({ imported: count });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
});
