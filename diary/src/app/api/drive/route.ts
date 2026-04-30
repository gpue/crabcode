import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { syncGoogleDrive } from "@/lib/google-photos";
import { db } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest) => {
  const { folderIds } = (await req.json().catch(() => ({}))) as { folderIds?: string[] };

  const conn = await db.oAuthConnection.findFirst({ where: { provider: "google" } });
  if (!conn) {
    return NextResponse.json({ error: "No Google connection found" }, { status: 404 });
  }

  try {
    const count = await syncGoogleDrive(conn.id, folderIds ?? []);
    return NextResponse.json({ synced: count });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
});
