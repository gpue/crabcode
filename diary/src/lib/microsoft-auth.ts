/**
 * Microsoft OAuth2 helpers (raw fetch)
 */

const MICROSOFT_AUTH_BASE = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID ?? "common"}`;
const TOKEN_URL = `${MICROSOFT_AUTH_BASE}/oauth2/v2.0/token`;
const AUTH_URL = `${MICROSOFT_AUTH_BASE}/oauth2/v2.0/authorize`;

export const MICROSOFT_SCOPES = [
  "Calendars.Read",
  "offline_access",
  "User.Read",
];

export function buildMicrosoftAuthUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID!,
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI!,
    response_type: "code",
    scope: MICROSOFT_SCOPES.join(" "),
    response_mode: "query",
    ...(state ? { state } : {}),
  });
  return `${AUTH_URL}?${params}`;
}

export interface MicrosoftTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      redirect_uri: process.env.MICROSOFT_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token exchange failed: ${await res.text()}`);
  return res.json();
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<MicrosoftTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${await res.text()}`);
  return res.json();
}

export async function getMicrosoftUserEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Microsoft user info");
  const data = await res.json();
  return data.mail ?? data.userPrincipalName as string;
}

export async function getValidMicrosoftToken(connectionId: string): Promise<string> {
  const { db } = await import("@/lib/db");
  const conn = await db.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } });

  if (conn.expiresAt && conn.expiresAt > new Date(Date.now() + 60_000)) {
    return conn.accessToken;
  }

  if (!conn.refreshToken) throw new Error("No refresh token available");
  const tokens = await refreshMicrosoftToken(conn.refreshToken);
  await db.oAuthConnection.update({
    where: { id: connectionId },
    data: {
      accessToken: tokens.access_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
  return tokens.access_token;
}
