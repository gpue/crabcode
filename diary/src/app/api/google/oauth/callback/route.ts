import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode, getGoogleUserEmail } from "@/lib/google-auth";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/dashboard/settings?error=${error ?? "no_code"}`, process.env.NEXT_PUBLIC_APP_URL)
    );
  }

  try {
    const tokens = await exchangeGoogleCode(code);
    const email = await getGoogleUserEmail(tokens.access_token);

    await db.oAuthConnection.upsert({
      where: { provider_email: { provider: "google", email } },
      create: {
        provider: "google",
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scopes: tokens.scope.split(" "),
      },
      update: {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scopes: tokens.scope.split(" "),
      },
    });

    return NextResponse.redirect(
      new URL("/dashboard/settings?connected=google", process.env.NEXT_PUBLIC_APP_URL)
    );
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=google_oauth_failed", process.env.NEXT_PUBLIC_APP_URL)
    );
  }
}
