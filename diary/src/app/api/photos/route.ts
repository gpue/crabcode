import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { syncGooglePhotos, syncGoogleDrive } from "@/lib/google-photos";
import { db } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest) => {
  const { source, folderIds } = await req.json() as { source?: string; folderIds?: string[] };

  const conn = await db.oAuthConnection.findFirst({ where: { provider: "google" } });
  if (!conn) {
    return NextResponse.json({ error: "No Google connection found" }, { status: 404 });
  }

  let count = 0;
  const errors: string[] = [];

  if (!source || source === "photos") {
    try {
      count += await syncGooglePhotos(conn.id);
    } catch (err) {
      errors.push(`Photos: ${String(err)}`);
    }
  }

  if (!source || source === "drive") {
    try {
      count += await syncGoogleDrive(conn.id, folderIds ?? []);
    } catch (err) {
      errors.push(`Drive: ${String(err)}`);
    }
  }

  return NextResponse.json({ synced: count, errors });
});
