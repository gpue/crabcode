import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import {
  getAllLocations,
  createLocation,
  deleteLocation,
  updateLocation,
  LocationCreateSchema,
  importGoogleTimeline,
} from "@/lib/location-data";

export const GET = withAuth(async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (start && end) {
    const { getLocationsForRange } = await import("@/lib/location-data");
    const locations = await getLocationsForRange(new Date(start), new Date(end));
    return NextResponse.json(locations);
  }

  const locations = await getAllLocations();
  return NextResponse.json(locations);
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();

  // Check if it's a timeline import
  if (body.type === "timeline_import") {
    const count = await importGoogleTimeline(body.data);
    return NextResponse.json({ imported: count });
  }

  const parsed = LocationCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const location = await createLocation(parsed.data);
  return NextResponse.json(location);
});

export const PATCH = withAuth(async (req: NextRequest) => {
  const { id, ...data } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const location = await updateLocation(id, data);
  return NextResponse.json(location);
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteLocation(id);
  return NextResponse.json({ ok: true });
});
