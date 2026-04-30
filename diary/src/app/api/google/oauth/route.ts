import { NextResponse } from "next/server";
import { buildGoogleAuthUrl } from "@/lib/google-auth";
import { withAuth } from "@/lib/auth";
import { NextRequest } from "next/server";

export const GET = withAuth(async (_req: NextRequest) => {
  const url = buildGoogleAuthUrl();
  return NextResponse.redirect(url);
});
