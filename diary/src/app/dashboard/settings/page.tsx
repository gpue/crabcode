import { db } from "@/lib/db";
import SettingsPage from "@/components/SettingsPage";

export default async function Settings() {
  const [connections, feedTokens] = await Promise.all([
    db.oAuthConnection.findMany({ orderBy: { provider: "asc" } }),
    db.feedToken.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const safeConnections = connections.map((c) => ({
    id: c.id,
    provider: c.provider,
    email: c.email,
    scopes: c.scopes,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    syncToken: !!c.syncToken,
    deltaLink: !!c.deltaLink,
  }));

  return <SettingsPage connections={safeConnections} feedTokens={feedTokens} />;
}
