import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session.authenticated) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col p-4 gap-1">
        <a href="/dashboard/day" className="px-3 py-2 rounded hover:bg-gray-800 text-sm">
          Today
        </a>
        <a href="/dashboard/week" className="px-3 py-2 rounded hover:bg-gray-800 text-sm">
          Week
        </a>
        <a href="/dashboard/month" className="px-3 py-2 rounded hover:bg-gray-800 text-sm">
          Month
        </a>
        <a href="/dashboard/map" className="px-3 py-2 rounded hover:bg-gray-800 text-sm">
          World Map
        </a>
        <a href="/dashboard/photos" className="px-3 py-2 rounded hover:bg-gray-800 text-sm">
          Photos
        </a>
        <div className="flex-1" />
        <a href="/dashboard/settings" className="px-3 py-2 rounded hover:bg-gray-800 text-sm text-gray-400">
          Settings
        </a>
      </nav>
      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
