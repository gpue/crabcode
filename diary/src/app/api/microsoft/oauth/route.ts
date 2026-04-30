import { NextResponse } from "next/server";
import { buildMicrosoftAuthUrl } from "@/lib/microsoft-auth";
import { withAuth } from "@/lib/auth";
import { NextRequest } from "next/server";

export const GET = withAuth(async (_req: NextRequest) => {
  const url = buildMicrosoftAuthUrl();
  return NextResponse.redirect(url);
});
